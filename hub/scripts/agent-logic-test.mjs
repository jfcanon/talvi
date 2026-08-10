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

// --- mirror the AgentDO command surface -------------------------------------
function isWorkspacePath(p) {
  return typeof p === "string" && p.startsWith("/workspace") && !p.includes("..");
}

async function runFrame(cmd, path, data) {
  if (cmd === "write" && typeof data !== "string") return { t: "err", code: "badpath" };
  if ((cmd === "read" || cmd === "ls" || cmd === "write") && !isWorkspacePath(path))
    return { t: "err", code: "badpath" };
  try {
    if (cmd === "write") {
      await ws.fs.writeFile(path, data);
      return { t: "ok", cmd, result: "wrote " + path };
    } else if (cmd === "read") {
      const text = await ws.fs.readFile(path, "utf8");
      return { t: "ok", cmd, result: text };
    } else if (cmd === "ls") {
      const entries = await ws.fs.readdir(path);
      return { t: "ok", cmd, result: entries.map((e) => (e.isDirectory ? e.name + "/" : e.name)).join("\n") };
    }
    return { t: "err", code: "badcmd" };
  } catch {
    return { t: "err", code: "io" };
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures++;
}

const w = await runFrame("write", "/workspace/note.txt", "hello agent");
check("write lands in workspace", w.t === "ok" && w.result === "wrote /workspace/note.txt", JSON.stringify(w));
const r = await runFrame("read", "/workspace/note.txt");
check("read round-trips content", r.t === "ok" && r.result === "hello agent", JSON.stringify(r));
const l = await runFrame("ls", "/workspace");
check("ls lists the file", l.t === "ok" && l.result.includes("note.txt"), JSON.stringify(l));
const bad = await runFrame("read", "/etc/passwd");
check("path escape refused", bad.t === "err" && bad.code === "badpath", JSON.stringify(bad));
const badcmd = await runFrame("sudo");
check("unknown command refused", badcmd.t === "err" && badcmd.code === "badcmd", JSON.stringify(badcmd));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
