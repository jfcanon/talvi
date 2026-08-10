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

import { ChatChannel, sameOrigin } from "../src/chat/channel.js";

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
const PIN = "4729";
const GATE = await talvi.gateHex(await talvi.deriveMasterHex(PIN, NAME), NAME);
const WRONG = await talvi.gateHex(
  await talvi.deriveMasterHex("8153", NAME),
  NAME,
);

function newChannel() {
  return new ChatChannel({}, {});
}

// A real-DO-shaped mock storage, so the persistence layer (gate, presence,
// history, the 24h alarm) can be exercised offline. Same method surface the
// DO runtime provides: get/put/deleteAll/setAlarm/cancelAlarm.
class MockStorage {
  constructor() {
    this.kv = new Map();
    this.alarms = [];
    this.deleted = false;
  }
  async get(k) {
    return this.kv.get(k);
  }
  async put(k, v) {
    this.kv.set(k, v);
  }
  async deleteAll() {
    this.kv.clear();
    this.deleted = true;
  }
  async setAlarm(t) {
    this.alarms.push(t);
  }
  async cancelAlarm() {
    this.alarms = [];
  }
}

function newChannelWithStorage() {
  const storage = new MockStorage();
  const ch = new ChatChannel({ storage }, {});
  return { ch, storage };
}

async function connect(ch) {
  const ws = new MockWS();
  ch.handleSession(ws);
  await settle();
  return ws;
}

// ------------------------------------------------------- same-origin gate

// The upgrade check must follow the host the request ARRIVED on, never a list
// of known hostnames. The list version worked right up until the site gained a
// hostname it had not been told about — a release domain, a blue/green staging
// host, a preview URL — and then refused every upgrade from there while the
// pages themselves rendered fine, which reads as a chat bug rather than a
// config one.
function req(url, origin, host) {
  return {
    url,
    headers: {
      get: (k) =>
        k === "Origin" ? (origin ?? null) : k === "Host" ? (host ?? null) : null,
    },
  };
}

const WS = "https://talvi.example/chat/x/ws";

check("same host is allowed",
  sameOrigin(req(WS, "https://talvi.example", "talvi.example")));
check("foreign origin is refused",
  !sameOrigin(req(WS, "https://evil.example", "talvi.example")));
check("absent Origin is allowed (curl, smoke clients — recorded decision)",
  sameOrigin(req(WS, null, "talvi.example")));
check("unparseable Origin is refused",
  !sameOrigin(req(WS, "not-a-url", "talvi.example")));
check("Origin 'null' (sandboxed iframe) is refused",
  !sameOrigin(req(WS, "null", "talvi.example")));

// Falls back to the request URL when no Host header is present.
check("falls back to request URL host",
  sameOrigin(req(WS, "https://talvi.example", null)));
check("fallback still refuses a foreign origin",
  !sameOrigin(req(WS, "https://evil.example", null)));

// THE regression this replaces: hostnames nobody has configured must just work.
for (const host of [
  "talvi.ygdcbtmc4u.uk",
  "talvi-web.ygdcbtmc4u.workers.dev",
  "talvi-green.ygdcbtmc4u.uk", // blue/green
  "staging.talvi.example", // preview
  "some-domain-nobody-bought-yet.test", // public release
]) {
  check(`unlisted host works: ${host}`,
    sameOrigin(req(`https://${host}/chat/x/ws`, `https://${host}`, host)));
}

// Port and scheme are part of the host comparison where they matter.
check("differing port is refused",
  !sameOrigin(req("https://talvi.example/chat/x/ws", "https://talvi.example:8443", "talvi.example")));

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
  // Presence model (owner 2026-08-10): a dropped socket is NOT leaving. No
  // {t:"leave"} is broadcast and the member still counts as present — a
  // phone-locked tab or a laptop that slept is still in the room.
  check("socket drop is not a leave (presence survives)",
    !a.all("leave").some((f) => f.nick === "b"));
  check("dropped member still counts as present", ch.memberCount() === 2);

  // Explicit DISCONNECT is the only leave — on a still-connected member.
  const c = await connect(ch);
  c.recv({ t: "join", nick: "c" });
  await settle();
  check("third member admitted", c.has("ready"));
  c.recv({ t: "leave" });
  await settle();
  check("disconnect broadcasts leave", a.all("leave").some((f) => f.nick === "c"));
  check("disconnect removes the presence", ch.memberCount() === 2);
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
    x.recv({ t: "join", nick: "x" + "abcde"[i], gate: await talvi.answerHex(WRONG, x.first("challenge").nonce) });
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

// ------------------------------------------------- presence + lifecycle (C5)

// A dropped socket keeps the member present; a reconnect with the SAME id
// resumes without a duplicate; a fresh id replays history.
{
  const { ch, storage } = newChannelWithStorage();
  const key = await talvi.encKey(await talvi.deriveMasterHex(PIN, NAME), NAME);

  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", id: "member-aaaa", setgate: GATE });
  await settle();
  check("first joiner with id installs the gate", a.has("ready") && ch.gate !== null);
  check("gate persisted to storage", storage.kv.has("gate"));

  const m1 = { v: 1, iv: "i".repeat(16), ct: "one" };
  a.recv({ t: "msg", env: m1 });
  await settle();
  check("history stored (ciphertext only)", storage.kv.get("history")?.length === 1);

  // a's socket drops — presence must survive (phone-lock case).
  a.close(1000, "bye");
  await settle();
  check("member present after socket drop", ch.memberCount() === 1);

  // a resumes with the same id — no history replay, no duplicate presence.
  const a2 = await connect(ch);
  a2.recv({ t: "join", nick: "a", id: "member-aaaa", gate: await talvi.answerHex(GATE, a2.first("challenge").nonce) });
  await settle();
  check("resume with same id admitted", a2.has("ready"));
  check("resume does not replay history", !a2.has("history"));
  check("no duplicate presence on resume", ch.memberCount() === 1);

  // A genuinely NEW member gets the stored history.
  const b = await connect(ch);
  b.recv({ t: "join", nick: "b", id: "member-bbbb", gate: await talvi.answerHex(GATE, b.first("challenge").nonce) });
  await settle();
  check("fresh member admitted", b.has("ready"));
  const hist = b.first("history");
  check("fresh member receives history replay", hist?.msgs?.length === 1, "len=" + (hist?.msgs?.length ?? "none"));
  check("history payload is the ciphertext envelope", hist?.msgs?.[0]?.env?.ct === "one");

  // An open channel stores NO history.
  const oc = newChannelWithStorage();
  const oa = await connect(oc.ch);
  oa.recv({ t: "join", nick: "o", id: "member-oooo" });
  await settle();
  oa.recv({ t: "msg", d: "plain hello" });
  await settle();
  check("open channel stores no history", !oc.storage.kv.has("history"));
}

// The room's 24h clock: a message arms an alarm ~24h out; the last
// DISCONNECT ends the room immediately.
{
  const { ch, storage } = newChannelWithStorage();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", id: "member-aaaa" });
  await settle();
  a.recv({ t: "msg", d: "hello" });
  await settle();
  check("message arms the 24h alarm", storage.alarms.length >= 1 &&
    Math.abs(storage.alarms[0] - (Date.now() + 24 * 60 * 60 * 1000)) < 5000);

  const b = await connect(ch);
  b.recv({ t: "join", nick: "b", id: "member-bbbb" });
  await settle();
  b.recv({ t: "leave" });
  await settle();
  check("one member leaving does not end the room", ch.memberCount() === 1 && storage.kv.size > 0);

  a.recv({ t: "leave" });
  await settle();
  check("last member leaving ends the room now", ch.memberCount() === 0);
  check("room storage wiped on last leave", storage.deleted === true);
  check("gate cleared with the room", ch.gate === null);
}

// The 24h alarm wipes the room.
{
  const { ch, storage } = newChannelWithStorage();
  const a = await connect(ch);
  a.recv({ t: "join", nick: "a", id: "member-aaaa", setgate: GATE });
  await settle();
  await ch.alarm();
  check("alarm wipes gate", ch.gate === null);
  check("alarm wipes presence", ch.memberCount() === 0);
  check("alarm wipes storage", storage.deleted === true);
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
