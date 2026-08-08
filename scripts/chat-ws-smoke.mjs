// Chat smoke client (PR2+). Uses Node's native WebSocket (>=22).
//
// Speaks the blueprint §3 wire protocol: {t:"join", nick} then {t:"msg", d}.
// A channel's server is authoritative; this client just drives a real socket
// and asserts on the frames that come back.
//
//   # two-invocation relay test against the live Worker (PR2 protocol):
//   node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha/ws ws/a --send "hello" --expect "pong"
//   node scripts/chat-ws-smoke.mjs wss://talvi-web.ygdcbtmc4u.workers.dev/chat/alpha/ws ws/b --send "pong" --expect "hello"
//
//   # PR1 raw-relay verification (deployed before PR2's protocol landed): the
//   # server relayed plain strings, so no join/ready handshake. --nojoin sends
//   # no join frame, --send-now sends --send on open, and a raw (unparseable)
//   # string is matched against --expect directly.
//   node scripts/chat-ws-smoke.mjs wss://…/chat/alpha ws/a --nojoin --send-now --send "hello" --expect "pong"
//   node scripts/chat-ws-smoke.mjs wss://…/chat/alpha ws/b --nojoin --send-now --send "pong" --expect "hello"
//
//   # --pair: single-process bidirectional relay proof. Opens two sockets in
//   # ONE process, joins both, A sends "hello", B only replies "pong" after it
//   # has actually received "hello" — the test sequences the two directions
//   # itself, so no cross-process race can deadlock it (the two-invocation form
//   # kept failing on exit-before-delayed-send). Pass = A received "pong".
//   # PR2 protocol shape: join/ready handshake, then {t:"msg"} frames.
//   node scripts/chat-ws-smoke.mjs wss://…/chat/alpha/ws --pair
//
//   # oversize frame rejected with error "toolarge", socket stays open:
//   node scripts/chat-ws-smoke.mjs wss://…/chat/alpha ws/c --raw "$(node -e 'process.stdout.write(JSON.stringify({t:"msg",d:"x".repeat(5000)}))')" --expect-error toolarge
//
//   # cap: 65 connections join, the last must get error "full" + close 1013:
//   node scripts/chat-ws-smoke.mjs wss://…/chat/alpha cap --cap-test 65
//
// Exit: 0 = expected frame observed, 2 = timeout, 3 = socket closed without
// a match, 4 = connection-level error.

const TIMEOUT_MS = 20000;

function parseArgv(argv) {
  const out = {
    url: null,
    nick: "anon",
    send: null,
    expect: null,
    raw: null,
    expectError: null,
    expectClose: null,
    capTest: 0,
    nojoin: false,
    sendNow: false,
    delayNow: 0,
    pair: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--send") out.send = argv[i + 1];
    else if (a === "--expect") out.expect = argv[i + 1];
    else if (a === "--raw") out.raw = argv[i + 1];
    else if (a === "--expect-error") out.expectError = argv[i + 1];
    else if (a === "--expect-close") out.expectClose = argv[i + 1];
    else if (a === "--nojoin") out.nojoin = true;
    else if (a === "--send-now") out.sendNow = true;
    else if (a === "--delay-now") out.delayNow = parseInt(argv[i + 1], 10) || 0;
    else if (a === "--cap-test") out.capTest = parseInt(argv[i + 1], 10) || 65;
    else if (a === "--pair") out.pair = true;
    else if (out.url === null) out.url = a;
    else out.nick = a;
  }
  return out;
}

function fmt(obj) {
  return JSON.stringify(obj);
}

// Single-connection assertions (relay / oversize).
async function runSingle(a) {
  const ws = new WebSocket(a.url);
  const events = [];
  let sent = false;
  let done = false;

  const timer = setTimeout(() => {
    console.error(`[${a.nick}] TIMEOUT`);
    ws.close();
  }, TIMEOUT_MS);

  function finish(code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ws.close();
    process.exit(code);
  }

  ws.addEventListener("open", () => {
    if (!a.nojoin) ws.send(fmt({ t: "join", nick: a.nick }));
    // PR1 raw-relay mode: no ready handshake exists, so send straight away —
    // after --delay-now ms, so a two-invocation test can be sequenced (one
    // side connects first, then the other, then both transmit).
    if (a.sendNow && a.send !== null) {
      sent = true;
      const fire = () => {
        ws.send(a.send);
        console.log(`[${a.nick}] sent: ${a.send}`);
      };
      if (a.delayNow > 0) setTimeout(fire, a.delayNow);
      else fire();
    }
  });

  ws.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      frame = { t: "?", raw: event.data };
    }
    events.push(frame);

    if (frame.t === "?" && a.expect && a.sendNow) {
      // Raw relay: the other side's message is a plain string. Match against
      // the raw bytes, not a JSON field.
      console.log(`[${a.nick}] recv: ${event.data}`);
      if (String(event.data).includes(a.expect)) {
        console.log(`[${a.nick}] expected "${a.expect}" seen — pass`);
        finish(0);
      }
      return;
    }

    if (frame.t === "ready" && !sent) {
      sent = true;
      const roster = events
        .filter((f) => f.t === "join" && f.nick !== a.nick)
        .map((f) => "roster:" + f.nick);
      console.log(`[${a.nick}] ready` + (roster.length ? " " + roster.join(" ") : ""));
      if (a.raw !== null) {
        ws.send(a.raw);
        console.log(`[${a.nick}] sent raw frame`);
      } else if (a.send !== null) {
        ws.send(fmt({ t: "msg", d: a.send }));
        console.log(`[${a.nick}] sent: ${a.send}`);
      }
    }
    if (frame.t === "msg") {
      console.log(`[${a.nick}] recv ${frame.from}: ${frame.d}`);
      if (a.expect && String(frame.d).includes(a.expect)) {
        console.log(`[${a.nick}] expected "${a.expect}" seen — pass`);
        finish(0);
      }
    }
    if (frame.t === "error") {
      console.log(`[${a.nick}] error: ${frame.code}`);
      if (a.expectError === frame.code) {
        console.log(`[${a.nick}] expected error "${frame.code}" — pass`);
        finish(0);
      }
    }
    if (frame.t === "join" || frame.t === "leave") {
      console.log(`[${a.nick}] ${frame.t}: ${frame.nick}`);
    }
  });

  ws.addEventListener("close", (event) => {
    if (done) return;
    if (a.expectClose && event.code === a.expectClose) {
      console.log(`[${a.nick}] closed ${event.code} (expected) — pass`);
      finish(0);
    }
    console.error(`[${a.nick}] closed code=${event.code} without match`);
    process.exit(3);
  });

  ws.addEventListener("error", () => {
    console.error(`[${a.nick}] error`);
    process.exit(4);
  });
}

// Single-process bidirectional relay proof (PR2 protocol shape). Opens two
// sockets in one process; each sends {t:"join", nick} on open; when both have
// joined, A sends {t:"msg", d:"hello"} and B only sends {t:"msg", d:"pong"}
// after it has RECEIVED A's "hello". The sequencing lives inside the process,
// so the cross-process race that killed the two-invocation form (A exited on
// "pong" before its delayed send fired) cannot happen here. Pass = A received
// "pong" (proves A→B relay, since B only replies after hearing A).
async function pairTest(a) {
  const wsA = new WebSocket(a.url);
  const wsB = new WebSocket(a.url);
  let aReady = false;
  let bReady = false;
  let bHeardHello = false;
  let done = false;

  const timer = setTimeout(() => {
    console.error("[pair] TIMEOUT");
    finish(2);
  }, TIMEOUT_MS);

  function finish(code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      wsA.close();
    } catch {}
    try {
      wsB.close();
    } catch {}
    process.exit(code);
  }

  function maybeSend() {
    if (!aReady || !bReady || bHeardHello) return;
    // A leads; B will reply when it receives A's message.
    wsA.send(fmt({ t: "msg", d: "hello" }));
    console.log("[pair] A sent: hello");
  }

  function onFrame(ws, name, event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      console.error(`[pair] ${name} recv non-JSON: ${event.data}`);
      return;
    }
    console.log(`[pair] ${name} recv: ${JSON.stringify(frame)}`);
    if (frame.t === "ready") {
      if (ws === wsA) aReady = true;
      else bReady = true;
      maybeSend();
    }
    if (frame.t === "msg" && ws === wsB && !bHeardHello && frame.d === "hello") {
      bHeardHello = true;
      wsB.send(fmt({ t: "msg", d: "pong" }));
      console.log("[pair] B sent: pong");
    }
    if (frame.t === "msg" && ws === wsA && frame.d === "pong") {
      console.log("[pair] A saw pong — B relayed back, both directions proven — pass");
      finish(0);
    }
  }

  wsA.addEventListener("open", () => {
    wsA.send(fmt({ t: "join", nick: "pair-a" }));
  });
  wsB.addEventListener("open", () => {
    wsB.send(fmt({ t: "join", nick: "pair-b" }));
  });
  wsA.addEventListener("message", (event) => onFrame(wsA, "A", event));
  wsB.addEventListener("message", (event) => onFrame(wsB, "B", event));

  wsA.addEventListener("close", (event) => {
    console.error(`[pair] A closed code=${event.code} without match`);
    finish(3);
  });
  wsB.addEventListener("close", (event) => {
    console.error(`[pair] B closed code=${event.code} without match`);
    finish(3);
  });
  wsA.addEventListener("error", () => {
    console.error("[pair] A error");
    finish(4);
  });
  wsB.addEventListener("error", () => {
    console.error("[pair] B error");
    finish(4);
  });
}

// Cap test: `count` sockets join; the last must be refused with "full" + 1013.
async function capTest(url, count) {
  const sockets = [];
  let joined = 0;
  let refused = 0;
  let closed1013 = 0;

  for (let i = 0; i < count; i += 1) {
    const nick = "cap" + i;
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => ws.send(fmt({ t: "join", nick })));
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.t === "ready") joined += 1;
      if (frame.t === "error" && frame.code === "full") {
        refused += 1;
        console.log(`[${nick}] full → refusing`);
      }
    });
    ws.addEventListener("close", (event) => {
      if (event.code === 1013) closed1013 += 1;
    });
    ws.addEventListener("error", () => {});
    sockets.push(ws);
  }

  // Settle until the cap has plainly engaged or 15s is up.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(joined >= count - 1 && refused >= 1)) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const ok = joined >= count - 1 && refused >= 1 && closed1013 >= 1;
  console.log(
    `[cap] joined=${joined} refused=${refused} closed1013=${closed1013} ` +
      `(target: ${count - 1} joined, 1 refused + closed 1013)`,
  );
  for (const ws of sockets) ws.close();
  process.exit(ok ? 0 : 3);
}

const a = parseArgv(process.argv.slice(2));
if (!a.url) {
  console.error(
    "usage: node scripts/chat-ws-smoke.mjs <url> [nick] [--send text] [--expect text] " +
      "[--raw json] [--expect-error code] [--expect-close code] [--cap-test N] [--pair]",
  );
  process.exit(2);
}

if (a.pair) {
  await pairTest(a);
} else if (a.capTest > 0) {
  await capTest(a.url, a.capTest);
} else {
  await runSingle(a);
}
