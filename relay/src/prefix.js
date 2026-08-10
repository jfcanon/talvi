// The relay mounts at app.ygdcbtmc4u.uk/relay (blueprint A2). Cloudflare
// routes app.*/relay/* to this worker, which receives pathnames beginning with
// /relay. Every internal route strips this prefix, and every generated link
// re-applies it so the browser lands back on the relay worker (the hub's `/*`
// fallback would otherwise swallow /s.css etc.).
export const PREFIX = "/relay";
