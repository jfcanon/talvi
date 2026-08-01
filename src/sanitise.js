// Input sanitisation for the upload path (B.7 items 2 and 3).
// The filename is client-supplied and ends up in a Content-Disposition header
// and on the HTML view page — two injection sinks — so it is scrubbed hard.

// Strip C0 (0x00–0x1F), DEL, and C1 (0x80–0x9F) control characters.
// Done by codepoint rather than a regex with literal control bytes, so the
// source file itself stays free of control characters (and leak/secret
// scanners don't choke on them).
function stripControls(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// Percent-decode, then strip everything dangerous. Falls back to "file".
export function sanitiseFilename(raw) {
  if (typeof raw !== "string" || raw === "") return "file";

  // decodeURIComponent throws on a malformed % sequence; the fallback is to
  // sanitise the raw undecoded string rather than 500 on hostile input.
  let s;
  try {
    s = decodeURIComponent(raw);
  } catch {
    s = raw;
  }

  s = stripControls(s)
    // Path separators, double-quote, and angle brackets. < > are stripped at
    // intake as defense-in-depth (Step 3 done-when: "no raw <" in storage) —
    // escapeHtml() at render remains the primary XSS control, but a filename
    // containing markup has no legitimate use and is cheaper to drop here.
    .replace(/[/\\"<>]/g, "")
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .slice(0, 200);

  return s === "" ? "file" : s;
}

// The declared type is validated then stored ONLY as a display label — it is
// never echoed on download (B.7 item 1). An invalid type is not an error;
// it defaults, because the value is cosmetic.
export function validateContentType(raw) {
  if (
    typeof raw === "string" &&
    /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/.test(raw)
  ) {
    return raw;
  }
  return "application/octet-stream";
}

// Written here, used by the Step 4 view page. Every interpolated value on the
// HTML page goes through this — it is the live XSS control (B.7 item 3).
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
