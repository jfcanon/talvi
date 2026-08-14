// Shared HTML escaping for server-rendered learn pages. All user-derived or
// content-derived text passes through here so it can never be forgotten at a
// call site (relay/hub convention). Every page carries the strict CSP — no
// inline handlers, no inline scripts — so the escaping here is about text
// correctness (an ampersand in a lesson title must not break the markup),
// and the CSP does the injection hardening.

// Escape for text-node position: < > & " ' are all neutralised.
export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escape for a double-quoted attribute value (same set; the quotes matter).
export function escAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Serialise an object into a data-* attribute value. Used to embed an
// exercise's full definition (including its answer — bundled content, single
// owner, client-side grading per the converged plan) in the DOM so client.js
// can read and grade it without any inline script.
export function dataJson(obj) {
  return escAttr(JSON.stringify(obj));
}
