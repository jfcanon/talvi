// Magic-byte image detection. The stored content_type is a client-declared
// label and is NEVER trusted (B.7 item 1) — whether a file is an image is
// decided by its own first bytes. These five raster signatures cover every
// real photo/screenshot. SVG is deliberately excluded (markup, no single byte
// signature, scriptable content) — see plans/talvi-markdown-blueprint.md §3.
export function sniffImageKind(head) {
  const b = new Uint8Array(head);

  // FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpeg";
  }

  // 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "png";
  }

  // "RIFF" at 0–3, "WEBP" at 8–11
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "webp";
  }

  if (b.length >= 6) {
    const six = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (six === "GIF87a" || six === "GIF89a") return "gif";
  }

  // "BM"
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
    return "bmp";
  }

  return null;
}

const MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

export function imageMime(kind) {
  return MIME[kind] ?? null;
}
