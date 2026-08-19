# Launch readiness

Read this whenever asked "is AppMates ready to be public, secure, and good
open source?" — it's the running answer, updated as items get done. Don't
re-derive this from scratch; update this file instead when something on it
changes.

Last updated: 2026-08-20.

## Public accessibility

- [x] Site is reachable with no login wall — `web/functions/_middleware.js`'s
  private-preview gate exists and has real secrets configured
  (`SITE_PASSWORD`, `GATE_KEY` in Cloudflare Pages), but only actually goes
  live if deployed with `wrangler pages deploy .` from inside `web/` — every
  deploy so far has used `wrangler pages deploy web` from the repo root,
  which skips the `functions/` directory entirely and leaves the gate off.
  **Decide, don't assume**: if you ever deploy from inside `web/`, the gate
  turns on and locks everyone out until you either enter the password or
  redeploy the other way.
- [ ] Real accessibility (WCAG) audit never run. Labels/ARIA look reasonable
  on inspection but nobody has run Lighthouse/axe against it. Do that before
  claiming the site is accessible in the disability-access sense.
- [ ] English only. Fine unless multi-language is actually a goal.
- [x] Mobile responsive down to ~375px — checked manually this session
  (dashboard sidebar collapse, sponsor tape, landing rails↔tape swap).

## Security

- [x] Rate limiting on every route reachable without an existing session:
  the iTunes relay (`ITUNES_LOOKUP_LIMITER`/`ITUNES_SEARCH_LIMITER`) and now
  `listings.create`/`listings.request`
  (`LISTINGS_CREATE_LIMITER`/`LISTINGS_REQUEST_LIMITER`) — all in
  `community/wrangler.jsonc`, checked via `withinLimit` in `lib/http.js`.
- [x] Magic-link issuance already rate-limited per email
  (`community/src/lib/auth.js`, 5 per 15 min) with a generic response so the
  limit itself can't be probed.
- [x] CSP + security headers live (`web/_headers`) — verified via `curl -I`
  against production. No `unsafe-inline` on script-src.
- [x] SQL is parameterized everywhere (`.bind()`), HTML output escaped
  (`escapeHtml`) everywhere checked.
- [x] Secrets are all in `wrangler secret` / Pages secrets, never committed
  or in a `vars` block.
- [x] Dependabot alerts + automated security fixes: turned on via the GitHub
  API (`PUT /repos/.../vulnerability-alerts`,
  `PUT /repos/.../automated-security-fixes`) — confirmed live, already
  opened PRs for outdated deps within a minute of enabling.
- [x] `.github/dependabot.yml` — weekly, covers pip (root), npm
  (`community/`, `worker/`), github-actions.
- [x] `.github/workflows/codeql.yml` — JS/TS + Python, push/PR/weekly.
  Both jobs verified green on a real push
  (github.com/pP4010/appmates/actions/runs/32307500145). Took two fixes to
  get there: the workflow needed `actions: read` (codeql-action's own
  telemetry call was failing without it, and GitHub marks a step failed on
  that error annotation alone even though the process catches it and
  continues) — read the actual failure log rather than assumed. **Known,
  accepted limitation**: the upload-sarif step (`continue-on-error: true`)
  fails every run with "Code scanning is not enabled for this repository" —
  confirmed exact cause: that needs GitHub Advanced Security, which a
  *private* repo doesn't have without paying for it. Analysis itself always
  runs and always succeeds; only the Security-tab upload is blocked. Once
  this repo is public (free) or GHAS is purchased, that step starts
  succeeding on its own — nothing to flip back by hand.
- [x] `SECURITY.md` — vulnerability disclosure policy, contact
  `appmates.contact@gmail.com`.
- [ ] **Secret scanning / push protection**: confirmed unavailable via API
  (`422 Secret scanning is not available for this repository`) — needs the
  repo to go public (free then) or GitHub Advanced Security (paid) while
  private. Nothing to configure until one of those changes.
- [ ] **Branch protection on `main`**: deliberately not enabled. Every
  deploy this whole project has used is `git push` straight to `main`
  followed by an immediate `wrangler deploy` — turning on "require a PR
  before merging" would block that exact workflow. This is a product
  decision (accept slower/gated pushes vs. keep the current direct-push
  habit), not a default to just flip on. If you want it: requiring status
  checks to pass is the low-friction option; requiring PR review is the
  strict one and changes how deploys happen day to day.
- [ ] Repo is currently **private**. Secret scanning (above) and free
  CodeQL upload (above) both unlock automatically the moment it's public —
  no separate action needed for either once that decision is made.
- [ ] No CAPTCHA/bot-check on the anonymous `listings.request` flow beyond
  the new per-IP rate limit — acceptable for now, worth revisiting if abuse
  shows up in practice once there's real traffic.

## Open source hygiene

- [x] `LICENSE` (MIT), root `README.md` with Install/Commands/Contributing/
  Roadmap sections already in decent shape.
- [x] `.env.example` present, `.gitignore` covers real secrets and local
  Wrangler state (`/.wrangler/`, `web/.wrangler/`, `community/.dev.vars`).
- [x] `SECURITY.md` added (see above).
- [ ] No `CODE_OF_CONDUCT.md` — standard expectation once outside
  contributions are welcome. Not written yet.
- [ ] `CONTRIBUTING.md` is 3 lines inside the README, not its own file.
  Fine solo; expand once real outside contributors show up (dev setup,
  code style, PR expectations).
- [ ] No issue/PR templates (`.github/ISSUE_TEMPLATE/`,
  `.github/PULL_REQUEST_TEMPLATE.md`). Nice-to-have, not blocking.
- [ ] **Real architectural decision, unresolved**: `community/` (the full
  SaaS backend — token economy, anti-abuse rules, auth) lives in the same
  repo as the open-source CLI core. The README's own Roadmap already splits
  "Open source core" from "SaaS layer" as a concept — but the repo itself
  doesn't reflect that split. Going public with the repo as-is means
  publishing the SaaS backend's exact logic too. Decide before making the
  repo public: split `community/` into its own private repo, or accept
  publishing it (which is a legitimate "open core" choice too, just should
  be made on purpose).
- [ ] Not published to PyPI — already on the project's own roadmap as
  unchecked, not newly discovered here.
- [x] Repo renamed `launchpilot` → `appmates` (2026-08-20). GitHub redirects
  the old URL for git and API access — confirmed with `git ls-remote` and
  an authenticated `gh api repos/pP4010/launchpilot` call, both resolving
  to the new repo. Local `origin` remote updated; the 4 in-repo references
  (README's CI + codecov badges, `pyproject.toml`'s Homepage/Issues, the
  footer links in `web/app.html` and `web/index.html`) updated to match.
  Local folder is still named `launchpilot` on disk — cosmetic only, safe
  to `mv` any time (git doesn't care what its containing folder is named);
  recreate `.venv` after (`uv sync`) since some of its scripts hardcode the
  old absolute path.

## What to check before flipping "public"

1. Decide the `community/` split (above) — do this *before* making the repo
   public, not after; you can't un-publish history.
2. Decide branch protection (above).
3. Run a real a11y pass (Lighthouse/axe) if that matters for launch.
4. Make the repo public → secret scanning and CodeQL upload both start
   working with no further action.
5. Update `README.md`/in-app footer links if the repo got renamed in the
   meantime (see rename discussion referenced above).
