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

## Joining a test is a reviewed request, not an instant join

Modeled on a marketplace's "contact the owner" flow: a tester asks with a
short pitch (`message`, min 20 characters — device/OS, why they're a fit),
and the listing's owner accepts or declines before it becomes an active
test. No sign-in wall beforehand — `email`/`name` create or reuse an
account and a magic link is sent so the tester can come back and track it,
the same way a real sign-in does, just from a different entry point than
the "Sign in" button. A session moves through
`requested → accepted → submitted → completed`, or `requested → declined`.

Three builder- and tester-facing signals are computed from this
automatically on every read, never stored: a builder's **reliability**
(completion rate and average response time across all their listings,
hidden until they have `MIN_RESOLVED_FOR_RELIABILITY` resolved sessions),
their **contribution** (tests they completed on *other* people's apps), and
a rolling 30-day **leaderboard**. All three only ever count sessions a
listing owner confirmed by hand — see `lib/reputation.js` and
`routes/leaderboard.js`.

`/leaderboard` returns two boards over the same window: `testers` (everyone
who tested) and `contributors` (the same score narrowed to people who also
have something open, with their listings nested). Contribution is what
surfaces a listing in the showcase and in `?sort=contributors` — it is
earned by testing and cannot be bought, which is the whole point. The main
browse list still defaults to `newest` so a first listing from someone with
no history is not buried under the regulars.

Nothing about an app's *quality* is stored or scored here. The web client
re-derives listing health, rating and last-shipped from the public
catalogue as it renders each card (`web/views/community.js`), so those
numbers can never be inflated by whoever posted the listing.

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
| `/listings` | GET | — | `?kind=`, `?sort=newest\|contributors\|emptiest`. Public — browsing needs no account. |
| `/listings/mine` | GET | cookie | |
| `/listings/:id` | GET | — | Public detail page, includes the owner's reliability. |
| `/listings/:id/close` | POST | cookie, owner | |
| `/listings/:id/feature` | POST | cookie, owner | `{ days }`. Spends `3 × days` tokens. |
| `/listings/:id/request` | POST | optional* | `{ email, name, message }`. Can't request your own listing. |
| `/listings/:id/sessions` | GET | cookie, owner | Every request/session on this listing, for review. |
| `/test-sessions/mine` | GET | cookie | |
| `/test-sessions/:id/accept` | POST | cookie, owner | `requested → accepted`. Capped at `slots_wanted`. |
| `/test-sessions/:id/decline` | POST | cookie, owner | `requested → declined`. |
| `/test-sessions/:id/submit` | POST | cookie, tester | `{ feedback, bugFound?, wouldUseAgain? }`. |
| `/test-sessions/:id/complete` | POST | cookie, owner | Mints 1 token for the tester. |
| `/tokens/me` | GET | cookie | Balance and ledger history. |
| `/leaderboard` | GET | — | `?window=` days, default 30. Returns `testers` and `contributors`. |

\* If a session cookie is present it's used; otherwise `email`/`name` are required.

## Known limitation

Cross-origin cookies (`SameSite=None; Secure`) require both sides to be
served over HTTPS. Testing the full sign-in flow against a `http://localhost`
web app works once this Worker is deployed (it's always HTTPS on
`workers.dev`), but two `http://localhost` origins talking to each other
cannot carry the session cookie — that's a browser security rule, not a bug
here.
