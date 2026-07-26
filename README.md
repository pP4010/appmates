# LaunchPilot 🚀

[![CI](https://github.com/pP4010/launchpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/pP4010/launchpilot/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/pP4010/launchpilot/branch/main/graph/badge.svg)](https://codecov.io/gh/pP4010/launchpilot)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Checked with mypy](https://img.shields.io/badge/mypy-strict-2a6db2.svg)](https://mypy-lang.org/)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)

**Catch App Store and Google Play rejections before the stores do.**

You upload ten screenshots, wait, and App Store Connect replies
`IMAGE_TOOL_FAILURE` with no explanation. The actual cause is usually mundane —
a stray alpha channel, a resolution that was valid in 2019, a screenshot two
pixels too tall for Play's aspect ratio rule. LaunchPilot finds those in
milliseconds, tells you exactly which rule you broke, and can repair the files
for you.

```console
$ launchpilot validate-screenshots ./store/ios/en-US
Auto-detected target store: apple (override with --store)

  File                Size        Device            Findings
 ─────────────────────────────────────────────────────────────────────────────
  screen-01.png       1242×2688   iPhone 6.5"       ✗ APPLE_ALPHA_CHANNEL
                      2.9 MB      (legacy)            Image has an alpha channel (mode RGBA).
                                                      → Flatten onto an opaque background.
                                                    ! APPLE_LEGACY_SIZE
                                                      1242x2688 is absent from Apple's current table.
                                                      → Current equivalent is iPhone 6.5" (1284x2778).

  FAIL  10 file(s) checked against apple · 10 error(s) · 10 warning(s)
```

```console
$ launchpilot fix-screenshots ./store/ios/en-US --out ./store/ios/en-US-fixed
$ launchpilot validate-screenshots ./store/ios/en-US-fixed --strict
  PASS  10 file(s) checked against apple · 0 error(s) · 0 warning(s)
```

---

## Why it exists

Three things break releases, and all three are mechanically checkable:

| Problem | What LaunchPilot does |
|---|---|
| **Screenshots that violate a store rule** | Validates format, alpha channel, colour space, exact resolution, aspect ratio, file weight — and repairs all of them |
| **Listing text over a character limit** | Checks title/subtitle/description/keywords against both stores' limits, and warns *before* translation pushes you over |
| **Google Play's 12-testers-for-14-days gate** | Tracks the streak day by day, including the dips that silently reset your clock |

## Install

```bash
pip install -e ".[dev]"
```

Or with [uv](https://docs.astral.sh/uv/), which is what CI uses:

```bash
uv sync --extra dev
```

Try it without installing anything:

```bash
uvx --from . launchpilot specs
```

## Commands

### `validate-screenshots`

```bash
launchpilot validate-screenshots ./screenshots
launchpilot validate-screenshots ./screenshots --store google --strict
launchpilot validate-screenshots ./screenshots --json | jq '.assets[].findings[].code'
launchpilot validate-screenshots ./screenshots --ignore APPLE_LEGACY_SIZE
```

`--store` defaults to `auto`. App Store and Play screenshots are genuinely
different assets — every current Apple iPhone size violates Play's "long side
≤ 2× short side" rule — so validating one directory against both always
produces noise. LaunchPilot picks whichever store the files actually fit and
tells you which it chose. Use `--store both` when you want the cross-check anyway.

### `fix-screenshots`

```bash
launchpilot fix-screenshots ./screenshots                      # dry run: prints the plan
launchpilot fix-screenshots ./screenshots --out ./fixed        # writes repaired copies
launchpilot fix-screenshots ./screenshots --out ./fixed \
    --target apple-iphone-6.9 --background "#0B0B0F"
```

Flattens alpha onto an opaque background, converts to sRGB, resizes to the
nearest valid spec size, and re-encodes anything over the weight limit.

**Your originals are never touched.** The fixer refuses to write into its own
source directory, and refuses a non-empty output directory without `--force`.
Resizing letterboxes rather than stretches — a distorted UI screenshot looks
broken to reviewers.

### `check-testers`

```bash
launchpilot check-testers --days-passed 9 --active-testers 12
launchpilot check-testers --from-file tester-history.json
launchpilot check-testers -d 20 -t 12 --release-pending
```

```
╭─ Google Play · Closed testing ───────────────────────────────╮
│          Status  NOT YET ELIGIBLE                            │
│         Testers  12 / 12                                     │
│ Continuous days  9 / 14                                      │
│        Progress  ████████████░░░░░░░░  64.3%                 │
│  Projected date  2026-07-31                                  │
╰──────────────────────────────────────────────────────────────╯
```

The requirement is 12 testers opted in **continuously** for 14 days. The word
that costs people two weeks is *continuously*: if your count drops to 11 on day
nine, Google restarts the clock. Pass a day-by-day timeline with `--from-file`
and LaunchPilot detects the reset:

```json
[
  { "date": "2026-07-01", "opted_in": 12 },
  { "date": "2026-07-02", "opted_in": 11 },
  { "date": "2026-07-03", "opted_in": 13 }
]
```

The flat `--days-passed` form cannot see a dip by construction, and the output
says so rather than quietly implying you are fine.

### `validate-metadata`

```bash
launchpilot validate-metadata listing.toml
launchpilot validate-metadata listing.json --store apple --strict
```

```toml
[[locales]]
locale = "en-US"
title = "Kaizen: Habits"
subtitle = "Small steps, big change"
short_description = "Track habits and build streaks."
description = "Kaizen helps you build lasting habits."
keywords = "habit,streak,focus,routine"
```

Checks Apple (30/30/170/4000/100) and Play (30/80/4000) limits, flags fields
above 90% of their limit because translations run longer than English, and
catches the Apple keyword traps — spaces after commas waste your 100-character
budget, and repeating title words wastes indexing.

### `specs`

```bash
launchpilot specs --store apple
launchpilot specs --json
```

Prints the bundled specification catalogue with a `last_verified` date and the
source URL for each store, so you can see how stale the data is.

## Use it in CI

Every command exits `0` clean, `1` on findings, `2` on a usage error.

```yaml
- name: Validate store assets
  run: |
    launchpilot validate-screenshots ./store/ios --store apple --strict
    launchpilot validate-metadata ./store/listing.toml
```

`--json` emits the same Pydantic models the planned HTTP API will return, so
anything you build against it now keeps working later.

## Web checker (no install, no upload)

`web/` is a zero-backend version of the screenshot checks: drag files in, get
the same finding codes, download repaired copies. Nothing is uploaded and no
server does any work — every rule LaunchPilot applies reads the file's *header*,
not its pixels, so a few hundred bytes answer the question locally.

```bash
python3 -m http.server 8000 --directory web
```

It is kept honest rather than kept in sync by hand: the specification data is
generated from the same YAML the CLI reads, and the JavaScript engine is tested
against the Python one on 925 cases plus a set of real images parsed by Pillow.
CI fails if any generated file is stale. See [web/README.md](web/README.md).

## Architecture

```
src/launchpilot/
├── cli/            # Typer commands: argument parsing and rendering only
└── core/
    ├── specs/      # ← versioned YAML spec catalogue + registry
    ├── models/     # Pydantic contracts (Finding, Severity, reports)
    └── services/   # the actual logic

web/                # browser checker, generated from and tested against the above
scripts/            # generators for the web artefacts (run with --check in CI)
```

Three decisions worth knowing about:

**Specs are data, not code.** `core/specs/*.yaml` holds every resolution and
constraint, each entry tagged `required` / `accepted` / `legacy` / `deprecated`
with a source URL and verification date. Store rules drift constantly; updating
them must never require a code change. `registry.py` is the only access point,
so moving this to a database later touches one module.

**Findings carry stable machine codes.** `APPLE_ALPHA_CHANNEL`,
`PLAY_MAX_TWICE_MIN`, and friends are part of the public contract — CI
annotations, `--ignore`, and the fixer all key off them.

**The CLI holds no logic.** Every command calls a core service that returns a
Pydantic model. The CLI renders it; `--json` serialises it; FastAPI will return
it. One implementation, three surfaces.

## Development

```bash
uv sync --extra dev
uv run pytest              # 174 tests, coverage gate at 85%
uv run ruff check .
uv run ruff format .
uv run mypy                # strict
```

Test images are generated at run time with Pillow rather than committed —
binary fixtures cannot be diffed in review, and they hide the very properties
(mode, size, alpha) each test is about.

## Roadmap

### Open source core

- [x] Screenshot validation for App Store and Play
- [x] Automatic repair (alpha, colour space, resolution, weight)
- [x] Listing text validation for both stores
- [x] Closed-testing streak tracking with reset detection
- [x] JSON output and CI exit codes
- [x] Zero-backend web checker with browser-side repair
- [ ] `launchpilot init` — scaffold a `launchpilot.toml` per project
- [ ] Play graphic assets (icon, feature graphic) as first-class checks
- [ ] Device-frame screenshot generation
- [ ] GitHub Action wrapper + SARIF output for inline PR annotations
- [ ] Publish to PyPI

### SaaS layer

- [ ] **FastAPI service** over the same core models — the `--json` payloads are already the API contract
- [ ] **Live store integration**: App Store Connect (JWT ES256) and Play Developer API behind the existing `TesterDataSource` protocol
- [ ] **Hosted spec catalogue** so rule changes ship without a release
- [ ] **Release dashboard**: submission status, review times, rejection history across both stores
- [ ] **Alerting** on closed-testing streak breaks — the failure this tool exists to prevent
- [ ] **Multi-app / team workspaces**

The open-source CLI stays fully functional standalone. The SaaS adds hosting,
history and live store credentials — never a gate on the local checks.

## Contributing

Issues and PRs welcome. When a store changes a rule, the fix is usually a
one-line edit to `src/launchpilot/core/specs/*.yaml` plus a bump of
`last_verified` — please include the source URL.

## License

MIT — see [LICENSE](LICENSE).

## Sources

Specifications are transcribed from, and dated against, the official docs:

- [App Store Connect — Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)
- [Google Play — Graphic asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
- [Google Play — App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
