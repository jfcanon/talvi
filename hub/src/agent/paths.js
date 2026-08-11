// Shared path helpers for the agent DO (blueprint PR2/3b).

export const WORKSPACE_ROOT = "/workspace";

// Paths are absolute, inside the workspace root, and must not escape it. The
// fs surface already rejects absolute escapes; this is the routing gate.
export function isWorkspacePath(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith(WORKSPACE_ROOT)) return false;
  if (p.includes("..")) return false;
  return true;
}
