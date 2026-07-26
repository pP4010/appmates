# LaunchPilot web app

Every LaunchPilot tool, running in the browser. Nothing is uploaded, there is no
account, and no server of ours is involved at any point.

| Tool | Needs the network? |
|---|---|
| **Screenshots** — validate and repair | no |
| **Keyword field** — audit the 100 characters | no |
| **Listing text** — both stores' field limits | no |
| **Niche** — is this market worth entering | yes |
| **Markets** — which storefront it is winnable in | yes |
| **Competitors** — the field, their screenshots, shared vocabulary | yes |
| **Rank** — your position per keyword | yes |
| **Play testers** — the 12-for-14-days gate | no |
| **Specs** — the bundled catalogue and its provenance | no |

## Running it

Any static file server. There is no build step.

```bash
python3 -m http.server 8000 --directory web
```

Deploy by copying `web/` to any static host.

## Why there is no backend

Two independent reasons, and both are load-bearing.

**The offline tools read headers, not pixels.** Dimensions, colour type, alpha
channel, byte size — none of it needs the image data, so none of it needs to
leave the machine. It is also more correct than the obvious alternative: a fully
opaque RGBA PNG is still rejected by App Store Connect, so sampling canvas
pixels for transparency would give the wrong answer where the PNG colour-type
byte gives the right one.

**The market tools call Apple directly.** The public catalogue endpoint answers
with `access-control-allow-origin: *`, so the page can query it from the browser.
No proxy, no API key, no request of yours passing through anything we run.

## Keeping it honest

The browser reimplements logic that already exists in Python. Two
implementations of the same rules drift, so the drift is made to fail loudly.

**Specification data is generated, never retyped.** `lib/specs.json` is projected
from `src/launchpilot/core/specs/*.yaml` by `scripts/export_specs.py` — store
sizes, scoring curves and weights, field limits, word lists, storefront names.
The numbers that change when a store updates a rule exist in exactly one place.

**Every engine is tested against its Python original.** `scripts/export_conformance.py`
runs the Python implementations across a grid of inputs and records what they
produced; `test/conformance.test.js` asserts the JavaScript returns the same
thing:

| Engine | What is compared |
|---|---|
| Screenshot rules | finding codes, status, device class — 939 cases |
| Keyword field | codes, per-word character costs, coverage, rebuilt field |
| Niche scoring | winnability, verdict, and every signal's observation, score, band and rationale sentence |
| Closed testing | eligibility, streak, reset detection, blocker codes, projected date |
| Competitors | iPhone/iPad counts, screenshot strategy, extracted terms |

**Header parsing is tested against Pillow.** Rules are only as correct as the
facts they run on, so `test/parser.test.js` asserts the JS parser reads real
images the same way Pillow does — including the palette PNG whose transparency
hides in a `tRNS` chunk rather than the colour-type byte.

CI fails if any generated file is stale.

```bash
node --test "web/test/*.test.js"     # 47 tests
```

## Two things the catalogue does that took finding

**`?id=X&country=us` returns no CORS headers at all.** `?id=X` alone answers
with `access-control-allow-origin: *`, and adding `country` silently drops it,
so the browser blocks the response and reports an opaque "Failed to fetch". The
client omits `country` for numeric ids — a track id already identifies one app
across every storefront, and the parameter only varies pricing fields nothing
here reads. The Python client does the same, so both send identical requests.

**A 200-result page is about 1.5 MB.** The endpoint returns every field it has,
including full descriptions and device lists, with no way to ask for less. That
is fine on a desktop connection and not fine on a phone or behind a proxy that
caps response bodies. Rather than quietly lowering the page size for everyone —
which would change the competitive-depth score and break parity with the CLI —
the full page is attempted first and a fallback is **reported in the output**, so
a smaller sample is visible rather than mistaken for a thinner market.

## Layout

```
web/
├── index.html          # shell and views
├── styles.css
├── app.js              # routing and boot only
├── lib/                # engines, each mirroring a Python service
│   ├── image-facts.js  # PNG/JPEG headers      ← read_facts
│   ├── validator.js    # screenshot rules      ← ScreenshotValidator
│   ├── fixer.js        # canvas repair         ← ScreenshotFixer
│   ├── keywords.js     # keyword field         ← KeywordBuilder
│   ├── metadata.js     # listing limits        ← MetadataValidator
│   ├── market.js       # niche + markets       ← market_analyzer, market_scanner
│   ├── competitors.js  # competitors + rank    ← competitor_analyzer
│   ├── testers.js      # closed testing        ← google_play
│   ├── itunes.js       # catalogue client      ← clients/itunes
│   ├── zip.js          # batch download
│   └── specs.json      # GENERATED — do not edit
├── views/              # one module per tool; rendering only
└── test/
```
