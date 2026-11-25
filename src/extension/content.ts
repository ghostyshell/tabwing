/**
 * Tabwing - page agent (isolated world content script).
 *
 * Injected on demand by the service worker. Exposes a tiny RPC surface:
 *   snapshot / click / type / key / scroll / hover / select / wait / find /
 *   text / links / query / viewport
 *
 * Refs ([12]) are written onto elements as data-bb-ref and are only valid
 * until the next snapshot or navigation.
 */

import type { Envelope, PageParams, SnapshotElement, SnapshotResult } from '../shared/types';

declare global {
  interface Window {
    __bbInstalled?: boolean;
  }
}

(() => {
  if (window.__bbInstalled) return;
  window.__bbInstalled = true;

  const REF = 'data-bb-ref';
  const MAX_ELEMENTS = 500;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const collapse = (s: unknown): string => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s: unknown, n: number): string => {
    const t = collapse(s);
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const CANDIDATES = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'details',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="treeitem"]',
    '[role="row"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'img[alt]',
    'label',
  ].join(',');

  type El = HTMLElement & { readonly type?: string; readonly value?: string; readonly checked?: boolean };

  /* ---------------------------------------------------------------- */
  /* element inspection                                               */
  /* ---------------------------------------------------------------- */

  function isVisible(el: Element | null): boolean {
    if (!el || !el.isConnected) return false;
    // aria-hidden is only advisory: apps like Search Console mark their whole
    // rendered body aria-hidden while a dialog is open. Geometry and computed
    // style decide; aria-hidden alone does not disqualify an element.
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return true;
  }

  function labelText(el: El): string {
    const aria = el.getAttribute('aria-labelledby');
    if (aria) {
      const txt = aria
        .split(/\s+/)
        .map((id) => collapse(document.getElementById(id)?.innerText))
        .filter(Boolean)
        .join(' ');
      if (txt) return txt;
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return collapse((lbl as HTMLElement).innerText);
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el) return collapse((wrapping as HTMLElement).innerText);
    return '';
  }

  function nameOf(el: El): string {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria && collapse(aria)) return clip(aria, 120);
    const labelled = labelText(el);
    if (labelled) return clip(labelled, 120);
    if (tag === 'img') return clip(el.getAttribute('alt'), 120);
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type)) return clip(el.value, 120);
      if (type === 'image') return clip(el.getAttribute('alt') || el.value, 120);
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 120);
    }
    const txt = collapse(el.innerText || el.textContent);
    if (txt) return clip(txt, 120);
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '', 120);
  }

  function roleOf(el: El): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'button') return 'button';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return `heading${tag[1]}`;
    if (tag === 'img') return 'image';
    if (tag === 'select') return (el as unknown as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'label') return 'label';
    if (tag === 'details') return 'disclosure';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      const map: Record<string, string> = {
        checkbox: 'checkbox',
        radio: 'radio',
        submit: 'button',
        button: 'button',
        reset: 'button',
        image: 'button',
        file: 'file',
        range: 'slider',
        color: 'color',
        hidden: 'hidden',
      };
      return map[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button';
    return tag;
  }

  function isInteresting(el: El, role: string): boolean {
    if (role === 'hidden') return false;
    if (role === 'label') return false;
    if (role.startsWith('heading') || role === 'image') return !!nameOf(el);
    if (el.matches('input,select,textarea,[contenteditable=""],[contenteditable="true"]')) return true;
    return !!nameOf(el) || role === 'button' || role === 'link';
  }

  function stateOf(el: El): string[] {
    const bits: string[] = [];
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (tag === 'input' || role === 'checkbox' || role === 'switch') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch') {
        const on = el.checked ?? el.getAttribute('aria-checked') === 'true';
        bits.push(on ? 'checked' : 'unchecked');
      }
    }
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') bits.push('required');
    if (el.getAttribute('aria-expanded')) bits.push(`aria-expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-pressed')) bits.push(`pressed=${el.getAttribute('aria-pressed')}`);
    if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if ((el as HTMLInputElement).readOnly) bits.push('readonly');
    return bits;
  }

  function valueOf(el: El): string {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const opts = [...(el as unknown as HTMLSelectElement).selectedOptions].map((o) => collapse(o.textContent));
      return opts.join(' / ');
    }
    if (tag === 'input' && (el.type || '').toLowerCase() === 'checkbox') return '';
    if (tag === 'input' || tag === 'textarea') return clip(el.value, 160);
    if (el.isContentEditable) return clip(el.innerText, 160);
    return '';
  }

  function hrefOf(el: El): string {
    if (el.tagName.toLowerCase() !== 'a') return '';
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:')) return '';
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  /* ---------------------------------------------------------------- */
  /* snapshot                                                         */
  /* ---------------------------------------------------------------- */

  function snapshot(p: PageParams = {}): SnapshotResult {
    const maxEls = Math.min(Number(p.maxElements) || 300, MAX_ELEMENTS);
    const includeText = p.text !== false;
    const textLimit = Math.min(Number(p.textLength) || 2000, 20_000);

    document.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));

    const seen = new Set<Element>();
    const elements: SnapshotElement[] = [];
    let ref = 0;

    for (const node of document.querySelectorAll(CANDIDATES)) {
      if (ref >= maxEls) break;
      if (seen.has(node)) continue;
      seen.add(node);
      const el = node as El;
      const role = roleOf(el);
      if (!isInteresting(el, role)) continue;
      if (!isVisible(el)) continue;

      const id = String(ref++);
      el.setAttribute(REF, id);
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;

      elements.push({
        ref: Number(id),
        role,
        name: nameOf(el),
        value: valueOf(el),
        href: hrefOf(el),
        state: stateOf(el),
        inViewport: inView,
        tag: el.tagName.toLowerCase(),
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }

    const lines = elements.map((e) => {
      const parts = [`[${e.ref}]`, e.role, JSON.stringify(e.name || '')];
      if (e.value) parts.push(`value=${JSON.stringify(e.value)}`);
      if (e.href) parts.push(`href=${e.href}`);
      if (e.state.length) parts.push(e.state.join(' '));
      if (!e.inViewport) parts.push('(offscreen)');
      return parts.join(' ');
    });

    const scrollable = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const pct = scrollable ? Math.round((scrollY / scrollable) * 100) : 0;

    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        scrollY: Math.round(scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        scrollPct: pct,
      },
      summary: {
        links: document.querySelectorAll('a[href]').length,
        inputs: document.querySelectorAll('input,textarea,select,[contenteditable="true"]').length,
        forms: document.forms.length,
        iframes: document.querySelectorAll('iframe').length,
        images: document.images.length,
        truncated: ref >= maxEls,
      },
      elements,
      lines,
      text: includeText ? clip(document.body?.innerText || '', textLimit) : '',
    };
  }

  /* ---------------------------------------------------------------- */
  /* element lookup                                                   */
  /* ---------------------------------------------------------------- */

  /** Every element in the document, shadow roots included: several sites
   *  (Reddit's login among them) keep their real inputs behind a web
   *  component, where document.querySelector sees nothing. */
  function deepAll(): El[] {
    const out: El[] = [];
    const walk = (node: Document | ShadowRoot | Element) => {
      const kids = node.querySelectorAll ? Array.from(node.querySelectorAll('*')) : [];
      for (const el of kids) {
        out.push(el as El);
        if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
          walk((el as Element & { shadowRoot: ShadowRoot }).shadowRoot);
        }
      }
    };
    walk(document);
    return out;
  }

  function find(p: PageParams = {}): El {
    if (p.ref !== undefined && p.ref !== null && p.ref !== '') {
      const el = deepAll().find((c) => c.getAttribute(REF) === String(p.ref));
      if (!el) {
        throw new Error(`Element [${p.ref}] is gone (page changed since the snapshot). Take a fresh snapshot.`);
      }
      return el;
    }
    if (p.selector) {
      const list = deepAll().filter((el) => el.matches(p.selector!));
      if (!list.length) throw new Error(`No element matches selector "${p.selector}"`);
      const el = list[Number(p.index) || 0];
      if (!el) throw new Error(`Selector "${p.selector}" matched ${list.length} elements; index out of range`);
      return el;
    }
    if (p.text) {
      const needle = collapse(p.text).toLowerCase();
      // Interactive candidates beat headings on an exact match, so "Log In"
      // picks the submit button rather than the page title.
      const groups = [
        'a,button,[role="button"],[role="link"]',
        'label,span,li,h1,h2,h3,h4',
      ];
      const all = deepAll();
      let partial: El | null = null;
      for (const group of groups) {
        for (const el of all) {
          if (!el.matches(group)) continue;
          const text = collapse(el.innerText).toLowerCase();
          if (text === needle) return el;
          if (!partial && text.includes(needle)) partial = el;
        }
      }
      if (partial) return partial;
      throw new Error(`No clickable element whose text contains "${p.text}"`);
    }
    throw new Error('Provide a ref (from a snapshot), a selector, or text.');
  }

  function describeEl(el: El): { role: string; name: string; tag: string } {
    return { role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase() };
  }

  /* ---------------------------------------------------------------- */
  /* actions                                                          */
  /* ---------------------------------------------------------------- */

  async function click(p: PageParams = {}) {
    const el = find(p);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    await overlay.point(x, y, r);
    overlay.press();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      detail: 1,
    };
    const beforeUrl = location.href;

    if (p.clickOnly) {
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
      await sleep(p.waitMs ?? 300);
      return {
        clicked: describeEl(el),
        url: location.href,
        navigated: location.href !== beforeUrl,
        title: document.title,
      };
    }

    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    } catch (e) {
      // Some elements reject synthetic pointer events; fall back to .click().
      if (typeof el.click === 'function') el.click();
      else throw e;
    }
    await sleep(p.waitMs ?? 300);
    return {
      clicked: describeEl(el),
      url: location.href,
      navigated: location.href !== beforeUrl,
      title: document.title,
    };
  }

  async function hover(p: PageParams = {}) {
    const el = find(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(50);
    const r = el.getBoundingClientRect();
    await overlay.point(r.left + r.width / 2, r.top + r.height / 2, r);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
    };
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }));
    await sleep(200);
    return { hovered: describeEl(el) };
  }

  function isField(el: El): el is HTMLInputElement | HTMLTextAreaElement {
    return el.matches('input,textarea');
  }

  async function type(p: PageParams = {}) {
    const el = find(p);
    const text = String(p.text ?? '');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await aim(el);
    if (typeof el.focus === 'function') el.focus();
    await sleep(30);

    const field = isField(el);
    if (p.clear !== false) {
      if (field && typeof el.select === 'function') {
        el.select();
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }

    if (p.slow) {
      // Per-character input, for autocomplete / typeahead widgets.
      for (const ch of text) {
        if (!document.execCommand('insertText', false, ch)) {
          if (field) el.value = (el.value || '') + ch;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        }
        await sleep(Number(p.slow) || 60);
      }
    } else {
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        if (field) {
          const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
        } else if (el.isContentEditable) {
          el.textContent = text;
        } else {
          (el as El & { value: string }).value = text;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);

    let submitted = false;
    if (p.submit) submitted = await submitEl(el);

    return {
      typed: describeEl(el),
      value: field ? clip(el.value, 300) : clip(el.innerText, 300),
      submitted,
      url: location.href,
    };
  }

  async function submitEl(el: El): Promise<boolean> {
    const form = (el as HTMLInputElement).form || el.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        await sleep(200);
        return true;
      }
      form.submit();
      await sleep(200);
      return true;
    }
    const target: El = el || (document.activeElement as El) || (document.body as El);
    const ev = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    target.dispatchEvent(new KeyboardEvent('keydown', ev));
    target.dispatchEvent(new KeyboardEvent('keypress', ev));
    target.dispatchEvent(new KeyboardEvent('keyup', ev));
    await sleep(200);
    return false;
  }

  const KEY_CODES: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Esc: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
    Space: 32,
  };

  function focusables(): El[] {
    return [
      ...document.querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]',
      ),
    ].filter((el) => !(el as HTMLButtonElement).disabled && isVisible(el)) as El[];
  }

  async function key(p: PageParams = {}) {
    const combo = String(p.keys || p.key || '');
    if (!combo) throw new Error('Provide keys, e.g. "Enter", "Escape", "Meta+a", "Shift+Tab".');
    const parts = combo.split('+').map((s) => s.trim());
    const rawKey = parts.pop() || '';
    const keyName = rawKey === 'Space' ? ' ' : rawKey;
    const mods = new Set(parts.map((s) => s.toLowerCase()));
    const charCode = keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0;
    const ev = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      keyCode: KEY_CODES[keyName] || charCode,
      which: KEY_CODES[keyName] || charCode,
      altKey: mods.has('alt'),
      ctrlKey: mods.has('ctrl') || mods.has('control'),
      metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
      shiftKey: mods.has('shift'),
    };
    const mod = ev.ctrlKey || ev.metaKey;

    const el: El =
      p.ref !== undefined || p.selector ? find(p) : ((document.activeElement as El) || (document.body as El));
    if (typeof el.focus === 'function') el.focus();

    // Synthetic events cannot trigger native browser shortcuts, so cover the
    // ones an agent actually needs.
    if (mod && keyName.toLowerCase() === 'a') {
      if (el.matches?.('input,textarea')) (el as HTMLInputElement).select();
      else document.execCommand('selectAll', false, undefined);
      return { key: combo, handled: 'select-all' };
    }
    if (keyName === 'Tab') {
      const list = focusables();
      const i = list.indexOf(document.activeElement as El);
      const next = list[(i + (ev.shiftKey ? -1 : 1) + list.length) % list.length];
      if (next) next.focus();
      return { key: combo, handled: 'focus', focused: describeEl((document.activeElement as El) || el) };
    }
    if (keyName === 'Enter') {
      const submitted = await submitEl(el);
      el.dispatchEvent(new KeyboardEvent('keydown', ev));
      el.dispatchEvent(new KeyboardEvent('keypress', ev));
      el.dispatchEvent(new KeyboardEvent('keyup', ev));
      return { key: combo, handled: 'enter', submitted, url: location.href };
    }
    if (keyName === 'Escape') {
      el.dispatchEvent(new KeyboardEvent('keydown', ev));
      el.dispatchEvent(new KeyboardEvent('keyup', ev));
      try {
        el.blur();
      } catch {
        /* not focusable */
      }
      return { key: combo, handled: 'escape' };
    }

    el.dispatchEvent(new KeyboardEvent('keydown', ev));
    el.dispatchEvent(new KeyboardEvent('keypress', ev));
    el.dispatchEvent(new KeyboardEvent('keyup', ev));
    await sleep(120);
    return { key: combo };
  }

  async function scroll(p: PageParams = {}) {
    const mode = String(p.direction || 'down');
    if (p.ref !== undefined && p.ref !== '') {
      const el = find(p);
      el.scrollIntoView({ block: p.block || 'center', behavior: 'instant' });
    } else if (mode === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (mode === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    } else if (mode === 'up') {
      window.scrollBy({ top: -Math.round(innerHeight * (p.amount || 0.85)), behavior: 'instant' });
    } else {
      window.scrollBy({ top: Math.round(innerHeight * (p.amount || 0.85)), behavior: 'instant' });
    }
    await sleep(150);
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return {
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      atBottom: scrollY >= max - 4,
      atTop: scrollY <= 4,
      pct: max ? Math.round((scrollY / max) * 100) : 100,
    };
  }

  async function select(p: PageParams = {}) {
    const el = find(p);
    if (el.tagName.toLowerCase() !== 'select') throw new Error('Target is not a <select> element');
    await aim(el);
    const sel = el as unknown as HTMLSelectElement;
    const wanted = new Set(
      (Array.isArray(p.values) ? p.values : [p.value]).flat().map((v) => collapse(v).toLowerCase()),
    );
    const picked: string[] = [];
    for (const opt of sel.options) {
      const matches = wanted.has(collapse(opt.value).toLowerCase()) || wanted.has(collapse(opt.textContent).toLowerCase());
      if (matches) {
        opt.selected = true;
        picked.push(collapse(opt.textContent));
      } else if (!sel.multiple) {
        opt.selected = false;
      }
    }
    if (!picked.length) {
      const available = [...sel.options].slice(0, 25).map((o) => collapse(o.textContent));
      throw new Error(`No option matched. Options: ${available.join(' | ')}`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    return { selected: picked };
  }

  async function wait(p: PageParams = {}) {
    const timeout = Math.min(Number(p.timeout) || 10_000, 25_000);
    const start = Date.now();
    const interval = 120;
    while (Date.now() - start < timeout) {
      if (p.selector) {
        const el = document.querySelector(p.selector);
        if (p.gone ? !el : el) return { found: !p.gone, selector: p.selector, ms: Date.now() - start };
      }
      if (p.text) {
        const has = collapse(document.body?.innerText || '')
          .toLowerCase()
          .includes(collapse(p.text).toLowerCase());
        if (p.gone ? !has : has) return { found: !p.gone, text: p.text, ms: Date.now() - start };
      }
      if (p.url) {
        const has = location.href.includes(p.url);
        if (p.gone ? !has : has) return { found: !p.gone, url: location.href, ms: Date.now() - start };
      }
      if (p.idle && document.readyState === 'complete') {
        return { found: true, idle: true, ms: Date.now() - start };
      }
      await sleep(interval);
    }
    return { found: false, timedOut: true, ms: Date.now() - start, url: location.href, title: document.title };
  }

  function findText(p: PageParams = {}) {
    const q = collapse(p.query || p.text || '').toLowerCase();
    if (!q) throw new Error('Provide query text');
    const limit = Math.min(Number(p.limit) || 10, 50);
    const matches: Array<{ context: string; ref: number | null; tag: string }> = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && matches.length < limit) {
      const raw = node.nodeValue || '';
      const idx = raw.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;
      const before = collapse(raw.slice(Math.max(0, idx - 60), idx));
      const after = collapse(raw.slice(idx + q.length, idx + q.length + 60));
      const refEl = parent.closest(`[${REF}]`);
      matches.push({
        context: `${before}[${raw.slice(idx, idx + q.length)}]${after}`,
        ref: refEl ? Number(refEl.getAttribute(REF)) : null,
        tag: parent.tagName.toLowerCase(),
      });
    }
    return { query: p.query, count: matches.length, matches };
  }

  function text(p: PageParams = {}) {
    const limit = Math.min(Number(p.limit) || 8000, 60_000);
    return { url: location.href, title: document.title, text: clip(document.body?.innerText || '', limit) };
  }

  function links(p: PageParams = {}) {
    const limit = Math.min(Number(p.limit) || 150, 1000);
    const seen = new Set<string>();
    const out: Array<{ url: string; text: string }> = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (out.length >= limit) break;
      if (!isVisible(a)) continue;
      const href = hrefOf(a as El);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ url: href, text: clip((a as HTMLElement).innerText || a.getAttribute('aria-label') || '', 100) });
    }
    return { url: location.href, links: out };
  }

  /** Structured alternative to eval on sites whose CSP blocks it. */
  function query(p: PageParams = {}) {
    if (!p.selector) throw new Error('query needs a selector');
    const limit = Math.min(Number(p.limit) || 40, 500);
    const attrNames = Array.isArray(p.attrs)
      ? p.attrs
      : ['id', 'class', 'name', 'type', 'role', 'aria-label', 'href', 'data-testid'];
    const nodes = [...document.querySelectorAll(p.selector)];
    const items = nodes.slice(0, limit).map((node) => {
      const el = node as El;
      const attrs: Record<string, string> = {};
      for (const name of attrNames) {
        const v = el.getAttribute(name);
        if (v != null) attrs[name] = clip(v, 120);
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: clip(el.innerText || el.value || el.getAttribute('aria-label') || '', 160),
        href: hrefOf(el),
        value: el.matches('input,textarea,select') ? clip(el.value, 120) : undefined,
        visible: isVisible(el),
        attrs,
      };
    });
    return { selector: p.selector, count: nodes.length, returned: items.length, items };
  }

  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement.scrollHeight,
    };
  }

  /* ---------------------------------------------------------------- */
  /* driving overlay                                                  */
  /* ---------------------------------------------------------------- */

  // What the user sees while an agent drives this tab: an amber glow around
  // the viewport, and a cursor that glides to each element before it is used.
  // It sits in a closed shadow root on <html>, so page CSS, body text and
  // snapshots never see it; it ignores the pointer; and it hides for
  // screenshots so the agent never sees it either.
  type Box = { left: number; top: number; width: number; height: number };

  const overlay = (() => {
    const GLIDE_MS = 320;
    /** Same as the worker's debugger idle: the glow fades after that much quiet. */
    const LINGER_MS = 20_000;
    const BOX_MS = 1400;
    const AMBER = '245, 158, 11';
    const EDGE = '217, 119, 6';
    const CSS = `
      .frame { position: fixed; inset: 0; opacity: 0; transition: opacity .35s ease;
        box-shadow: inset 0 0 0 2px rgba(${EDGE}, .9), inset 0 0 28px 6px rgba(${AMBER}, .38); }
      /* The pulse fades a second, softer layer in and out: opacity runs on the
         compositor, a viewport-wide box-shadow animation would repaint every frame. */
      .frame::after { content: ''; position: absolute; inset: 0; opacity: 0;
        box-shadow: inset 0 0 44px 12px rgba(${AMBER}, .22); }
      :host([data-driving="on"]) .frame { opacity: 1; }
      :host([data-driving="on"]) .frame::after { animation: breathe 2.4s ease-in-out infinite; }
      @keyframes breathe { 50% { opacity: 1; } }
      .box { position: fixed; border-radius: 6px; opacity: 0; transition: opacity .2s ease;
        border: 2px solid rgba(${EDGE}, .95); background: rgba(${AMBER}, .12); box-shadow: 0 0 0 4px rgba(${AMBER}, .18); }
      .box.show { opacity: 1; }
      .cursor { position: fixed; left: 0; top: 0; opacity: 0; transform: translate(var(--x), var(--y));
        transition: transform ${GLIDE_MS}ms cubic-bezier(.2, .7, .2, 1), opacity .25s ease; }
      :host([data-driving="on"]) .cursor { opacity: 1; }
      .halo { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%;
        background: radial-gradient(circle, rgba(${AMBER}, .5) 0, rgba(${AMBER}, .2) 45%, rgba(${AMBER}, 0) 70%); }
      .cursor svg { position: absolute; left: -2px; top: -2px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .35)); }
      .ripple { position: fixed; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
        border: 2px solid rgba(${EDGE}, .9); animation: ripple .5s ease-out forwards; }
      @keyframes ripple {
        from { transform: translate(var(--x), var(--y)) scale(.3); opacity: 1; }
        to { transform: translate(var(--x), var(--y)) scale(1.6); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) {
        .cursor { transition: opacity .25s ease; }
        :host([data-driving="on"]) .frame::after { animation: none; }
      }
      @media print { :host { display: none !important; } }`;

    const XHTML = 'http://www.w3.org/1999/xhtml';
    const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Background tabs paint nothing and throttle timers to a second or more, so
    // only a tab the user is looking at waits for the glide or draws a ripple.
    const watched = (): boolean => document.visibilityState === 'visible';

    let host: HTMLElement | null = null;
    let root!: ShadowRoot;
    let box!: HTMLElement;
    let cursor!: HTMLElement;
    let at = { x: innerWidth / 2, y: innerHeight / 2 };
    /** Screenshots in flight: two overlapping captures must both see it hidden. */
    let hides = 0;
    let linger: ReturnType<typeof setTimeout> | undefined;
    let boxTimer: ReturnType<typeof setTimeout> | undefined;
    let unhide: ReturnType<typeof setTimeout> | undefined;

    function el(cls: string, parent: Node): HTMLElement {
      const d = document.createElement('div');
      d.className = cls;
      parent.appendChild(d);
      return d;
    }

    function place(x: number, y: number): void {
      at = { x, y };
      cursor.style.setProperty('--x', `${x}px`);
      cursor.style.setProperty('--y', `${y}px`);
      host!.dataset.x = String(Math.round(x));
      host!.dataset.y = String(Math.round(y));
    }

    /** False where there is nothing to draw on: XML feeds, SVG files, sitemaps. */
    function mount(): boolean {
      const doc = document.documentElement;
      if (!doc || doc.namespaceURI !== XHTML) return false;
      if (!host) {
        const h = document.createElement('tabwing-overlay');
        h.setAttribute('aria-hidden', 'true');
        h.style.cssText =
          'all:initial;position:fixed;inset:0;pointer-events:none!important;z-index:2147483647;contain:strict;';
        // DOM building only (no innerHTML) and a constructed sheet: Trusted
        // Types and a strict style-src cannot block either.
        root = h.attachShadow({ mode: 'closed' });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        el('frame', root);
        box = el('box', root);
        cursor = el('cursor', root);
        el('halo', cursor);
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '26');
        svg.setAttribute('viewBox', '0 0 20 26');
        const arrow = document.createElementNS(NS, 'path');
        arrow.setAttribute('d', 'M2 2 L2 21 L7 16.5 L10.5 24 L13.5 22.7 L10 15.3 L16.5 15.3 Z');
        arrow.setAttribute('fill', '#1c1917');
        arrow.setAttribute('stroke', '#fff');
        arrow.setAttribute('stroke-width', '1.6');
        arrow.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(arrow);
        cursor.appendChild(svg);
        host = h; // only once it is fully built
        place(at.x, at.y);
      }
      if (!host.isConnected) {
        // Pages that rebuild <html> (some hydration recoveries) drop the host:
        // put it back rather than trusting the first mount.
        doc.appendChild(host);
        void cursor.offsetWidth; // commit the start position so the first glide animates
      }
      host.style.display = hides > 0 ? 'none' : '';
      return true;
    }

    /** The agent is acting on this tab: glow on, and off again after a quiet spell. */
    function drive(): boolean {
      if (!mount()) return false;
      host!.dataset.driving = 'on';
      clearTimeout(linger);
      linger = setTimeout(() => {
        if (host) host.dataset.driving = 'off';
        box.classList.remove('show');
      }, LINGER_MS);
      return true;
    }

    /** Glide the cursor to a point (viewport px) and outline the element there. */
    async function point(x: number, y: number, target?: Box): Promise<void> {
      if (!drive()) return;
      if (target) {
        box.style.left = `${target.left - 3}px`;
        box.style.top = `${target.top - 3}px`;
        box.style.width = `${target.width + 6}px`;
        box.style.height = `${target.height + 6}px`;
        box.classList.add('show');
        clearTimeout(boxTimer);
        boxTimer = setTimeout(() => box.classList.remove('show'), BOX_MS);
      }
      const moved = Math.hypot(x - at.x, y - at.y) > 2;
      place(x, y);
      if (moved && watched() && !reduced() && hides === 0) await sleep(GLIDE_MS);
    }

    function press(): void {
      if (!drive() || !watched() || reduced() || hides > 0) return;
      const ring = el('ripple', root);
      ring.style.setProperty('--x', `${at.x}px`);
      ring.style.setProperty('--y', `${at.y}px`);
      setTimeout(() => ring.remove(), 700);
    }

    /** Out of the way for a screenshot. Restores itself if `show` never comes. */
    async function hide(): Promise<void> {
      hides += 1;
      if (host) host.style.display = 'none';
      clearTimeout(unhide);
      unhide = setTimeout(() => {
        hides = 0;
        if (host) host.style.display = '';
      }, 15_000);
      // captureVisibleTab reads the last painted frame, so a watched tab waits
      // for one paint without the overlay; a CDP capture renders on demand.
      if (host && watched()) {
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          sleep(120),
        ]);
      }
    }

    function show(): void {
      hides = Math.max(0, hides - 1);
      if (hides > 0) return;
      clearTimeout(unhide);
      if (host) host.style.display = '';
    }

    // Cosmetic all the way down: whatever the page does to us, an action that
    // calls in here must never fail because of the overlay.
    return {
      drive: (): void => {
        try {
          drive();
        } catch {
          /* cosmetic */
        }
      },
      point: (x: number, y: number, target?: Box): Promise<void> => point(x, y, target).catch(() => undefined),
      press: (): void => {
        try {
          press();
        } catch {
          /* cosmetic */
        }
      },
      hide: (): Promise<void> => hide().catch(() => undefined),
      show: (): void => {
        try {
          show();
        } catch {
          /* cosmetic */
        }
      },
    };
  })();

  /** Point the overlay cursor at an element the content script is about to use. */
  async function aim(el: Element): Promise<void> {
    const r = el.getBoundingClientRect();
    await overlay.point(r.left + r.width / 2, r.top + r.height / 2, r);
  }

  async function overlayAction(p: PageParams = {}) {
    switch (p.op) {
      case 'point':
        await overlay.point(Number(p.x), Number(p.y), p.box);
        break;
      case 'press':
        overlay.press();
        break;
      case 'hide':
        await overlay.hide();
        break;
      case 'show':
        overlay.show();
        break;
      default:
        overlay.drive();
    }
    return { overlay: p.op || 'drive' };
  }

  /* ---------------------------------------------------------------- */
  /* rpc                                                              */
  /* ---------------------------------------------------------------- */

  const ACTIONS: Record<string, (p?: PageParams) => unknown> = {
    snapshot,
    click,
    hover,
    type,
    key,
    scroll,
    select,
    wait,
    find: findText,
    text,
    links,
    query,
    viewport,
    overlay: overlayAction,
  };

  chrome.runtime.onMessage.addListener((msg: Envelope, _sender, respond: (r: unknown) => void) => {
    if (!msg || msg.__bb !== 1) return;
    if (msg.action === 'ping') {
      respond({ ok: true, result: { pong: true, url: location.href } });
      return;
    }
    const fn = ACTIONS[msg.action];
    if (!fn) {
      respond({ ok: false, error: `Unknown page action "${msg.action}"` });
      return;
    }
    // Any agent call on this tab (a snapshot counts) means the agent is driving it.
    if (msg.action !== 'overlay' && msg.action !== 'viewport') overlay.drive();
    void (async () => {
      try {
        const result = await fn(msg.params || {});
        respond({ ok: true, result });
      } catch (e) {
        respond({ ok: false, error: e && (e as Error).message ? (e as Error).message : String(e) });
      }
    })();
    return true;
  });
})();
