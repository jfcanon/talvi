// Test-only auth stub for the worker smoke test. Bundled in place of
// src/lib/auth.js via esbuild --alias (see worker-smoke-test.mjs). Marks any
// request with a cookie as authenticated.
export async function isAuthenticated(request) {
  const cookie = request.headers.get("cookie") || "";
  return cookie.includes("__session=stub");
}
