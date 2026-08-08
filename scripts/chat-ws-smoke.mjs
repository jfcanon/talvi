// Chat relay smoke client (PR1+). Uses Node's native WebSocket (>=22).
//
// Two-invocation relay test against the live Worker:
//
//   node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha ws/a --send "hello" --expect "pong"
//   node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha ws/b --send "pong" --expect "hello"
//
// Run both (e.g. in two terminals, or backgrounded). Each exits 0 when it has
// seen its --expect text, 2 on timeout, 3 if the socket closed without a match.
// Both exiting 0 proves bidirectional relay: A's "hello" reached B and B's
// "pong" reached A.
//
// No account, no auth, no PIN yet (PR1): this is the raw relay, exercised with
// the same client shape a real browser will use in a later PR.

const TIMEOUT_MS = 15000;

function parseArgv(argv) {
  const out = { url: null, nick: "anon", send: null, expect: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--send") out.send = argv[i + 1];
    else if (a === "--expect") out.expect = argv[i + 1];
    else if (out.url === null) out.url = a;
    else out.nick = a;
  }
  return out;
}

const { url, nick, send, expect } = parseArgv(process.argv.slice(2));
if (!url) {
  console.error("usage: node scripts/chat-ws-smoke.mjs <url> [nick] [--send text] [--expect text]");
  process.exit(2);
}

const ws = new WebSocket(url);
let sent = false;

const timer = setTimeout(() => {
  console.error(`[${nick}] TIMEOUT waiting for "${expect ?? "connection"}"`);
  ws.close();
  process.exit(2);
}, TIMEOUT_MS);

ws.addEventListener("open", () => {
  console.log(`[${nick}] open`);
  if (send && !sent) {
    sent = true;
    ws.send(send);
    console.log(`[${nick}] sent: ${send}`);
  }
});

ws.addEventListener("message", (event) => {
  const text = typeof event.data === "string" ? event.data : "<binary>";
  console.log(`[${nick}] recv: ${text}`);
  if (expect && text.includes(expect)) {
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("close", (event) => {
  console.log(`[${nick}] closed code=${event.code}`);
  clearTimeout(timer);
  // No --expect: closing cleanly is the pass condition (probe / uptime).
  // With --expect: the socket closed before the text arrived — relay failed.
  process.exit(expect ? 3 : 0);
});

ws.addEventListener("error", (event) => {
  console.error(`[${nick}] error: ${event.message ?? "websocket error"}`);
});
