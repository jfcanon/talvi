// The learn worker mounts at app.ygdcbtmc4u.uk/learn (blueprint B.1).
// Cloudflare routes app.*/learn/* to this worker, which receives pathnames
// beginning with /learn. Every internal route strips this prefix, and every
// generated link re-applies it so the browser lands back on the learn worker
// (the hub's `/*` fallback would otherwise swallow /s.css etc.).
export const PREFIX = "/learn";
