// ChatChannel protocol tests (PR3). Run: node scripts/chat-channel-test.mjs
//
// Drives the REAL Durable Object class against a fake WebSocket, so the join
// and gate state machine can be tested without deploying. That matters more
// than it sounds: this project cannot run Terraform locally, so "push and see"
// costs a PR, a plan, an apply, and a live channel — and a gate bug that only
// shows up there is a bug that shipped.
//
// The regression this file exists for: the server used to answer a gate-less
// join by issuing a FRESH nonce, even when that socket already had one
// outstanding. The client's correct answer to the first nonce then compared
// against the replacement, failed, and counted against the lockout — so every
// honest join to a gated channel failed, and five of them locked the channel
// with no attacker involved. See "re-challenge must not invalidate" below.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { ChatChannel } from "../src/chat/channel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
  }
}

// Let the object's awaited WebCrypto work settle. join() is async, so every
// assertion about its outcome has to come after a real turn of the loop.
function settle() {
  return new Promise((r) => setTimeout(r, 20));
}

class MockWS {
  constructor() {
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
  }
  accept() {}
  send(text) {
    if (this.closed) throw new Error("send after close");
    this.sent.push(JSON.parse(text));
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.fire("close", { code, reason });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  recv(obj) {
    this.fire("message", { data: JSON.stringify(obj) });
  }
  all(t) {
    return this.sent.filter((f) => f.t === t);
  }
  first(t) {
    return this.sent.find((f) => f.t === t);
  }
  has(t) {
    return this.sent.some((f) => f.t === t);
  }
}

// Real browser derivation, so the test speaks exactly what the client speaks.
// The browser globals chatcrypto.js legitimately uses. The sandbox is not a
// browser, so they have to be handed in explicitly; btoa/atob/TextDecoder
// are all natively present wherever this file actually ships.
const sandbox = { window: {}, crypto, TextEncoder, TextDecoder, btoa, atob, console };
createContext(sandbox);
runInContext(await readFile(join(root, "src/ui/chatcrypto.js"), "utf8"), sandbox);
const talvi = sandbox.window.talviGate;

const NAME = "test-room";
const PIN = "Correct-Horse-9!";
const GATE = await talvi.gateHex(await talvi.deriveMasterHex(PIN, NAME), NAME);
const WRONG = await talvi.gateHex(
  await talvi.deriveMasterHex("Wrong-Horse-9!", NAME),
  NAME,
);

function newChannel() {
  return new ChatChannel({}, {});
}

async function connect(ch) {
  const ws = new MockWS();
  ch.handleSession(ws);
  await settle();
  return ws;
}

// -------------------------------------------------------------- open channel

{
  const ch = newChannel();
  const a = await connect(ch);
  check("open channel does not challenge", !a.has("challenge"));
  a.recv({ t: "join", nick: "a" });
  await settle();
  check("open channel admits a plain join", a.has("ready"));

  const b = await connect(ch);
  b.recv({ t: "join", nick: "b" });
  await settle();
  check("second member gets ready", b.has("ready"));
  check("newcomer receives roster replay", b.all("join").some((f) => f.nick === "a"));
  check("existing member sees the join", a.all("join").some((f) => f.nick === "b"));

  a.recv({ t: "msg", d: "hello" });
  await settle();
  const relayed = b.first("msg");
  check("message relays with from", relayed?.d === "hello" && relayed?.from === "a");
  check("sender does not echo to itself", !a.has("msg"));

  b.close(1000, "bye");
  await settle();
  check("leave is broadcast", a.all("leave").some((f) => f.nick === "b"));
}

// ------------------------------------------------------------- gate creation

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();
  check("first joiner installs the gate", a.has("ready"));
  check("gate is now set on the object", ch.gate !== null);

  // Second socket must be challenged, not admitted.
  const b = await connect(ch);
  check("gated channel challenges on connect", b.has("challenge"));
}

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a" });
  await settle();
  const b = await connect(ch);
  b.recv({ t: "join", nick: "b", setgate: GATE });
  await settle();
  check("latecomer cannot gate an in-use channel",
    b.first("error")?.code === "notfirst");
  check("latecomer is closed", b.closed !== null);
  check("channel stays open", ch.gate === null);
}

// ------------------------------------ re-challenge must not invalidate (BUG)

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();

  const b = await connect(ch);
  const firstChallenge = b.first("challenge");
  check("challenge arrives on connect", !!firstChallenge);

  // The real client sends its join as soon as the socket opens — BEFORE it has
  // processed the challenge. This is the ordinary case, not an edge case.
  b.recv({ t: "join", nick: "b", setgate: GATE });
  await settle();

  check("gate-less join is not counted as a failure", ch.gateFails === 0);
  check("socket is not closed for it", b.closed === null);
  // THE regression: exactly one nonce may be outstanding. A second challenge
  // here would invalidate the answer the client is already computing.
  check("no second challenge is issued", b.all("challenge").length === 1);

  // Client now answers the challenge it originally received.
  const answer = await talvi.answerHex(GATE, firstChallenge.nonce);
  b.recv({ t: "join", nick: "b", gate: answer });
  await settle();
  check("answer to the ORIGINAL nonce is accepted", b.has("ready"));
  check("successful join left no failure on the clock", ch.gateFails === 0);
}

// -------------------------------------------- payload kind is not negotiable

// A channel carries exactly one kind of payload, decided by whether it has a
// gate. The server cannot read an envelope, but refusing to relay anything
// else is the one part of the room's guarantee it CAN enforce — so a stray
// plaintext frame on a sealed channel must die at the relay rather than be
// passed on looking like a normal message.
{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();

  const b = await connect(ch);
  b.recv({ t: "join", nick: "b", gate: await talvi.answerHex(GATE, b.first("challenge").nonce) });
  await settle();
  check("gated: correct PIN admitted", b.has("ready"));

  const key = await talvi.encKey(await talvi.deriveMasterHex(PIN, NAME), NAME);
  a.recv({ t: "msg", env: await talvi.seal(key, "sealed hello") });
  await settle();
  const got = b.first("msg");
  check("gated: envelope is relayed", got?.env !== undefined && got?.from === "a");
  check("gated: relay does not add plaintext", got?.d === undefined);
  check("gated: envelope survives the relay byte-for-byte",
    (await talvi.unseal(key, got.env)) === "sealed hello");

  const before = b.all("msg").length;
  a.recv({ t: "msg", d: "plaintext leak" });
  await settle();
  check("gated: PLAINTEXT IS NOT RELAYED", b.all("msg").length === before);

  a.recv({ t: "msg", env: { v: 2, iv: "x".repeat(16), ct: "abc" } });
  a.recv({ t: "msg", env: { v: 1, iv: "short", ct: "abc" } });
  a.recv({ t: "msg", env: { v: 1, iv: "x".repeat(16), ct: "" } });
  a.recv({ t: "msg", env: "not-an-object" });
  await settle();
  check("gated: malformed envelopes are not relayed", b.all("msg").length === before);
}

{
  // ...and the converse: an open channel does not carry envelopes. Nobody on
  // it holds a key, so relaying one would only put undecryptable noise in
  // front of every member.
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a" });
  await settle();
  const b = await connect(ch);
  b.recv({ t: "join", nick: "b" });
  await settle();

  const key = await talvi.encKey(await talvi.deriveMasterHex(PIN, NAME), NAME);
  a.recv({ t: "msg", env: await talvi.seal(key, "why is this here") });
  await settle();
  check("open: envelope is NOT relayed", !b.has("msg"));

  a.recv({ t: "msg", d: "plain hello" });
  await settle();
  check("open: plaintext still relays", b.first("msg")?.d === "plain hello");
}

// ------------------------------------------------------------- gate refusal

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();

  const b = await connect(ch);
  const wrongAnswer = await talvi.answerHex(WRONG, b.first("challenge").nonce);
  b.recv({ t: "join", nick: "b", gate: wrongAnswer });
  await settle();
  check("wrong PIN is refused 4003", b.closed?.code === 4003);
  check("wrong PIN counts against the lockout", ch.gateFails === 1);
  check("wrong PIN never gets ready", !b.has("ready"));

  const c = await connect(ch);
  c.recv({ t: "join", nick: "c", gate: "nothex" });
  await settle();
  check("malformed answer refused with the same code", c.closed?.code === 4003);
  check("malformed answer counts too", ch.gateFails === 2);
}

// ------------------------------------------------------------------ lockout

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();

  for (let i = 0; i < 5; i += 1) {
    const x = await connect(ch);
    x.recv({ t: "join", nick: "x" + i, gate: await talvi.answerHex(WRONG, x.first("challenge").nonce) });
    await settle();
  }
  check("five misses arm the lockout", ch.lockedUntil > Date.now());
  check("counter resets once armed", ch.gateFails === 0);

  // The real proof: a KNOWN-GOOD PIN is refused while locked. 4003 alone means
  // nothing here, because a wrong PIN closes 4003 too.
  const good = await connect(ch);
  const ch2 = good.first("challenge");
  good.recv({
    t: "join",
    nick: "good",
    gate: ch2 ? await talvi.answerHex(GATE, ch2.nonce) : "0".repeat(64),
  });
  await settle();
  check("correct PIN refused while locked out", good.closed?.code === 4003);
  check("correct PIN never gets ready while locked", !good.has("ready"));
  check("hammering a locked channel does not deepen it", ch.gateFails === 0);

  // And it recovers.
  ch.lockedUntil = 0;
  const after = await connect(ch);
  after.recv({
    t: "join",
    nick: "after",
    gate: await talvi.answerHex(GATE, after.first("challenge").nonce),
  });
  await settle();
  check("correct PIN admitted once the lockout expires", after.has("ready"));
}

// -------------------------------------------------------------- other bounds

{
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "bad nick" });
  await settle();
  check("bad nick refused", a.first("error")?.code === "badnick");
  check("bad nick closed 1008", a.closed?.code === 1008);

  const b = await connect(ch);
  b.fire("message", { data: JSON.stringify({ t: "msg", d: "x".repeat(5000) }) });
  await settle();
  check("oversize frame refused", b.first("error")?.code === "toolarge");
  check("oversize frame leaves socket open", b.closed === null);

  const c = await connect(ch);
  c.fire("message", { data: "{not json" });
  await settle();
  check("garbage frame does not crash or close", c.closed === null);
}

{
  // An unjoined socket must never receive relayed traffic — including one
  // still sitting in front of a challenge.
  const ch = newChannel();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", setgate: GATE });
  await settle();
  const lurker = await connect(ch);
  a.recv({ t: "msg", d: "secret" });
  await settle();
  check("unauthenticated socket receives no messages", !lurker.has("msg"));
  check("unauthenticated socket is not in the roster", ch.memberCount() === 1);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
