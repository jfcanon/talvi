// Shared HTML escaping for server-rendered learn pages (relay/hub convention).
// All content-derived text passes through here so an ampersand in a lesson
// title can never break the markup. The strict CSP (default-src 'none') is the
// injection hardening; this is text correctness.

// Escape for text-node position.
export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escape for a double-quoted attribute value (quotes are the load-bearing bit).
export function escAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Serialise an object into a data-* attribute value. The exercise's full
// definition (including its answer — bundled content, single owner, client-side
// grading per the PR6 brief) rides in the DOM this way, readable by client.js
// without any inline script.
export function dataJson(obj) {
  return escAttr(JSON.stringify(obj));
}
