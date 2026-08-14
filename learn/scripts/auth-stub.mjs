// Test-only auth stub for the worker smoke test. Bundled in place of
// src/lib/auth.js via the esbuild resolve plugin in data-smoke-test.mjs.
// Marks any request with a cookie as authenticated and returns a fixed user id.
export async function getUserId(request) {
  const cookie = request.headers.get("cookie") || "";
  return cookie.includes("__session=stub") ? "test-user" : null;
}
