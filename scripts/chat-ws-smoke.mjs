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
//   # --gate-test: the whole PIN gate (PR3) against a live channel, driven by
//   # the REAL browser derivation loaded out of src/ui/chatcrypto.js. Creates
//   # the channel, admits the right PIN, refuses the wrong one, then proves the
//   # lockout by having a KNOWN-GOOD PIN refused after 5 misses. Use a fresh
//   # channel name — it leaves that channel locked for 60 s.
//   node scripts/chat-ws-smoke.mjs wss://…/chat/<fresh-name>/ws --gate-test
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
    gateTest: false,
    e2eTest: false,
    pin: "Correct-Horse-9!",
  };
  // Flags that take a value must CONSUME it. Without the `i += 1` the value
  // fell through to the positional branch on the next pass and overwrote the
  // nick — harmless-looking, but it means a run reports a nick nobody asked
  // for, and `--expect-close 4003 somenick` would silently ignore the nick.
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--send") out.send = argv[(i += 1)];
    else if (a === "--expect") out.expect = argv[(i += 1)];
    else if (a === "--raw") out.raw = argv[(i += 1)];
    else if (a === "--expect-error") out.expectError = argv[(i += 1)];
    else if (a === "--expect-close") out.expectClose = parseInt(argv[(i += 1)], 10);
    else if (a === "--nojoin") out.nojoin = true;
    else if (a === "--send-now") out.sendNow = true;
    else if (a === "--delay-now") out.delayNow = parseInt(argv[(i += 1)], 10) || 0;
    else if (a === "--cap-test") out.capTest = parseInt(argv[(i += 1)], 10) || 65;
    else if (a === "--pair") out.pair = true;
    else if (a === "--gate-test") out.gateTest = true;
    else if (a === "--e2e-test") out.e2eTest = true;
    else if (a === "--pin") out.pin = argv[(i += 1)];
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

// Gate test (PR3). Drives the whole D7/D8/D9 gate against the LIVE object,
// using the real browser derivation from src/ui/chatcrypto.js — the artifact
// the user actually runs, not a re-implementation that could agree with the
// server while the browser disagrees.
//
// Sequence, in one process so the channel object stays resident throughout
// (the gate lives in memory and dies with the last member — D4):
//   1. A creates the channel with setgate  → ready
//   2. B answers the challenge correctly   → ready, and A sees B join
//   3. A speaks, B hears it                → gated channel still relays
//   4. C answers with the WRONG PIN        → close 4003
//   5. four more wrong answers (5 total)   → lockout armed (D8)
//   6. a CORRECT-PIN client is now refused → close 4003, lockout proven
//
// Step 6 is the whole point: 4003 alone proves nothing about the lockout,
// because a wrong PIN closes 4003 too. Only a known-good PIN being refused
// distinguishes "locked" from "wrong", and the uniform close code is exactly
// what makes those indistinguishable to an attacker (D8).
async function gateTest(a) {
  const { createContext, runInContext } = await import("node:vm");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sandbox = { window: {}, crypto, TextEncoder, console };
  createContext(sandbox);
  runInContext(await readFile(join(root, "src/ui/chatcrypto.js"), "utf8"), sandbox);
  const talvi = sandbox.window.talviGate;

  // /chat/<name>/ws → <name>. The name is the KDF salt, so it must match what
  // the browser would use for this URL exactly.
  const name = new URL(a.url).pathname.replace(/^\/chat\//, "").replace(/\/ws$/, "");
  const goodGate = await talvi.gateHex(await talvi.deriveMasterHex(a.pin, name), name);
  const badGate = await talvi.gateHex(
    await talvi.deriveMasterHex(a.pin + "-wrong", name),
    name,
  );

  const failures = [];
  const held = [];

  // Opens a socket, answers any challenge with `gate`, and resolves with what
  // happened: "ready" | "closed:<code>" | "error:<code>".
  function attempt(nick, gate, opts = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(a.url);
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        if (opts.hold && r === "ready") held.push(ws);
        else ws.close();
        resolve(r);
      };
      const timer = setTimeout(() => done("timeout"), 15000);
      ws.addEventListener("open", () => {
        const frame = { t: "join", nick };
        if (opts.setgate) frame.setgate = gate;
        ws.send(JSON.stringify(frame));
      });
      ws.addEventListener("message", async (event) => {
        let f;
        try {
          f = JSON.parse(event.data);
        } catch {
          return;
        }
        if (f.t === "challenge") {
          const answer = await talvi.answerHex(gate, f.nonce);
          ws.send(JSON.stringify({ t: "join", nick, gate: answer }));
          return;
        }
        if (f.t === "ready") {
          clearTimeout(timer);
          if (opts.onReady) opts.onReady(ws);
          done("ready");
        }
        if (f.t === "error") {
          clearTimeout(timer);
          done("error:" + f.code);
        }
      });
      ws.addEventListener("close", (e) => {
        clearTimeout(timer);
        done("closed:" + e.code);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        done("error:socket");
      });
    });
  }

  function expect(label, actual, want) {
    const ok = actual === want;
    console.log(`[gate] ${ok ? "pass" : "FAIL"}  ${label} → ${actual}`);
    if (!ok) failures.push(`${label}: got ${actual}, want ${want}`);
  }

  // 1. create
  let heardFromA = null;
  const rA = await attempt("gate-a", goodGate, {
    setgate: true,
    hold: true,
    onReady: (ws) =>
      ws.addEventListener("message", (ev) => {
        try {
          const f = JSON.parse(ev.data);
          if (f.t === "msg") heardFromA = f.d;
        } catch {
          /* ignore */
        }
      }),
  });
  expect("creator sets gate", rA, "ready");

  // 2. correct PIN joins. Sends `setgate` too, because the real browser sends
  // it on every join it has a key for — the server must IGNORE it on an
  // already-gated channel and challenge instead. Testing the shape the
  // artifact actually emits is the point; a hand-tuned frame would pass while
  // the browser failed.
  let bSocket = null;
  const rB = await attempt("gate-b", goodGate, {
    setgate: true,
    hold: true,
    onReady: (ws) => {
      bSocket = ws;
      ws.addEventListener("message", (ev) => {
        try {
          const f = JSON.parse(ev.data);
          if (f.t === "msg") heardFromA = f.d;
        } catch {
          /* ignore */
        }
      });
    },
  });
  expect("correct PIN admitted", rB, "ready");

  // 3. gated channel still relays
  if (bSocket) {
    held[0]?.send(JSON.stringify({ t: "msg", d: "gated-hello" }));
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect("gated channel relays", heardFromA, "gated-hello");

  // 4. wrong PIN refused
  const rC = await attempt("gate-c", badGate);
  expect("wrong PIN refused 4003", rC, "closed:4003");

  // 5. four more wrong answers arms the lockout (5 total, D8)
  for (let i = 0; i < 4; i += 1) {
    await attempt("gate-x" + i, badGate);
  }

  // 6. correct PIN is now refused too — that is the lockout, not the PIN
  const rLocked = await attempt("gate-good-but-locked", goodGate);
  expect("correct PIN refused while locked out", rLocked, "closed:4003");

  for (const ws of held) ws.close();

  if (failures.length) {
    console.error("\n[gate] FAILED:\n  " + failures.join("\n  "));
    process.exit(3);
  }
  console.log("\n[gate] all gate assertions passed");
  process.exit(0);
}

// E2E test (PR4). Two members of a gated channel, same PIN, using the REAL
// browser crypto from src/ui/chatcrypto.js, against the LIVE object.
//
// The assertion that matters is not "B could read A" — that only shows the
// crypto round-trips, which the offline tests already prove. It is what the
// WIRE carried: the exact bytes the server relayed are captured and checked to
// contain no trace of the plaintext. That is the "network panel shows only
// envelopes" check from the blueprint, made exact instead of visual.
//
// Note on the blueprint's third-tab-with-wrong-PIN case: since PR3 a wrong PIN
// cannot get into the channel at all — the gate closes it at 4003 before any
// traffic flows (verified by --gate-test). So "receives ciphertext it cannot
// decrypt" is no longer reachable from inside the room, and the meaningful
// version of that check is the one below, against the relay itself.
async function e2eTest(a) {
  const { createContext, runInContext } = await import("node:vm");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sandbox = { window: {}, crypto, TextEncoder, TextDecoder, btoa, atob, console };
  createContext(sandbox);
  runInContext(await readFile(join(root, "src/ui/chatcrypto.js"), "utf8"), sandbox);
  const talvi = sandbox.window.talviGate;

  const name = new URL(a.url).pathname.replace(/^\/chat\//, "").replace(/\/ws$/, "");
  const master = await talvi.deriveMasterHex(a.pin, name);
  const gateHex = await talvi.gateHex(master, name);
  const key = await talvi.encKey(master, name);

  const SECRET = "the ice is thin by the north pier at 0300";
  const failures = [];
  const expect = (label, ok, detail) => {
    console.log(`[e2e] ${ok ? "pass" : "FAIL"}  ${label}${detail ? " → " + detail : ""}`);
    if (!ok) failures.push(label);
  };

  function member(nick, onRaw) {
    return new Promise((resolve) => {
      const ws = new WebSocket(a.url);
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        resolve({ ws, result: r });
      };
      const timer = setTimeout(() => done("timeout"), 15000);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ t: "join", nick, setgate: gateHex })),
      );
      ws.addEventListener("message", async (event) => {
        if (onRaw) onRaw(String(event.data));
        let f;
        try {
          f = JSON.parse(event.data);
        } catch {
          return;
        }
        if (f.t === "challenge") {
          ws.send(
            JSON.stringify({ t: "join", nick, gate: await talvi.answerHex(gateHex, f.nonce) }),
          );
          return;
        }
        if (f.t === "ready") {
          clearTimeout(timer);
          done("ready");
        }
        if (f.t === "error") {
          clearTimeout(timer);
          done("error:" + f.code);
        }
      });
      ws.addEventListener("close", (e) => {
        clearTimeout(timer);
        done("closed:" + e.code);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        done("error:socket");
      });
    });
  }

  const A = await member("e2e-a");
  expect("A creates the gated channel", A.result === "ready", A.result);

  const wire = []; // every raw frame the server sent to B
  const B = await member("e2e-b", (raw) => wire.push(raw));
  expect("B joins with the same PIN", B.result === "ready", B.result);

  // A speaks, sealed.
  A.ws.send(JSON.stringify({ t: "msg", env: await talvi.seal(key, SECRET) }));
  await new Promise((r) => setTimeout(r, 2500));

  const msgFrames = wire
    .map((raw) => {
      try {
        return { raw, f: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.f.t === "msg");

  expect("B received a message frame", msgFrames.length > 0, String(msgFrames.length));

  if (msgFrames.length) {
    const { raw, f } = msgFrames[0];
    expect("relayed frame carries an envelope", f.env !== undefined);
    expect("relayed frame carries NO plaintext field", f.d === undefined);
    // The whole point: the plaintext is nowhere in what crossed the wire.
    expect("plaintext absent from the wire bytes", !raw.includes(SECRET));
    expect("wire bytes are not merely obfuscated", !raw.includes(SECRET.slice(0, 12)));
    const opened = await talvi.unseal(key, f.env);
    expect("B decrypts it to exactly what A sent", opened === SECRET);

    // And a member who lacks the PIN gets nothing readable out of it, even
    // holding the raw envelope.
    const wrongKey = await talvi.encKey(
      await talvi.deriveMasterHex(a.pin + "-wrong", name),
      name,
    );
    expect("wrong PIN cannot open the captured envelope",
      (await talvi.unseal(wrongKey, f.env)) === null);
  }

  // The relay refuses plaintext on a gated channel — no silent downgrade.
  const before = wire.filter((r) => r.includes('"t":"msg"')).length;
  A.ws.send(JSON.stringify({ t: "msg", d: "PLAINTEXT-SHOULD-NOT-RELAY" }));
  await new Promise((r) => setTimeout(r, 2500));
  const after = wire.filter((r) => r.includes('"t":"msg"')).length;
  expect("server refuses to relay plaintext on a gated channel", after === before,
    `${before} → ${after}`);
  expect("plaintext never reached B", !wire.some((r) => r.includes("PLAINTEXT-SHOULD-NOT-RELAY")));

  A.ws.close();
  B.ws.close();

  if (failures.length) {
    console.error("\n[e2e] FAILED:\n  " + failures.join("\n  "));
    process.exit(3);
  }
  console.log("\n[e2e] all E2E assertions passed");
  process.exit(0);
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
      "[--raw json] [--expect-error code] [--expect-close code] [--cap-test N] [--pair] " +
      "[--gate-test | --e2e-test [--pin <pin>]]",
  );
  process.exit(2);
}

if (a.e2eTest) {
  await e2eTest(a);
} else if (a.gateTest) {
  await gateTest(a);
} else if (a.pair) {
  await pairTest(a);
} else if (a.capTest > 0) {
  await capTest(a.url, a.capTest);
} else {
  await runSingle(a);
}
