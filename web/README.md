# LaunchPilot web checker

A zero-backend version of the CLI. Two tools, both with nothing uploaded, no
account, and no server doing any work:

* **Screenshots** — drag files in, get the same findings the CLI produces, and
  download repaired copies.
* **Keyword field** — audit the 100-character App Store field as you type, see
  which phrases you can actually rank for, and get a rebuilt field.

## Why there is no backend

Almost every rule LaunchPilot applies is a property of the file's *header*:
dimensions, colour type, alpha channel, byte size. None of it needs the pixels,
so none of it needs to leave the machine. Reading a few hundred header bytes in
the browser answers the question a multi-megabyte upload would have answered,
instantly and privately.

That is not only cheaper, it is more correct. A fully opaque RGBA PNG is still
rejected by App Store Connect, so sampling pixels on a canvas to look for
transparency would give the wrong answer. The PNG colour-type byte gives the
right one.

## Running it

Any static file server. There is no build step.

```bash
python3 -m http.server 8000 --directory web
```

Then open <http://localhost:8000>. Deploy by copying `web/` to any static host.

## Keeping it honest

The browser reimplements rule logic that already exists in Python. Two
implementations of the same rules drift, so the drift is made to fail loudly.

**Specification data is generated, never retyped.** `lib/specs.json` comes from
`src/launchpilot/core/specs/*.yaml` via `scripts/export_specs.py`. The numbers
that actually change when a store updates its rules exist in exactly one place.

**Rule logic is tested against Python.** `scripts/export_conformance.py` runs the
Python implementations across a grid of inputs and records what they produced;
`test/conformance.test.js` asserts the JavaScript engines return identical
results for all 939 cases — finding codes, statuses and device classes for
screenshots, and codes, character costs, coverage and rebuilt fields for the
keyword engine.

**Header parsing is tested against Pillow.** Rules are only as correct as the
facts they run on. `scripts/export_parser_fixtures.py` writes tiny real images
and records what Pillow reads from them; `test/parser.test.js` asserts the JS
parser agrees — including the palette PNG whose transparency hides in a `tRNS`
chunk rather than the colour-type byte.

CI fails if any generated file is stale, so editing a YAML spec without
regenerating cannot ship.

```bash
uv run python scripts/export_specs.py            # regenerate after a spec change
uv run python scripts/export_conformance.py
uv run python scripts/export_parser_fixtures.py

node --test "web/test/*.test.js"                 # 24 tests
```

## Why repaired files come out as JPEG

`canvas.toBlob('image/png')` emits a 32-bit RGBA PNG even when every pixel is
opaque. A "fixed" PNG would therefore still carry the alpha channel that got the
screenshot rejected — fixing nothing. JPEG cannot represent alpha at all, so the
output is clean by construction, and both stores accept it.

The CLI uses Pillow and writes genuine alpha-free PNGs, so `launchpilot
fix-screenshots` remains the answer when PNG specifically is required.

## Layout

```
web/
├── index.html          # markup and styles
├── app.js              # UI wiring only — no rules live here
├── lib/
│   ├── image-facts.js  # PNG/JPEG header parsing (mirrors read_facts)
│   ├── validator.js    # screenshot rules (mirrors ScreenshotValidator)
│   ├── keywords.js     # keyword field engine (mirrors KeywordBuilder)
│   ├── fixer.js        # canvas repair (mirrors ScreenshotFixer)
│   ├── zip.js          # stored-entry ZIP writer for batch download
│   └── specs.json      # GENERATED — do not edit
└── test/
    ├── conformance.test.js  # JS engine ≡ Python engine
    ├── parser.test.js       # JS parser ≡ Pillow
    ├── zip.test.js
    ├── conformance-cases.json  # GENERATED
    └── fixtures/               # GENERATED
```

## A note on porting the keyword engine

Two things bit during the port and are worth knowing before editing
`lib/keywords.js`:

**JavaScript's `\w` is ASCII-only.** Python's `re.UNICODE` keeps "café" whole;
a literal port splits it into "caf" and "é", which silently changes which
phrases count as covered on any non-English storefront. The tokeniser uses
`\p{L}\p{N}` with the `u` flag instead, and a conformance case exists purely
to hold that line.

**Finding order comes from insertion order.** The Python side iterates a dict
built by walking the field left to right, so the JS side uses a `Map` rather
than a plain object — object key ordering would reorder numeric-looking
keywords and break the comparison for reasons that have nothing to do with the
rules.
