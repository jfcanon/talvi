// Slug: 12 random bytes -> base64url -> 16 chars, 96 bits of entropy (B.6).
// Not randomUUID() — a UUID is 122 bits but 36 ugly hyphenated chars, and the
// whole product is "here is a nice link". 96 bits is far past brute-forceable
// at the read rate limit.

export function newSlug() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // base64url without padding. btoa needs a binary string.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isValidSlug(s) {
  return /^[A-Za-z0-9_-]{16}$/.test(s);
}
