// Workers-native rate limiting, keyed on the client IP. CF-Connecting-IP is
// set by the edge and cannot be spoofed by the client — unlike X-Forwarded-For,
// which is client-supplied and must never be trusted for this. Ported from the
// green worker's src/index.js (Step 6); the caveat below travels with it.
//
// Fails OPEN: if the binding is missing or throws, the request proceeds. A
// rate limiter that takes the whole app down when it misbehaves is a worse
// outcome than one that briefly stops limiting — and this is a personal file
// drop, not a bank.
// KNOWN UNRESOLVED as of 2026-08-02, recorded here so nobody re-derives it:
// these limits DO NOT currently fire on green. Terraform sends the bindings
// with `simple = { limit, period }`, the apply reports them created, and at
// runtime `env.RL_UPLOAD` is an object whose `.limit` is a function taking a
// key — all verified live with a temporary probe route. But `limit()` returns
// `{ success: true }` indefinitely: 6 uploads against a 3/min cap and 65 reads
// against a 60/min cap all passed, as did 5 consecutive probe calls using one
// fixed key.
//
// What is CONFIRMED: the binding exists at runtime, the call shape matches
// Cloudflare's documented API, CF-Connecting-IP is present, and Terraform
// transmitted limit/period.
// What is NOT known: why the namespace does not count. Not investigated
// further because it needs an API-token query against the deployed script's
// stored binding config, and every token in this project is human-held.
//
// The code stays because it is correct against the documented API and costs
// nothing while inert — and because when the binding does start counting, it
// will simply begin working. Do NOT read this as "rate limiting is in place".
// The same pattern is used by the relay, whose limiter has never been
// verified live either; it may well be equally inert.
export async function withinLimit(binding, request) {
  if (!binding) return true; // binding not deployed yet — do not break the app
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return true;
  try {
    const { success } = await binding.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}
