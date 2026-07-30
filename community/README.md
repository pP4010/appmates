# Community backend

Get real closed testers before a launch, and real users for a launch or an
update once one ships. This is the one part of AppMates with an account —
see `../web/views/community.js` and the callout in the Community view for why
that's scoped to exactly this feature and nothing else.

## What this deliberately is not

Nobody here trades App Store or Play reviews, and nothing on this page ever
asks a tester to leave one. Both stores' policies explicitly ban incentivised
or exchanged reviews, and this feature is designed to never come near that
line:

- **Tokens are earned only**, never purchased. The only way to get one is to
  actually test someone else's app.
- **Only a listing's owner can award a token**, by marking a tester's
  submitted feedback as `completed` — never the tester's own action. Nobody
  can credit themselves.
- **Feedback is private**, visible only to the listing's owner. It is never
  published anywhere, and nothing here is a public review.
- **Featuring a listing spends tokens on visibility**, not on reviews —
  identical in kind to a Product Hunt or BetaList placement.

## Stack

Cloudflare Worker + D1 (SQLite), magic-link email auth (no passwords), one
token ledger as the source of truth for balances. See `migrations/0001_init.sql`
for the full schema and the reasoning behind each table.

## Deploy it yourself

```bash
cd community
npm install
npx wrangler login          # skip if already logged in from worker/
npx wrangler d1 migrations apply launchpilot-community --remote
npx wrangler deploy
```

The last command prints the Worker's URL:

```
https://launchpilot-community.<your-subdomain>.workers.dev
```

Paste it into `web/lib/community.js` as `COMMUNITY_API_URL` (replacing
`null`). Until that's set, the "Get testers" nav item stays hidden and
nothing here is ever called.

### Email — the one step you can't skip

Magic links are sent via Cloudflare Email Service, which requires a domain
you control to be onboarded first:

```bash
npx wrangler email sending enable yourdomain.com
```

Then set `EMAIL_FROM_ADDRESS` in `wrangler.jsonc` to an address on that
domain (e.g. `noreply@yourdomain.com`). Until this is done, sign-in requests
fail with a clean 500 — the Worker never silently pretends an email was sent.

### CORS and cookies

Set `APP_ORIGIN` in `wrangler.jsonc` to wherever the web app is actually
served from. This isn't cosmetic: every response is locked to exactly this
one origin (not `*`), because these requests carry a session cookie —
`Access-Control-Allow-Origin: *` and credentialed requests are mutually
exclusive by design in every browser. Get this wrong and sign-in will look
like it silently does nothing.

## Local development

```bash
npm run dev
npx wrangler d1 migrations apply launchpilot-community --local
```

Add `DEV_EXPOSE_LINKS=true` to a local `.dev.vars` file (never committed) to
have `/auth/request-link` return the magic-link token directly in its JSON
response instead of emailing it — lets you test the whole sign-in flow
before a domain is onboarded for Email Sending. This flag does not exist in
`wrangler.jsonc`, so a real deploy can never accidentally leak a sign-in
link this way.

## API

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/auth/request-link` | POST | — | `{ email }`. Rate-limited to 5 per 15 min per email. |
| `/auth/verify` | GET | — | `?token=`. Single-use, 15 min TTL. Sets the session cookie and redirects into the app. |
| `/auth/logout` | POST | cookie | |
| `/auth/me` | GET | cookie | |
| `/apps` | POST | cookie | Upserts an app by `trackId`, keyed to the signed-in user. |
| `/apps/mine` | GET | cookie | |
| `/listings` | POST | cookie | `kind`: `testing` \| `launch`. |
| `/listings` | GET | — | `?kind=`. Public — browsing needs no account. |
| `/listings/mine` | GET | cookie | |
| `/listings/:id/close` | POST | cookie, owner | |
| `/listings/:id/feature` | POST | cookie, owner | `{ days }`. Spends `3 × days` tokens. |
| `/listings/:id/join` | POST | cookie | Can't join your own listing. |
| `/listings/:id/sessions` | GET | cookie, owner | Testers who joined, for review. |
| `/test-sessions/mine` | GET | cookie | |
| `/test-sessions/:id/submit` | POST | cookie, tester | `{ feedback }`. |
| `/test-sessions/:id/complete` | POST | cookie, owner | Mints 1 token for the tester. |
| `/tokens/me` | GET | cookie | Balance and ledger history. |

## Known limitation

Cross-origin cookies (`SameSite=None; Secure`) require both sides to be
served over HTTPS. Testing the full sign-in flow against a `http://localhost`
web app works once this Worker is deployed (it's always HTTPS on
`workers.dev`), but two `http://localhost` origins talking to each other
cannot carry the session cookie — that's a browser security rule, not a bug
here.
