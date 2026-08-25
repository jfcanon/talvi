// Dev server for talvi learn e2e (NID-414).
// Builds the Worker exactly like ui-smoke-test.mjs does (esbuild with the
// auth-stub.mjs resolve plugin → dist/index-ui-test.mjs), uses the shared
// in-memory D1 stub (scripts/lib/db-stub.mjs), and serves on
// 127.0.0.1:<port> by forwarding each request to
// worker.fetch(new Request("https://app.ygdcbtmc4u.uk" + url, …))
// with cookie __session=stub injected, the CSP header stripped, and
// `location` rewritten to a relative path.
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- build the Worker exactly like ui-smoke-test.mjs ----
const esbuild = await import("esbuild");
const authStub = join(root, "scripts/auth-stub.mjs");
const stubAuth = {
  name: "stub-auth",
  setup(build) {
    build.onResolve({ filter: /^\.\/lib\/auth\.js$/ }, () => ({ path: authStub }));
  },
};
await esbuild.build({
  entryPoints: [join(root, "src/index.js")],
  bundle: true,
  format: "esm",
  plugins: [stubAuth],
  outfile: join(root, "dist/index-ui-test.mjs"),
  logLevel: "silent",
});

const { makeDb } = await import(join(root, "scripts/lib/db-stub.mjs"));
const mod = await import(join(root, "dist/index-ui-test.mjs"));
const worker = mod.default;
const { db } = makeDb();
const env = { DB: db, CLERK_SECRET_KEY: "x", CLERK_PUBLISHABLE_KEY: "y", CLERK_JWT_KEY: "z" };
const BASE = "https://app.ygdcbtmc4u.uk";

function stripCspAndRewriteLocation(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "content-security-policy") continue;
    // Defer location rewrite below so we handle canonical case.
    if (lk === "location") continue;
    out[k] = v;
  }
  const loc = headers.get("location");
  if (loc) {
    try {
      const u = new URL(loc, BASE);
      // Serve relative so the browser stays on 127.0.0.1.
      out["location"] = u.pathname + u.search + u.hash;
    } catch {
      out["location"] = loc;
    }
  }
  return out;
}

async function handleNodeReq(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  const url = req.url || "/";
  const headers = new Headers();
  // Forward non-hop-by-hop headers; inject auth cookie.
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v) continue;
    const lk = k.toLowerCase();
    // Hop-by-hop / node-specific
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    if (lk === "cookie") continue;
    const val = Array.isArray(v) ? v.join(", ") : v;
    try { headers.set(k, val); } catch {}
  }
  headers.set("cookie", "__session=stub");
  if (req.headers["content-type"]) headers.set("content-type", String(req.headers["content-type"]));

  const init = { method: req.method, headers };
  if (rawBody.length && req.method !== "GET" && req.method !== "HEAD") init.body = rawBody;

  const request = new Request(BASE + url, init);
  let response;
  try {
    response = await worker.fetch(request, env);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack || e));
    return;
  }

  const outHeaders = stripCspAndRewriteLocation(response.headers);
  // Ensure content-length is not stale
  delete outHeaders["content-length"];
  delete outHeaders["Content-Length"];

  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, outHeaders);
  res.end(buf);
}

export function startServer(port = 0) {
  const server = createServer((req, res) => { handleNodeReq(req, res).catch((e) => {
    res.writeHead(500, { "content-type": "text/plain" }); res.end(String(e?.stack || e));
  }); });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)) });
    });
    server.on("error", reject);
  });
}

// When run directly: start and keep alive.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argPort = Number(process.argv[2] || process.env.PORT || 0) || 0;
  const { port, url } = await startServer(argPort);
  console.log(`dev-serve listening on ${url}`);
  // Keep process alive; graceful shutdown
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // Prevent top-level await exit
  await new Promise(() => {});
}
