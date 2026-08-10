// Channel names are the whole access model (decision D9, talvi-chat blueprint):
// unguessable, secret, shared by word of mouth like a talvi slug. The channel
// list is not public — you know the name or you don't.
//
// Validation mirrors slug.js: shape first, so a malformed name never reaches a
// Durable Object. Lowercase a-z, 0-9, hyphen, 1-64 chars. The lowercase-only
// rule keeps names typeable and guarantees one canonical form per channel —
// "Talvi-Room" and "talvi-room" must not be two channels.

const CHANNEL_RE = /^[a-z0-9-]{1,64}$/;

export function isValidChannelName(s) {
  return typeof s === "string" && CHANNEL_RE.test(s);
}

// Nicks (D11): one visible token, no whitespace, no control chars, <= 32
// UTF-16 units. Display-only — the client renders them with textContent, so
// they never reach HTML. Uniqueness is cosmetic (D12): duplicates are
// allowed and shown as-is; the channel has no notion of identity to protect.
const NICK_RE = /^[^\s\u0000-\u001f\u007f]+$/u;

export function isValidNick(s) {
  return (
    typeof s === "string" && s.length >= 1 && s.length <= 32 && NICK_RE.test(s)
  );
}
