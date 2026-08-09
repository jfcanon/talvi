// The custom Clerk sign-in page — "/sign-in" (blueprint L6: custom UI, strict
// CSP with a nonce, no unsafe-inline, no unsafe-eval in prod).
//
// This is the ONE page that loads clerk-js. It is built deliberately OUTSIDE
// renderPage() because it needs two things renderPage does not provide:
//   1. A per-request nonce threaded into both the CSP header and the <script>
//      tags (clerk-js and our own bootstrap). The rest of the app's CSP is
//      default-src 'none' and never changes; this page alone widens to the
//      strict Clerk CSP from session3/11 §4.3.
//   2. An inline bootstrap script (nonce'd) that drives the custom flow:
//      Clerk.load → signIn.create({identifier, password}) → setActive.
//
// The markup uses the same instrument language as every other page (frame,
// console register, hud labels) so the sign-in reads as part of the machine,
// not a third-party popup bolted on.
import { ASSET_VERSION } from "../generated/assets.js";
import { escapeHtml } from "../sanitise.js";

// Pinned to the exact build the prod instance serves (verified live:
// clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js@5.127.1/dist/clerk.browser.js).
// The route handler supplies publishableKey (a binding) so no key is baked
// into this file or into the repo.
const CLERK_JS_URL =
  "https://clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js@5.127.1/dist/clerk.browser.js";

// Strict Clerk CSP (session3/11 §4.3): nonce + strict-dynamic, no
// unsafe-inline, no unsafe-eval in prod. strict-dynamic makes the nonce the
// trust anchor: the nonce'd clerk-js <script> and the nonce'd bootstrap are
// trusted, and any script THEY load is trusted with them. The https: fallback
// only matters for browsers without strict-dynamic support. style-src 'self'
// is safe because the custom form is our own markup with our own /s.css — no
// Clerk CSS-in-JS anywhere.
export function signInCsp(nonce) {
  return [
    "default-src 'self'",
    "script-src 'self' 'strict-dynamic' 'nonce-" + nonce + "' https: http:",
    "style-src 'self'",
    "img-src 'self' data: https://img.clerk.com",
    "connect-src 'self' https://clerk.ygdcbtmc4u.uk https://*.protect.clerk.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// The bootstrap script. nonce-safe by construction: it is inserted inline with
// the same nonce that appears in the CSP. It only wires the form to the Clerk
// custom flow — it adds no markup, which keeps the "no inline style, no inline
// script that renders content" rule intact (the server renders everything).
function bootstrapScript(nonce, publishableKey) {
  return (
    '<script nonce="' + nonce + '">' +
    "(async function () {\n" +
    "  'use strict';\n" +
    "  var pub = " + JSON.stringify(publishableKey) + ";\n" +
    "  var form = document.getElementById('si-form');\n" +
    "  var email = document.getElementById('si-email');\n" +
    "  var password = document.getElementById('si-pass');\n" +
    "  var msg = document.getElementById('si-msg');\n" +
    "  var btn = document.getElementById('si-submit');\n" +
    "  if (!form) return;\n" +
    "  form.addEventListener('submit', async function (e) {\n" +
    "    e.preventDefault();\n" +
    "    msg.className = 'msg hidden';\n" +
    "    btn.disabled = true;\n" +
    "    btn.textContent = 'SIGNING IN';\n" +
    "    try {\n" +
    "      var clerk = await window.Clerk.load({ publishableKey: pub });\n" +
    "      var attempt = await clerk.client.signIn.create({ identifier: email.value.trim() });\n" +
    "      if (attempt.status === 'complete') {\n" +
    "        await clerk.setActive({ session: attempt.createdSessionId });\n" +
    "        window.location.href = '/';\n" +
    "        return;\n" +
    "      }\n" +
    "      var factors = (attempt.supportedFirstFactors || []).map(function (f) { return f.strategy; });\n" +
    "      if (factors.indexOf('password') !== -1) {\n" +
    "        var withPass = await attempt.attemptFirstFactor({ strategy: 'password', password: password.value });\n" +
    "        if (withPass.status === 'complete') {\n" +
    "          await clerk.setActive({ session: withPass.createdSessionId });\n" +
    "          window.location.href = '/';\n" +
    "          return;\n" +
    "        }\n" +
    "      }\n" +
    "      if (factors.indexOf('email_link') !== -1) {\n" +
    "        await attempt.attemptFirstFactor({ strategy: 'email_link', redirectUrl: window.location.origin + '/' });\n" +
    "        msg.className = 'msg';\n" +
    "        msg.textContent = 'CHECK YOUR EMAIL — a sign-in link is on its way.';\n" +
    "        btn.disabled = true;\n" +
    "        btn.textContent = 'LINK SENT';\n" +
    "        return;\n" +
    "      }\n" +
    "      msg.className = 'msg msg--bad';\n" +
    "      msg.textContent = 'REQUIRED: ' + (attempt.status || 'additional factor');\n" +
    "    } catch (err) {\n" +
    "      msg.className = 'msg msg--bad';\n" +
    "      var detail = (err && err.errors && err.errors[0]) ? err.errors[0].message : 'sign in failed';\n" +
    "      msg.textContent = 'REFUSED — ' + detail;\n" +
    "    }\n" +
    "    btn.disabled = false;\n" +
    "    btn.textContent = 'SIGN IN';\n" +
    "  });\n" +
    "})();" +
    "</script>"
  );
}

export function signInPage({ publishableKey, nonce }) {
  const v = encodeURIComponent(ASSET_VERSION);
  const content =
    '<div class="panel">' +
    '<form id="si-form" novalidate>' +
    '<div class="tagline"><span class="tagline__box">identity</span></div>' +
    '<label class="si__label" for="si-email">email</label>' +
    '<input class="si__field" id="si-email" type="email" name="identifier" ' +
    'autocomplete="username" autocapitalize="none" spellcheck="false" required>' +
    '<label class="si__label" for="si-pass">password</label>' +
    '<input class="si__field" id="si-pass" type="password" name="password" ' +
    'autocomplete="current-password" required>' +
    '<button class="btn" id="si-submit" type="submit">SIGN IN</button>' +
    '<p class="msg hidden" id="si-msg"></p>' +
    "</form>" +
    "</div>";

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>talvi — sign in</title>" +
    '<link rel="stylesheet" href="/s.css?v=' + v + '">' +
    '<script nonce="' + nonce + '" defer src="' + CLERK_JS_URL + '"></script>' +
    "</head><body>" +
    '<div class="scan" aria-hidden="true"></div>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    '<div class="frame"><div class="wrap">' +
    '<header class="head">' +
    '<h1 class="sign glitch"><a class="sign__link" href="/">talvi</a></h1>' +
    '<div class="tagline"><span class="tagline__box">status</span></div>' +
    '<div class="box"><p class="lede glitch" data-type>' +
    "SESSION CLOSED. Sign in to drop a file. Sharing stays public — a link " +
    "already sent keeps working.</p></div>" +
    "</header>" +
    '<main class="stack">' +
    content +
    "</main>" +
    "</div></div>" +
    bootstrapScript(nonce, publishableKey) +
    "</body></html>"
  );
}
