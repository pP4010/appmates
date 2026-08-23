# Security Policy

## Supported versions

This project ships from `main` — there are no maintained release branches.
Security fixes land on `main` and go out on the next deploy.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security report.

Email **appmates.contact@gmail.com** with:

- What you found and where (file/route/URL)
- Steps to reproduce, or a proof of concept
- What you think the impact is

You should get a response within **72 hours**. If the issue is confirmed,
we'll work on a fix and credit you in the changelog/release notes unless you'd
rather stay anonymous. Please give us a reasonable window to ship a fix before
any public disclosure.

## Scope

- `src/appmates/` — the open-source CLI and its core engines
- `web/` — the browser dashboard and landing page
- `worker/` — the App Store screenshot relay Worker

The community/marketplace backend (listings, testing sessions, auth,
tokens) has lived in a **separate, private repo**,
[`appmates-community`](https://github.com/pP4010/appmates-community), since
this repo's SaaS layer was split out — it has no `SECURITY.md` of its own,
so **reports about it go here too**, to the same email below. Don't assume
a path like `community/src/lib/auth.js` still exists in *this* repo when
reading old references to it; the equivalent file now lives at
`appmates-community/src/lib/auth.js`.

Findings in third-party dependencies should go to the dependency's own
maintainers, but feel free to also flag them here if this project is
exposed by the issue (e.g. via an outdated pin).

## What's in scope for reports

- Authentication/session handling (`appmates-community/src/lib/auth.js`)
- Anything that could read or write another user's data
- Token-balance manipulation (`appmates-community/src/lib/tokens.js`) —
  earning or spending outside the documented rules in that file
- CSRF or other request forgery against a signed-in session, in either repo
- XSS, injection, or request forgery in the web app or Workers
- Secrets or credentials exposed in either repo or a deployed response

## Out of scope

- Missing rate limits on routes that already require a signed-in session and
  only affect the reporter's own data
- Denial of service against Cloudflare's own infrastructure (report that to
  Cloudflare directly)
- Findings that require physical access to a user's device
