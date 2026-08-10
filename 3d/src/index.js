// talvi 3d Worker — bootstrap skeleton (Step 1).
//
// Proves the pipeline end-to-end before any UI exists: the DNS record, the
// worker deploy, the route pattern, and the CI plan/apply loop. Serves only
// /healthz; everything else is the uniform 404. Step 2 claims "/", /3d.css
// and /3d.js with the scene; Step 3 closes the polish.
//
// No bindings, no D1/R2/DO, no secrets, no `migrations` block — nothing here
// will ever need them (blueprint A4).
const ROBOTS_TAG = "noindex, nofollow";

function notFound() {
  return new Response("not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": ROBOTS_TAG,
    },
  });
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method !== "GET") return notFound();

    if (pathname === "/healthz") {
      // Never rate limited: an uptime check that trips a limiter reports an
      // outage that is not happening (hub's rule, carried over).
      return new Response("ok", {
        status: 200,
        headers: { "x-robots-tag": ROBOTS_TAG },
      });
    }

    return notFound();
  },
};
