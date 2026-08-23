# Launch readiness

Read this whenever asked "is AppMates ready to be public, secure, and good
open source?" — it's the running answer, updated as items get done. Don't
re-derive this from scratch; update this file instead when something on it
changes.

Last updated: 2026-08-23 — repo is now public.

## Public accessibility

- [x] **Private-preview gate removed** (2026-08-23) — `web/functions/
  _middleware.js` deleted outright, not just bypassed. The site is now
  public: no password, no cookie, first request in serves the app directly.
  Any `SITE_PASSWORD`/`GATE_KEY` values still sitting in the Cloudflare
  Pages project's env vars are now inert leftovers — safe to remove from
  the dashboard whenever, not required.
- [x] Deploy path: `scripts/deploy-web.sh` (`cd web && wrangler pages
  deploy .`) is still the one supported way to deploy — running from the
  repo root with `web` as the project arg silently skips `web/functions/`,
  which matters again the moment any other Pages Function gets added.
- [x] Real accessibility pass done this session (`read_page` accessibility
  tree + manual review of landing, forms, tables, light/dark). Found and
  fixed two real WCAG issues:
  - Muted text colour (`--muted`) was `#8a8a97` on light background —
    ~3.4:1 contrast, fails WCAG AA (4.5:1) for body-sized text. Changed to
    `#6e6e79` (~5:1). `web/styles.css`.
  - Data tables (`web/views/shared.js` table builder, `web/index.html`
    leaderboard) had `<th>` with no `scope="col"` — screen readers can't
    reliably tie header to data cell. Fixed both.
  - Form inputs already correctly labelled (`<label for>` or `aria-label`)
    everywhere checked — no issue there.
  - **Not exhaustive**: this was a manual pass, not a full Lighthouse/axe
    automated run (no such tool available in this session's browser
    tooling). Worth running a real axe-core/Lighthouse pass before calling
    the site WCAG-compliant, not just "checked."
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
  continues) — read the actual failure log rather than assumed.
  **SARIF upload confirmed working** (2026-08-23, post-public): re-ran
  run `32650023584` after flipping the repo public — both `Analyze
  (python)` and `Analyze (javascript-typescript)` jobs completed
  `success`, including the `Upload SARIF` step that used to fail with
  "Code scanning is not enabled for this repository" while private. No
  config change needed, it just started working the moment the repo went
  public — matches what was predicted below before this was verified.
- [x] `SECURITY.md` — vulnerability disclosure policy, contact
  `appmates.contact@gmail.com`.
- [x] Full git-history secret scan run this session (`git log --all -p`
  grepped for API keys, PEM blocks, AWS keys, password/secret literals):
  **zero real credentials ever committed**, in this repo's history or the
  removed `community/` history before the split below. No key rotation
  needed.
- [x] Preview-gate password check
  (`web/functions/_middleware.js`) was a plain `===` string compare —
  timing-attack surface. Replaced with a SHA-256-digest constant-time
  compare (fixed-length digests either side, no early exit on length or
  byte position).
- [x] **`community/` (SaaS backend: token economy, anti-abuse rules,
  admin auth) split out of this repo into a separate private repo,
  [`appmates-community`](https://github.com/pP4010/appmates-community)** —
  done this session. Reasoning: no secrets were in it, but the exact
  anti-abuse thresholds and rate-limit values are a real target for anyone
  wanting to game the token economy once this repo is public; publishing
  that logic isn't just "obscurity," it's handing out the anti-abuse
  playbook. History was preserved into the new repo via `git subtree
  split`, then fully purged from this repo's history via `git filter-repo`
  (safe to rewrite — this repo was still private throughout). Cloudflare
  Worker secrets are unaffected (`wrangler secret` is tied to the Worker
  name, not the repo) — no re-provisioning needed, deploy from a fresh
  clone of the new repo.
- [x] **Secret scanning / push protection**: enabled 2026-08-23 via
  `PATCH /repos/pP4010/appmates` (`security_and_analysis.secret_scanning`
  and `.secret_scanning_push_protection`, both `status: enabled`) —
  confirmed live via the same endpoint read back. `secret_scanning_
  validity_checks` stayed `disabled` after the same request (GitHub didn't
  turn it on); not investigated further since it's an enhancement over
  the base scan, not a gap versus the plan before this.
- [x] **Branch protection on `main`**: decided this session — **keep
  disabled**. Every deploy this whole project has used is `git push`
  straight to `main` followed by an immediate `wrangler deploy` — turning
  on "require a PR before merging" would block that exact workflow.
  Deliberate choice, not an oversight. Revisit if outside contributors
  start merging directly.
- [x] **Repo is public** (flipped 2026-08-23, on explicit request — `gh repo
  edit pP4010/appmates --visibility public
  --accept-visibility-change-consequences`, confirmed via
  `GET /repos/pP4010/appmates` → `"private": false`). Secret scanning, push
  protection, and CodeQL SARIF upload all came on automatically as
  predicted, no separate action needed for any of them.
- [ ] No CAPTCHA/bot-check on the anonymous `listings.request` flow beyond
  the new per-IP rate limit — acceptable for now, worth revisiting if abuse
  shows up in practice once there's real traffic. This route lives in
  `appmates-community`, not this repo.
- [x] **`appmates-community` had zero CI** — added this session:
  `.github/workflows/ci.yml` (`node --test`, `wrangler deploy --dry-run`)
  and `.github/workflows/codeql.yml` (javascript-typescript, same
  private-repo `upload: false` + `continue-on-error` shape as this repo
  used before going public — that repo is staying private, so its SARIF
  upload will keep no-oping the same way this repo's did pre-flip).
  Verified locally before commit: 37/37 tests pass, dry-run resolves every
  binding cleanly. Pushed and deployed to production
  (`launchpilot-community`, version `b609963c`) the same session as a
  batch of real fixes: CSRF guard added to 7 routes that were missing it
  (`testSessions.accept/decline/complete`, `listings.close`,
  `messages.mute/unmute`, `auth.logout`), a TOCTOU race in `spendTokens`
  closed with a guarded atomic UPDATE, and a rate limiter added to
  `/auth/verify`. Smoke-tested against production post-deploy (forged
  cross-site `Origin` on `/auth/logout` → `403`, confirming the new guard
  is live, not just committed).

## Open source hygiene

- [x] `LICENSE` (MIT), root `README.md` with Install/Commands/Contributing/
  Roadmap sections already in decent shape.
- [x] `.env.example` present, `.gitignore` covers real secrets and local
  Wrangler state (`/.wrangler/`, `web/.wrangler/`). `community/` entries
  removed from `.gitignore` this session — that directory is no longer
  part of this repo at all (see below).
- [x] `SECURITY.md` added (see above).
- [x] `CODE_OF_CONDUCT.md` added this session (Contributor Covenant 2.1).
- [x] `CONTRIBUTING.md` written this session as its own file (dev setup,
  checks to run before a PR, code style, security-report pointer).
  `README.md`'s Contributing section now links to it.
- [x] Issue/PR templates added this session:
  `.github/ISSUE_TEMPLATE/bug_report.md`,
  `.github/ISSUE_TEMPLATE/feature_request.md`,
  `.github/PULL_REQUEST_TEMPLATE.md`.
- [x] **Architectural decision resolved**: `community/` (the full SaaS
  backend — token economy, anti-abuse rules, auth) has been split into its
  own private repo, `appmates-community`, with history preserved and
  purged from this repo (see Security section above for the full
  reasoning and mechanics). This repo now only contains the CLI core and
  the static `web/` + `worker/` (screenshot relay, no business logic).
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

## Status: public, live, structurally done

Repo went public 2026-08-23. What's left is genuinely optional, nothing
blocking:

1. A real automated a11y run (Lighthouse/axe) is still recommended, not
   just the manual pass done earlier this session (see Public
   accessibility above) — no such tool was available in-session to run it.
2. No CAPTCHA/bot-check on `appmates-community`'s anonymous
   `listings.request` flow — acceptable until real abuse shows up.
3. Not published to PyPI — roadmap item, not a security or hygiene gap.
4. English only — fine unless multi-language becomes an actual goal.
5. Optional cleanup, not blocking: the Worker in `appmates-community` is
   still internally named `launchpilot-community` (`wrangler.jsonc`'s
   `name` field) — a leftover from the project rename, cosmetic only.
6. Both repos' CodeQL workflows pin `codeql-action@v3`, which GitHub has
   flagged for deprecation in December 2026 — noticed via a build
   annotation while verifying the post-public SARIF upload, not yet acted
   on. Bump to `v4` sometime before then.
