// Leoncito dashboard proxy — serves the Pages project at
// app.ygdcbtmc4u.uk/leoncito on the free plan.
//
// Why a Worker instead of rulesets: the transform-rule path rewrite needs
// regex_replace (Business / WAF Advanced only) and the origin-rule HostHeader
// override needs a paid plan — both 400'd on this zone. The Worker does the
// same job (strip the /leoncito prefix, proxy to the Pages host) for free.
//
// The routes (app.ygdcbtmc4u.uk/leoncito and /leoncito/*) are more specific
// than the hub's `/*` fallback, so they win without touching the hub.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Bare /leoncito (no trailing slash): the HTML's relative asset URLs
    // (css/…, js/…, data/…) resolve against the page path, so from /leoncito
    // they'd land on /css, /js, /data — outside this prefix, onto the hub's
    // /* fallback, which returns HTML and breaks strict MIME checks (the
    // dashboard rendered all dashes). Normalize to the directory form, same
    // as relay/chat/learn.
    if (url.pathname === "/leoncito") {
      return Response.redirect(new URL("/leoncito/", request.url), 302);
    }
    const rest = url.pathname.replace(/^\/leoncito\/?/, "/") + url.search;
    return fetch("https://leoncito-dashboard.pages.dev" + rest, request);
  },
};
