// PR2 logic test: prove the AgentDO's command protocol round-trips against a
// real @cloudflare/computer Workspace, using a node:sqlite-backed shim shaped
// like workerd's ctx.storage.sql (exec() returning { toArray() }).
import { DatabaseSync } from "node:sqlite";
import { Workspace } from "@cloudflare/computer";

const sql = new DatabaseSync(":memory:");
const storage = {
  sql: {
    exec(query, ...bindings) {
      const rows = sql.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
  transactionSync(fn) {
    sql.exec("BEGIN");
    try {
      const r = fn();
      sql.exec("COMMIT");
      return r;
    } catch (e) {
      sql.exec("ROLLBACK");
      throw e;
    }
  },
};

const ws = new Workspace({ storage });
await ws.ready();
await ws.fs.mkdir("/workspace", { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures++;
}

try {
  await ws.fs.writeFile("/workspace/note.txt", "hello agent");
  const t = await ws.fs.readFile("/workspace/note.txt", "utf8");
  check("write/read round-trip", t === "hello agent", JSON.stringify(t));
  const entries = await ws.fs.readdir("/workspace");
  check("ls lists the file", entries.some((e) => e.name === "note.txt"), JSON.stringify(entries.map((e) => e.name)));
} catch (e) {
  check("write/read round-trip", false, "threw: " + e.message);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
