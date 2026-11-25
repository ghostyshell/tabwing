#!/usr/bin/env bash
# End-to-end smoke test against a throwaway Chrome profile.
# Exercises: daemon, extension socket, permission gate, snapshot, click, type,
# select, wait, eval, screenshot, tab group lifecycle.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_PORT="${TABWING_TEST_CDP_PORT:-9333}"
FIXTURE_PORT="${TABWING_FIXTURE_PORT:-8899}"
PROFILE="${TABWING_TEST_PROFILE:-${TMPDIR:-/tmp}/tabwing-profile}"
CTL="$ROOT/bin/chromectl"
ORIGIN="http://127.0.0.1:$FIXTURE_PORT"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
check() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == *"$want"* ]]; then
    say "  ok    $name"
    PASS=$((PASS + 1))
  else
    say "  FAIL  $name"
    say "        expected to contain: $want"
    say "        got: $got"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  # The throwaway browser must not outlive the run: the daemon pins the first
  # connected client, so a leftover test Chrome silently takes every later
  # command (and reports its own empty permission storage).
  pkill -f "user-data-dir=${PROFILE}" 2>/dev/null
}
trap cleanup EXIT

say "1. fixture server on $ORIGIN"
python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 --directory "$ROOT/scripts" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1
check "fixture reachable" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/fixture.html")"

say "2. daemon + throwaway Chrome"
"$ROOT/install.sh" >/dev/null 2>&1 || { "$CTL" daemon start >/dev/null; }
# dev-chrome.sh reuses whatever already answers on the CDP port, and a throwaway
# browser left over from an older checkout runs stale extension code (Chrome
# keeps an unpacked MV3 service worker cached until the extension is reloaded),
# so the port is cleared and the default profile rebuilt from scratch every run.
pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null && sleep 1
[ -z "${TABWING_TEST_PROFILE:-}" ] && rm -rf "$PROFILE"
TABWING_TEST_PROFILE="$PROFILE" "$ROOT/scripts/dev-chrome.sh" >/dev/null || { say "could not launch test Chrome"; exit 1; }
sleep 2
check "extension connected" '"extensionConnected":true' "$(curl -s http://127.0.0.1:8737/health)"
# The real browser reconnects faster than the throwaway one starts, and the
# daemon answers to the first client that said hello: pin the test profile so
# nothing below ever touches the user's browser.
# The id comes from the folder, so the user's browser reports the same one. The
# per-profile clientId is what actually names the throwaway browser. Read it
# with a bounded retry: the worker writes it on its first connect.
TEST_CLIENT=""
for _ in $(seq 1 20); do
  TEST_CLIENT="$(node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" "chrome.storage.local.get('bbClientId').then(v=>v.bbClientId||'')")"
  [ -n "$TEST_CLIENT" ] && break
  sleep 0.25
done
TOKEN="$(cat "$HOME/.config/tabwing/token")"
NONCE="http://smoke-$$-$RANDOM.invalid"
# The pin lapses if the throwaway browser's socket drops (its worker restarts),
# and then the daemon falls back to the real browser: re-pin and re-prove it
# before anything that closes tabs. The proof is a nonce origin written into
# the test browser's storage (over CDP, so it cannot go anywhere else) that must
# come back through chromectl.
assert_test_browser() {
  PIN="$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8737/pin?clientId=$TEST_CLIENT")"
  check "test browser pinned ($1)" "\"clientId\":\"$TEST_CLIENT\"" "$PIN"
  node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
    "chrome.storage.local.get('allowedOrigins').then(v=>chrome.storage.local.set({allowedOrigins:[...new Set([...(v.allowedOrigins||[]),'$NONCE'])]})).then(()=>'set')" >/dev/null
  STATUS="$("$CTL" status 2>&1)"
  check "chromectl reaches the test browser ($1)" "$NONCE" "$STATUS"
  [[ "$STATUS" == *"$NONCE"* ]] || { say "refusing to run: chromectl is talking to a different browser than the test profile"; exit 1; }
}
assert_test_browser start

say "3. permission gate"
node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
  "chrome.storage.local.set({allowedOrigins:[],pendingOrigin:null,autoAllow:false}).then(()=>'reset')" >/dev/null
OUT="$("$CTL" open "$ORIGIN/fixture.html" 2>&1)"
check "blocked before approval" "origin_not_allowed" "$OUT"
node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
  "chrome.storage.local.set({allowedOrigins:['$ORIGIN'],pendingOrigin:null}).then(()=>'allowed')" >/dev/null
check "origin is approved" "$ORIGIN" "$(node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" "chrome.storage.local.get('allowedOrigins').then(v=>JSON.stringify(v.allowedOrigins))")"

say "4. page interaction"
assert_test_browser "before reset"
"$CTL" reset >/dev/null 2>&1
OUT="$("$CTL" open "$ORIGIN/fixture.html" 2>&1)"
check "tab opened in group" "opened tab" "$OUT"
OUT="$("$CTL" snapshot --no-text)"
check "snapshot finds heading" 'heading1 "Tabwing fixture"' "$OUT"
check "snapshot finds textbox" 'textbox "Your name"' "$OUT"
check "refs are numbered" '[0] heading1' "$OUT"

"$CTL" type 2 "Ada Lovelace" >/dev/null
"$CTL" select 3 Pro >/dev/null
"$CTL" click 4 >/dev/null
"$CTL" click 5 >/dev/null
check "form submitted" "hello Ada Lovelace (pro, agreed)" "$("$CTL" eval "document.getElementById('result').textContent")"

"$CTL" click 6 >/dev/null
OUT="$("$CTL" wait css=#later --timeout 5000 2>&1)"
check "async element appeared" "found after" "$OUT"

"$CTL" click 8 >/dev/null
"$CTL" click 8 >/dev/null
check "repeated clicks" "Clicked 2" "$("$CTL" eval "document.getElementById('counter').textContent")"

OUT="$("$CTL" screenshot 2>&1)"
SHOT="$(printf '%s\n' "$OUT" | head -1)"
check "screenshot written" ".png" "$SHOT"
NORM_H="$(printf '%s\n' "$OUT" | sed -n '2p' | sed -E 's/^[0-9]+x([0-9]+).*/\1/')"
if [ -f "$SHOT" ]; then
  say "  ok    screenshot file exists"
  PASS=$((PASS + 1))
else
  say "  FAIL  screenshot file missing: $SHOT"
  FAIL=$((FAIL + 1))
fi

"$CTL" eval "document.body.style.background='red'; 'painted'" >/dev/null
OUT="$("$CTL" screenshot 2>&1)"
SHOT2="$(printf '%s\n' "$OUT" | head -1)"
if [ -f "$SHOT" ] && [ -f "$SHOT2" ] && ! cmp -s "$SHOT" "$SHOT2"; then
  say "  ok    background-tab screenshot is live, not a stale frame"
  PASS=$((PASS + 1))
else
  say "  FAIL  background-tab screenshot did not change after the page did ($SHOT vs $SHOT2)"
  FAIL=$((FAIL + 1))
fi
check "screenshot did not borrow the tab" "" "$(printf '%s\n' "$OUT" | grep -c 'brought to front' | sed 's/^0$//')"

say "4b. full-page screenshot"
OUT="$("$CTL" screenshot --full 2>&1)"
FULL_H="$(printf '%s\n' "$OUT" | sed -n '2p' | sed -E 's/^[0-9]+x([0-9]+).*/\1/')"
if [ -n "$FULL_H" ] && [ -n "$NORM_H" ] && [ "$FULL_H" -gt "$NORM_H" ]; then
  say "  ok    --full reaches past the viewport (${FULL_H}px vs ${NORM_H}px)"
  PASS=$((PASS + 1))
else
  say "  FAIL  --full did not capture the whole page (full=${FULL_H:-?} viewport=${NORM_H:-?})"
  FAIL=$((FAIL + 1))
fi
check "full screenshot did not borrow the tab" "" "$(printf '%s\n' "$OUT" | grep -c 'brought to front' | sed 's/^0$//')"

say "4c. javascript dialogs in a background tab"
OUT="$("$CTL" click css=#confirm 2>&1)"
check "confirm() dismissed by default" "dismissed" "$OUT"
check "dismissed confirm() returned false" "kept" "$("$CTL" eval "document.getElementById('confirmed').textContent")"
"$CTL" dialog accept >/dev/null
OUT="$("$CTL" click css=#confirm 2>&1)"
check "armed dialog accepted" "Accepted a confirm" "$OUT"
check "accepted confirm() returned true" "deleted" "$("$CTL" eval "document.getElementById('confirmed').textContent")"
check "dialog state is inspectable" "last:" "$("$CTL" dialog status)"
"$CTL" dialog accept "Ada Lovelace" >/dev/null
OUT="$("$CTL" click css=#prompt 2>&1)"
check "prompt() answered with the armed text" "Ada Lovelace" "$("$CTL" eval "document.getElementById('prompted').textContent")"
check "prompt() reported" "Accepted a prompt" "$OUT"

say "4d. concurrent commands share one debugger attach"
# A brand new tab has no session yet, so all three commands race into the attach.
OPEN_OUT="$("$CTL" open "$ORIGIN/page2.html" 2>&1)"
NEWTAB="$(printf '%s\n' "$OPEN_OUT" | sed -n 's/^opened tab \([0-9][0-9]*\).*/\1/p')"
for n in 1 2 3; do "$CTL" key Tab --tab "$NEWTAB" >"$TMPDIR/bb-concurrent-$n.out" 2>&1 & PIDS[$n]=$!; done
wait "${PIDS[1]}" "${PIDS[2]}" "${PIDS[3]}"
CONCURRENT_FAIL=0
# page.key falls back to the content script on any CDP error; "(cdp)" proves
# every one of the three got a working debugger session.
for n in 1 2 3; do grep -q "sent Tab (cdp)" "$TMPDIR/bb-concurrent-$n.out" || CONCURRENT_FAIL=1; done
rm -f "$TMPDIR"/bb-concurrent-*.out
"$CTL" close --tab "$NEWTAB" >/dev/null 2>&1
if [ "$CONCURRENT_FAIL" -eq 0 ]; then
  say "  ok    three parallel commands shared one attach and all used CDP"
  PASS=$((PASS + 1))
else
  say "  FAIL  a parallel command lost the debugger attach race"
  FAIL=$((FAIL + 1))
fi

say "5. the user keeps their tab"
ACTIVE="$(node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" "chrome.tabs.query({active:true}).then(t=>t.map(x=>x.url).join())")"
check "open left the user's tab active" "about:blank" "$ACTIVE"
"$CTL" click css=#popout >/dev/null 2>&1
sleep 1
ACTIVE="$(node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" "chrome.tabs.query({active:true}).then(t=>t.map(x=>x.url).join())")"
check "target=_blank left the user's tab active" "about:blank" "$ACTIVE"
check "spawned tab joined the group" "page2.html" "$("$CTL" tabs)"
"$CTL" close --tab "$("$CTL" tabs | awk '/^tab / { id = $2 } /page2.html/ { print id; exit }')" >/dev/null 2>&1
check "spawned tab closed again" "" "$("$CTL" tabs | grep -c page2.html | sed 's/^0$//')"

say "5b. driving overlay"
assert_test_browser "before 5b"
# Pixel (0,0) of a PNG: row 0 has no row above and the pixel nothing to its
# left, so every PNG filter leaves its first three bytes as the raw RGB.
corner() {
  python3 - "$1" <<'PY'
import struct, sys, zlib
d = open(sys.argv[1], 'rb').read()
i, idat = 8, b''
while i < len(d):
    n, = struct.unpack('>I', d[i:i + 4])
    if d[i + 4:i + 8] == b'IDAT':
        idat += d[i + 8:i + 8 + n]
    i += 12 + n
raw = zlib.decompressobj().decompress(idat, 16)
print(','.join(str(b) for b in raw[1:4]))
PY
}
# A background tab runs no CSS transitions, so the glow would never show in a
# capture there and the screenshot check would prove nothing: watch the tab.
"$CTL" activate >/dev/null 2>&1
# White, because captures come back in the display's colour space (Display P3
# on a Mac) and only greys survive that conversion unchanged.
"$CTL" eval "document.documentElement.style.background='#fff'; document.body.style.background='#fff'; 'white'" >/dev/null
"$CTL" click css=#counter >/dev/null
OUT="$("$CTL" eval "(() => { const h = document.querySelector('tabwing-overlay'); if (!h) return 'no overlay'; const r = document.getElementById('counter').getBoundingClientRect(); const on = Math.abs(+h.dataset.x - (r.left + r.width / 2)) < 3 && Math.abs(+h.dataset.y - (r.top + r.height / 2)) < 3; return 'driving=' + h.dataset.driving + ' cursor-on-target=' + on + ' visible=' + document.visibilityState; })()")"
check "glow is on while the agent drives" "driving=on" "$OUT"
check "cursor glided to the clicked element" "cursor-on-target=true" "$OUT"
check "the overlay checks ran on a watched tab" "visible=visible" "$OUT"
check "snapshot never lists the overlay" "hits=0" "hits=$("$CTL" snapshot | grep -c tabwing-overlay)"
sleep 1 # the glow fades in over 350ms
OUT="$("$CTL" screenshot 2>&1)"
check "screenshot leaves the overlay out" "255,255,255" "$(corner "$(printf '%s\n' "$OUT" | head -1)")"
sleep 0.5
check "overlay is back after the screenshot" "shown" "$("$CTL" eval "document.querySelector('tabwing-overlay').style.display === 'none' ? 'hidden' : 'shown'")"
# A page that smooth-scrolls (Bootstrap 5 turns it on) must still get the
# press on the element, not where the element was before the scroll.
"$CTL" eval "(() => { document.documentElement.style.scrollBehavior = 'smooth'; const s = document.createElement('div'); s.style.height = '2500px'; const b = document.createElement('button'); b.id = 'far'; b.textContent = 'far'; b.onclick = () => { b.textContent = 'far hit'; }; document.body.append(s, b); scrollTo({ top: 0, behavior: 'instant' }); return 'ok'; })()" >/dev/null
"$CTL" click css=#far >/dev/null
check "click lands on a smooth-scroll page" "far hit" "$("$CTL" eval "document.getElementById('far').textContent")"
# The overlay cannot be drawn in an XML document; reading one must still work.
"$CTL" goto "$ORIGIN/feed.xml" >/dev/null
check "content actions still work on an XML page" "2 match(es) for item" "$("$CTL" query item 2>&1)"
"$CTL" goto "$ORIGIN/fixture.html" >/dev/null
"$CTL" snapshot >/dev/null # section 6 clicks ref 1 of a fresh snapshot
node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
  "chrome.tabs.query({}).then(t=>{const b=t.find(x=>x.url==='about:blank');return b?chrome.tabs.update(b.id,{active:true}).then(()=>'back'):'none'})" >/dev/null

say "6. navigation + ref expiry"
assert_test_browser "before 6"
"$CTL" click 1 >/dev/null 2>&1
"$CTL" wait url=/page2.html --timeout 5000 >/dev/null
sleep 0.5
check "navigated to page two" 'heading1 "Page two"' "$("$CTL" snapshot --no-text)"

say "6b. beforeunload does not block navigation"
"$CTL" goto "$ORIGIN/fixture.html" >/dev/null
"$CTL" click css=#guard >/dev/null
OUT="$("$CTL" goto "$ORIGIN/page2.html" --json 2>&1)"
check "navigation proceeded past beforeunload" "page2.html" "$OUT"
check "beforeunload dialog was reported" '"type": "beforeunload"' "$OUT"

say "7. group lifecycle"
assert_test_browser "before final reset"
"$CTL" reset >/dev/null
check "window survived reset" '"extensionConnected":true' "$(curl -s http://127.0.0.1:8737/health)"
check "no agent tabs left" "no agent tabs" "$("$CTL" tabs)"

say ""
say "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
