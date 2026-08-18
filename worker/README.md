# Screenshot relay

The one exception to `web/`'s "no backend" rule, and why it's still true in
spirit: `itunes.apple.com` withholds `screenshotUrls` for some apps regardless
of country or endpoint, but the real product page at `apps.apple.com` embeds
the same images. That page sends no CORS headers, so a browser cannot fetch it
— a server has to. This Worker does exactly that one fetch and nothing else:
no accounts, no storage beyond a 12h edge cache of already-public URLs, no data
from the caller kept or logged.

It mirrors `src/appmates/core/clients/itunes.py::fetch_page_screenshots` —
same extraction, same graceful fallback to "found nothing" on any shape
mismatch, because a Cloudflare Worker can't share code with the Python
package.

## Deploy it yourself

```bash
cd worker
npm install
npx wrangler login      # opens a browser once, free Cloudflare account is enough
npx wrangler deploy
```

The last command prints the Worker's URL, something like:

```
https://launchpilot-screenshot-relay.<your-subdomain>.workers.dev
```

Paste that URL into `web/lib/itunes.js`, as the value of
`SCREENSHOT_RELAY_URL` near the top of the file. Until that constant is set,
the web app behaves exactly as before — screenshots the catalogue withholds
are reported as "not exposed", not fetched.

## Running it locally

```bash
npm run dev
```

Serves on `http://localhost:8787`. Test it with:

```bash
curl "http://localhost:8787/screenshots?id=6768688178&country=us"
```

## API

`GET /screenshots?id=<numeric App Store id>&country=<2-letter code, default us>`

Always returns `200` with `{"iphone": [...], "ipad": [...]}` — both arrays
empty when nothing was found, matching the CLI's "not exposed, not none
shipped" stance. `400` only for a malformed `id`/`country`.

## Cost

Cloudflare's free tier covers 100,000 requests/day. Nothing here needs a paid
plan.
