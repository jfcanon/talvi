// Cross-build determinism for the OpenNext output.
//
// Next's build emits random-ish values per run and OpenNext adds a build
// timestamp; they end up inside the bundled dist-worker/worker.js AND the
// .open-next/assets directory, which are Terraform inputs (`content = file(...)`
// and the assets block). Any run-to-run variance surfaces as a perpetual plan
// diff — the failure mode the relay/talstack determinism rule exists to prevent
// (03-lessons-learned §3).
//
// The random values, captured from the freshly built tree and then rewritten
// EVERYWHERE (including the bundled copies OpenNext inlines into
// index.mjs/handler.mjs/queue.js) to values deterministically derived from the
// git commit:
//
//   - __BUILD_TIMESTAMP_MS__ in .open-next/cloudflare/init.js (OpenNext)
//   - previewModeId / previewModeSigningKey / previewModeEncryptionKey
//     (Next prerender preview mode; unused by this app)
//   - the RSC encryptionKey (Server Actions encryption; unused by this app)
//
// Same commit -> same bytes, every time. (A build made without git
// deterministically falls back to fixed sentinel values, which keeps the plan
// stable at the cost of per-code cache busting.)
//
// One residual nondeterminism is Turbopack's emission ORDER of the tiny
// per-route client-reference manifest modules: Next 16 emits the s.png/s.css
// sibling route manifests in either order, flipping ~1 in 6 builds. esbuild
// names them by emission position (`manifest9` can be s.png or s.css), and the
// evalManifest dispatch clauses copy that order. The names travel with each
// block, so the fix is to renumber by route and sort both the block run and the
// dispatch chain to a canonical route order. See the canonicalize function below.
//
// Run between `opennextjs-cloudflare build` and the wrangler bundle step in CI.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const openNext = join(root, ".open-next");
const serverDir = join(
  openNext,
  "server-functions",
  "default",
  ".next",
  "server",
);

const seed = git("rev-parse --short=8 HEAD") ?? "no-git";
const commitSec = git("log -1 --format=%ct HEAD");

function git(args) {
  try {
    return execSync(`git ${args}`, { stdin: "ignore", encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Tag the derivation so fields never collide, and so a value cannot be
// confused with a real secret by someone grepping build output.
function hex(label) {
  return createHash("sha256").update(`talvi-blue-normalize:${seed}:${label}`).digest("hex");
}
function b64(label) {
  return createHash("sha256").update(`talvi-blue-normalize:${seed}:${label}`).digest("base64");
}

const determin = {
  ts: String(commitSec ? Number(commitSec) * 1000 : parseInt(hex("ts").slice(0, 12), 16)),
  previewId: hex("previewModeId").slice(0, 32),
  previewSign: hex("previewModeSigningKey").slice(0, 64),
  previewEnc: hex("previewModeEncryptionKey").slice(0, 64),
  rscKey: b64("rscKey"),
};

async function read(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// The freshly generated (random) values, captured so they can be replaced
// verbatim inside the OpenNext bundled files that inline them.
const initJs = await read(join(openNext, "cloudflare", "init.js"));
const manifest = JSON.parse(
  (await read(join(serverDir, "..", "prerender-manifest.json"))) ?? "null",
);
const refJs = (await read(join(serverDir, "server-reference-manifest.js"))) ?? "";
const refJson = (await read(join(serverDir, "server-reference-manifest.json"))) ?? "";

const random = {
  ts: initJs?.match(/__BUILD_TIMESTAMP_MS__:\s*(\d+)/)?.[1],
  previewId: manifest?.preview?.previewModeId,
  previewSign: manifest?.preview?.previewModeSigningKey,
  previewEnc: manifest?.preview?.previewModeEncryptionKey,
  rscKey: refJson.match(/"encryptionKey":\s*"([A-Za-z0-9+/=]{40,44})"/)?.[1],
};

function fail(field) {
  console.error(
    `normalize-build: FAILED to capture ${field} from the built tree — the ` +
      `build shape changed; determinism would be silently lost. Fix ` +
      `scripts/normalize-build.mjs.`,
  );
  process.exit(1);
}
for (const [field, value] of Object.entries(random)) {
  if (!value) fail(field);
}

// Turbopack emits the per-route client-reference manifest modules in
// nondeterministic ORDER (~1-in-6 builds swap the s.css/s.png siblings) and
// esbuild numbers them by emission position. Bring handler.mjs to a canonical
// arrangement: renumber each route's `require_route_client_reference_manifestN`
// by the N that its sorted route would claim, then sort both the __commonJS
// block run and the evalManifest dispatch chain by route. Same commit -> same
// bytes.
function canonicalizeRouteManifests(text) {
  // Collect the route embedded in each `require_route_client_reference_manifestN`
  // __commonJS definition. The giant combined block carries the ROOT route (no
  // app subpath) and must stay fixed at the end of the run.
  const defPat = /var require_route_client_reference_manifest(\d+)=__commonJS\(\{"([^"]*route_client-reference-manifest\.js)"/g;
  const defs = [];
  let m;
  while ((m = defPat.exec(text))) {
    const inner = m[2];
    const r = inner.match(/\/server\/app\/((?:[^"/]+(?:\/[^"/]+)*?))\/route_client-reference-manifest\.js$/);
    defs.push({ num: m[1], route: r ? r[1] : null });
  }
  const routes = [...new Set(defs.map((d) => d.route).filter((r) => r != null))].sort();
  const canonicalNum = new Map(routes.map((r, i) => [r, String(i + 2)]));
  const oldToNew = new Map();
  for (const d of defs) if (d.route && canonicalNum.has(d.route)) oldToNew.set(d.num, canonicalNum.get(d.route));
  if (oldToNew.size === 0) return text;

  // Renumber ALL references (definitions + dispatch) via sentinels to avoid
  // colliding when two old numbers map across each other.
  const sents = new Map();
  [...oldToNew.keys()].forEach((n, i) => sents.set(n, `\u0000R${i}\u0000`));
  for (const [n, s] of sents) {
    text = text.replace(new RegExp(`require_route_client_reference_manifest${n}\\b`, "g"), s);
  }
  for (const [n, s] of sents) {
    text = text.split(s).join(`require_route_client_reference_manifest${oldToNew.get(n)}`);
  }

  // Sort the contiguous __commonJS block run by the route whose path it embeds.
  // The ROOT block (route == null, no app subpath) sorts last by construction.
  const blockPat = /var require_route_client_reference_manifest(\d+)=__commonJS\(/g;
  const blocks = [];
  while ((m = blockPat.exec(text))) blocks.push({ start: m.index, num: m[1] });
  if (blocks.length) {
    const head = text.slice(0, blocks[0].start);
    const info = blocks.map((b, idx) => {
      const end = idx + 1 < blocks.length ? blocks[idx + 1].start : text.length;
      const seg = text.slice(b.start, end);
      const inner = seg.match(/__commonJS\(\{"([^"]*route_client-reference-manifest\.js)"/);
      const r = inner ? inner[1].match(/\/server\/app\/((?:[^"/]+(?:\/[^"/]+)*?))\/route_client-reference-manifest\.js$/) : null;
      return { ...b, end, route: r ? r[1] : null };
    });
    const routeOf = (b) => (b.route === null ? "\uffff" : b.route);
    const sorted = info.slice().sort((a, b) => routeOf(a).localeCompare(routeOf(b)));
    let rebuilt = head;
    for (const b of sorted) rebuilt += text.slice(b.start, b.end);
    if (rebuilt.length === text.length) text = rebuilt;
    else fail("handler block-run shape");
  }

// Sort the dispatch chains. handler.mjs contains several functions whose
  // body is a chain of `if(path2.endsWith("PATH"))return ...;` clauses
  // (evalManifest's RSC route manifests, loadManifest's json manifests, and
  // others). Turbopack emits sibling clauses in nondeterministic order, so the
  // chain order flips between builds. Sort each chain's route clauses by their
  // endsWith path. Each chain's LAST chunk also carries the function tail
  // (fallback return + throw), so it must stay last.
  const fnHeadPat = /function\s+\w+\(path2[^)]*\)\s*\{/g;
  let fnM;
  while ((fnM = fnHeadPat.exec(text))) {
    const fstart = fnM.index;
    let depth = 0, i = fstart;
    while (true) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
      i++;
    }
    const fend = i;
    if (fend - fstart < 400) continue; // not a dispatch chain function (tiny body)
    const fn = text.slice(fstart, fend);
    const key = 'if(path2.endsWith("';
    const idxs = [];
    let at = 0;
    while ((at = fn.indexOf(key, at)) >= 0) { idxs.push(at); at += key.length; }
    if (idxs.length < 2) continue; // no chain to reorder
    const prefix = fn.slice(0, idxs[0]);
    // Every chain clause (including the one whose chunk carries the shared
    // function tail) starts with a `if(path2.endsWith("PATH"))return ...;` head.
    // Sort the clause heads by PATH; the tail code that follows the LAST clause
    // head must stay after them. So: split the last chunk at the first
    // `;` that closes its return value, leaving clauseHead + tailCode.
    const clauses = idxs.map((s, k) =>
      k + 1 < idxs.length ? fn.slice(s, idxs[k + 1]) : fn.slice(s, fn.length - 1),
    );
    const clauseHeadRe = /^if\(path2\.endsWith\("[^"]*"\)\)return/;
    const last = clauses[clauses.length - 1];
    let tailCode = "";
    let headClauses = clauses;
    if (clauseHeadRe.test(last)) {
      // find the `;` that ends the last clause's return value (depth 0, after
      // the return value's own braces); everything after it is shared tail code.
      const hs = last.indexOf(")return");
      let depth = 0;
      let se = -1;
      for (let j = hs + 7; j < last.length; j++) {
        const ch = last[j];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ";" && depth === 0) { se = j; break; }
      }
      if (se >= 0) {
        tailCode = last.slice(se + 1);
        headClauses = [...clauses.slice(0, -1), last.slice(0, se + 1)];
      }
    }
    const pathOfChunk = (c) => {
      const m2 = c.match(/^if\(path2\.endsWith\("([^"]*)"\)\)/);
      return m2 ? m2[1] : "\ufffe";
    };
    const sorted =
      headClauses.slice().sort((a, b) => pathOfChunk(a).localeCompare(pathOfChunk(b))).join("") +
      tailCode;
    const newFn = prefix + sorted + fn.slice(fn.length - 1);
    if (newFn.length === fn.length) {
      const before = text.slice(fstart, fend);
      text = text.slice(0, fstart) + newFn + text.slice(fend);
      if (text.slice(fstart, fstart + newFn.length) !== newFn) fail("function chain rewire");
    } else fail("function chain shape");
    // re-scan from the same offset in case nested chains moved
    fnHeadPat.lastIndex = fstart + 1;
  }
  return text;
}

// sort the posts of a top-level `var v..=[..],v..={..},..;` run
function findChainEnd(text, s) {
  let depth = 0;
  let i = s;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return i;
    i++;
  }
  return -1;
}

function splitTop(seg) {
  const parts = [];
  let d = 0;
  let st = 0;
  const n = seg.length;
  for (let i = 0; i < n; i++) {
    const c = seg[i];
    if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
    else if (c === "," && d === 0) {
      parts.push(seg.slice(st, i));
      st = i + 1;
    }
  }
  parts.push(seg.slice(st));
  return parts;
}

// The bundled RSC server chunk manifest arrives as a module-scope
// `var v20a=[...],v703=[...],vc42=[...],v40b=[...],v79a={...},....;` run.
// Turbopack emits the entries in nondeterministic order, so esbuild's
// minified names (which encode emission position) differ between builds even
// though the CONTENT is identical. Sort each entry by its own content hash —
// pure array literals first (they are the chunk lists that object entries
// reference), then the objects — so the run is byte-identical regardless of
// emission order.
function canonicalizeChunkRun(text) {
  const chainPat = /var v[a-z0-9]+=\["\/_next\/static\/chunks\//g;
  const targets = [];
  let m;
  while ((m = chainPat.exec(text))) targets.push(m.index);
  let text2 = text;
  for (let t = targets.length - 1; t >= 0; t--) {
    const s = targets[t];
    const end = findChainEnd(text2, s);
    if (end < 0) continue;
    const seg = text2.slice(s, end);
    if (!/chunks:v[a-z0-9]+\b/.test(seg)) continue;
    const parts = splitTop(seg);
    if (parts.length < 3) continue;
    const head = parts[0];
    const rest = parts.slice(1);
    const keyOf = (c) => createHash("sha256").update(c).digest("hex").slice(0, 16);
    const isArray = (c) => /=\[("[^"]*"(?:,"[^"]*")*)\]$/.test(c);
    rest.sort((a, b) => {
      const ga = isArray(a) ? 0 : 1;
      const gb = isArray(b) ? 0 : 1;
      if (ga !== gb) return ga - gb;
      return keyOf(a).localeCompare(keyOf(b));
    });
    const rebuilt = head + "," + rest.join(",") + ";";
    if (rebuilt === seg) continue;
    text2 = text2.slice(0, s) + rebuilt + text2.slice(end + 1);
  }
  return text2;
}

const targets = [
  join(openNext, "cloudflare", "init.js"),
  join(serverDir, "..", "prerender-manifest.json"),
  join(serverDir, "server-reference-manifest.js"),
  join(serverDir, "server-reference-manifest.json"),
  join(openNext, "server-functions", "default", "index.mjs"),
  join(openNext, "server-functions", "default", "handler.mjs"),
  join(openNext, "middleware", "handler.mjs"),
  join(openNext, ".build", "durable-objects", "queue.js"),
];

let patched = 0;
for (const path of targets) {
  let text = await read(path);
  if (text === null) {
    console.log(`normalize-build: skip (absent) ${path}`);
    continue;
  }
  let changed = false;
  const swap = (from, to) => {
    if (from && to && from !== to && text.includes(from)) {
      text = text.split(from).join(to);
      changed = true;
    }
  };
  swap(random.ts, determin.ts);
  swap(random.previewId, determin.previewId);
  swap(random.previewSign, determin.previewSign);
  swap(random.previewEnc, determin.previewEnc);
  swap(random.rscKey, determin.rscKey);
  // The bundled handler.mjs also carries the Turbopack-emission-order flake.
  if (text.includes("require_route_client_reference_manifest")) {
    const before = text;
    text = canonicalizeRouteManifests(text);
    if (text !== before) changed = true;
  }
  if (text.includes(`var v`)) {
    const before = text;
    text = canonicalizeChunkRun(text);
    if (text !== before) changed = true;
  }
  if (changed) {
    await writeFile(path, text);
    patched += 1;
    console.log(`normalize-build: patched ${path}`);
  }
}

console.log(
  `normalize-build: done (seed=${seed}, ts=${determin.ts}, patched ${patched} file(s))`,
);
