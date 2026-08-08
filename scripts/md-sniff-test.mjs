// Sniffer tests (markdown sidequest, PR2). Run: node scripts/md-sniff-test.mjs
//
// The "as markdown" route exists only for images, and whether a file is an
// image is decided by its own first bytes — never the client-declared type.
// A sniffing regression costs a PR, a plan, an apply and a live round trip,
// so the decision function is tested offline before any of that.
import { sniffImageKind, imageMime } from "../src/sniff.js";

let passed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
  }
}

function bytes(hex) {
  return Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
}

function ascii(s) {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

// ------------------------------------------------------------- happy paths

check("jpeg", sniffImageKind(bytes("ffd8ffe000104a464946")) === "jpeg");
check("png", sniffImageKind(bytes("89504e470d0a1a0a0000000d49484452")) === "png");
check("webp", sniffImageKind(ascii("RIFFxxxxWEBPVP8 ")) === "webp");
check("gif87", sniffImageKind(ascii("GIF87a....")) === "gif");
check("gif89", sniffImageKind(ascii("GIF89a....")) === "gif");
check("bmp", sniffImageKind(ascii("BM....")) === "bmp");

// ------------------------------------------------------------ hostile paths

check("html is not an image", sniffImageKind(ascii("<html><body>")) === null);
check("html doctype is not an image", sniffImageKind(ascii("<!DOCTYPE html>")) === null);
check("empty head", sniffImageKind(bytes("")) === null);
check("one byte", sniffImageKind(bytes("ff")) === null);
check("two byte png prefix", sniffImageKind(bytes("8950")) === null);
check("seven byte png head", sniffImageKind(bytes("89504e470d0a1a")) === null);
check("five byte gif prefix", sniffImageKind(ascii("GIF87")) === null);
check("riff short of webp", sniffImageKind(ascii("RIFF")) === null);
check("riff with wrong fourcc", sniffImageKind(ascii("RIFFxxxxAVIFVP8 ")) === null);
check("jpeg with wrong third byte", sniffImageKind(bytes("ffd8e0")) === null);
check("random bytes", sniffImageKind(bytes("deadbeefcafebabe")) === null);
check("zero bytes are not a bmp", sniffImageKind(bytes("0000")) === null);

// The declared type is irrelevant: a PNG whose label says text/html still
// sniffs as png. (The Worker never passes the declared type here at all — this
// guards against anyone reintroducing it.)
check("png wins over declared html", sniffImageKind(bytes("89504e470d0a1a0a0000")) === "png");

// ------------------------------------------------------------- mime mapping

check("png mime", imageMime("png") === "image/png");
check("jpeg mime", imageMime("jpeg") === "image/jpeg");
check("webp mime", imageMime("webp") === "image/webp");
check("gif mime", imageMime("gif") === "image/gif");
check("bmp mime", imageMime("bmp") === "image/bmp");
check("unknown kind has no mime", imageMime("svg") === null);
check("null has no mime", imageMime(null) === null);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
