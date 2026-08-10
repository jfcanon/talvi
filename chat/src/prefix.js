// Chat mounts at app.ygdcbtmc4u.uk/chat (blueprint A2). Cloudflare routes
// app.*/chat/* to this worker, which receives pathnames beginning with /chat.
// Chat's own routes are already under /chat (landing, room, ws), so the router
// matches them directly; the PREFIX is applied to generated asset refs so the
// browser requests /chat/s.css etc. back onto this worker (the hub's `/*`
// fallback would otherwise swallow them).
export const PREFIX = "/chat";
