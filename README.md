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
| **A keyword field quietly wasting a third of its budget** | Audits the 100 characters Apple never shows anyone, and rebuilds them |
| **Building an app into a market that cannot be won** | Scores a niche from the public catalogue before you write any code |
| **Designing screenshots with no idea what the field does** | Summarises competitors' screenshot conventions, and saves theirs for reference |
| **No idea whether your listing is indexed at all** | Reports your position per keyword and tracks it over time, locally |
| **Launching into the one storefront where the term is locked** | Scores the same keyword across 14 storefronts and ranks them |

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

### `niche`

```bash
launchpilot niche "habit tracker" "morning routine" --country fr
launchpilot niche "sourdough starter log" --leaders
launchpilot niche "budget app" --json | jq '.keywords[0].verdict'
```

```
Keyword                     score  verdict     credible competitors
bouldering training log      76.1  OPEN         3
sourdough starter log        66.3  OPEN         1
gratitude journal            39.2  CONTESTED   32
habit tracker                30.8  LOCKED      49
photo editor                 16.2  LOCKED     149
```

Answers the question the established ASO tools structurally cannot: **should I
build this at all?** Rank trackers and keyword optimisers assume a live app — you
cannot track the ranking of something that does not exist. This runs before the
first line of code, on the public App Store catalogue, with no account and no API
key.

**There is deliberately no "search volume" number.** Apple has never published
per-keyword search counts. The Search Ads popularity index that other tools
relabel as volume is a relative score with no published methodology, and in
September 2025 the number of US keywords scoring above the floor
[dropped 77% in four days](https://respectaso.com/blog/apple-search-ads-popularity-unreliable-aso-keyword-data/)
when Apple changed something and told nobody. Every number LaunchPilot prints is
something it counted.

Six signals, each shown with its raw observation so you can disagree with the
weighting and still trust the facts:

| Signal | What it observes | Why it matters |
|---|---|---|
| **Leader entrenchment** | median ratings of the top 10 | You can out-design a competitor in a quarter; you cannot out-accumulate ten years of reviews |
| **Credible competitors** | apps with >1,000 ratings | Not how many apps exist — how many actually hold the position |
| **Incumbent neglect** | median days since the leaders shipped | A neglected market is an opening; weekly releases mean a funded team defending it |
| **User dissatisfaction** | median stars of the leaders | 4.9★ incumbents give users no reason to switch; 3.6★ is a product opening |
| **Keyword under-targeting** | share of leaders with the term in their name | Leaders ranking *incidentally* means the term is takeable by simply targeting it |
| **Publisher concentration** | share of slots held by repeat publishers | One studio holding several slots is cross-promotion you cannot outspend |

The weights, curves and thresholds all live in
[`core/specs/market.yaml`](src/launchpilot/core/specs/market.yaml) with the
reasoning written next to each number. Edit them and re-run.

> **On the raw result count.** An earlier revision scored saturation from the
> number of apps the store returns. Measured across eight keywords spanning
> *photo editor* to *sourdough starter log*, it returned 162–191 every time — a
> standard deviation of 9, because the store pads every result page with loosely
> related apps. Three unrelated markets scored 45, 46 and 47. Counting only apps
> with real traction separates the same keywords by 1 to 149. The result count is
> still reported as context, but it is not scored.

### `markets`

```bash
launchpilot markets "habit tracker"
launchpilot markets "budget app" --countries us,fr,de,jp,br
launchpilot markets "gratitude journal" --json | jq '.best_country'
```

```
habit tracker across 8 storefront(s)

  Storefront            Score              Verdict     Credible rivals
  France          FR       51  ██████░░░░  CONTESTED                12
  Italy           IT       50  ██████░░░░  CONTESTED                15
  Japan           JP       48  ██████░░░░  CONTESTED                23
  Germany         DE       41  █████░░░░░  CONTESTED                36
  United States   US       31  ████░░░░░░  LOCKED                   49

  This term is CONTESTED in France and LOCKED in United States.
  Which storefront you lead with is a bigger lever here than anything you
  can do to the listing itself.
```

Every ASO tool asks *how hard is this keyword?* as though there were one answer.
There are 175 storefronts and the answer differs in each — difficulty tracks the
**language a term is searched in** more than the size of the country. "habit
tracker" faces 49 credible rivals in the US and 12 in France.

That makes it a launch decision — which locale to write first, which language to
localise screenshots into — and almost nobody asks it before shipping. It uses
the same six signals as `niche`, one storefront at a time.

The summary keys off whether the **verdict** changes, not the numeric spread. A
19-point gap that moves a term from LOCKED to CONTESTED changes what you should
do; a 30-point gap entirely inside CONTESTED does not. An earlier version
summarised on the spread alone and reported "about as hard everywhere" for a
term that was locked in the US and contested in France.

This is deliberately slow: one request per storefront against a free endpoint
that rate-limits, spaced politely apart. A 14-country sweep takes about a minute
the first time, then comes from cache. A storefront that fails is recorded and
skipped rather than aborting the sweep.

### `app`

```bash
launchpilot app 1438388363
launchpilot app com.example.myapp --country fr --json
```

```
Habit Tracker

  Publisher       Inner Grow Limited
  Version         2.14.18 · shipped 2026-07-10
  Rating          4.79★ from 144,369
  Size            321.7 MB
  Languages       10 — EN, FR, DE, IT, JA, PT, RU, ZH, ES, KO

Listing health
  ✓  App name within 30 characters      13 of 30 characters used.
  ?  At least three iPhone screenshots  The catalogue returned iPad screenshots but not
                                        iPhone ones, which it does for about half of apps.
  ✓  Recently updated                   Last shipped 17 days ago.
  ✗  Downloadable over cellular         321.7 MB.
                                        → Over 200 MB needs Wi-Fi unless the user has
                                          opted in — friction at the moment they decided
                                          to install.

  89/100 — 8 of 9 answerable checks passed, 2 could not be answered
```

Eleven checks over one published listing: name length, description, screenshot
count and aspect ratio, update recency, release notes, localisation, download
size, rating volume.

> **The interesting part is what it refuses to conclude.** A check that cannot
> be answered is marked `?` and **excluded from the score** — an app whose
> screenshots the catalogue happened to withhold must not rank below one whose
> it happened to return. That distinction needs the device list: an app that
> supports iPhone but exposed no iPhone screenshots has almost certainly shipped
> them, while an iPad-only app genuinely has none. Without it, the first would
> be reported as a defect and a developer would go "fix" something that was
> never broken.
>
> Two further limits are stated rather than worked around. Screenshot URLs serve
> a downscaled image that preserves the aspect ratio but **not the resolution**,
> so the device family is inferred and the uploaded pixel size is never claimed.
> Subtitles and the keyword field are not public at all, so neither is checked.

In the web app this is the **Overview** page, and the app you load there becomes
the app the whole session is about — its id prefills the rank check, its name
prefills the competitor comparison and the keyword builder.

### `competitors`

```bash
launchpilot competitors "habit tracker" --top 10
launchpilot competitors "gratitude journal" --screenshots
launchpilot competitors "gratitude journal" --download ./rivals --width 300
launchpilot competitors "budget app" --country fr --json
```

```
habit tracker · US · 190 results

  #   App                        Ratings   Stars   Updated   iPhone   iPad
  1   Habit Tracker              144,343     4.8       16d        0     10
  2   Habit Tracker - HabitKit     2,274     4.9       55d      n/a    n/a
  3   Onrise: Habit Tracker        2,495     4.8      187d        7      0
  4   Productive - Habit Tracker  91,098     4.6      129d        7      7

  What this field does with screenshots
  Median iPhone screenshots   7
  Count distribution          3×1 · 7×3
  Mostly portrait             4 of 5
  Ship iPad screenshots       3 of 5
  Using all 10 slots          0
```

Who you are up against for a term, and how they present. The niche summary is
the useful part: knowing the field ships a median of seven portrait screenshots
tells you more than any single competitor does.

Dimensions and orientation are read **from the screenshot URLs themselves** —
the catalogue encodes the served size in the last path segment — so describing
a competitor's whole gallery costs no bandwidth. `--download` saves them for
offline reference.

> **Screenshot availability is partial, and the tool says so.** Across a 55-app
> sample the catalogue exposed iPhone screenshots for **47%** of apps and some
> set for 55%. Apps it withheld are marked `n/a` rather than shown as having
> none, and they are excluded from the medians instead of counted as zeros —
> folding them in would halve every figure for a reason that has nothing to do
> with your competitors. iPhone and iPad counts are separate for the same
> reason: an app can expose ten iPad screenshots and no iPhone ones.


#### `--terms`: what the field agrees on

```bash
launchpilot competitors "gratitude journal" --terms --mine "Kaizen: Gratitude"
```

```
  Term        Consensus   In app names   In descriptions   Yours
  habit              92            9/10             10/10     yes
  tracker            70            8/10              3/10     yes
  goal               30            2/10              7/10       —
  routine            18            1/10              5/10       —

  Not in your listing: goal, routine, daily, streak
  launchpilot keywords --title '…' -t 'goal' -t 'routine' -t 'daily'
```

Closes the loop: find the vocabulary your rivals share, then feed what you lack
straight into `keywords`.

Terms are counted **once per app**, not per occurrence — otherwise one verbose
description outvotes the field. App-name usage weighs four times description
usage, because a word inside a 30-character name is a deliberate decision while
the same word in paragraph four may be prose. Plural variants are merged, since
a field where every app says both "habit" and "habits" would otherwise report
each at half strength and neither would rank.

> **This sees roughly half of what rivals target.** The public catalogue exposes
> app names and descriptions. It does **not** expose subtitles or keyword
> fields. Treat the result as a floor on their vocabulary, not the whole of it.

### `rank`

```bash
launchpilot rank 1438388363 "habit tracker" "daily habits"
launchpilot rank com.example.myapp "budget" --country fr
launchpilot rank 1438388363 "habit tracker" --history ./ranks.jsonl
```

```
Habit Tracker · US · ranked for 3/3 term(s)

  Keyword           Position   Movement   Since
  habit tracker           #1        ▲ 3   2026-07-20
  daily habits            #1        ▲ 3   2026-07-20
  streak counter          #4        ▲ 3   2026-07-20
```

**What this measures.** The public catalogue returns results in its own
relevance order, and this reports your app's place in that order. It is a real,
repeatable signal, and it moves when your metadata moves.

**What it is not.** The App Store app serves search through a different path,
with personalisation and paid placements, so the two can disagree. This is a
directional measure of how your listing is indexed — not the number a given user
would see. Tools that present a figure like this as *the* App Store ranking are
overstating what any public endpoint can tell them.

`--history` appends each run to a local JSON Lines file and reports movement
against it. There is no server, so that file is the record; appending never
rewrites earlier lines, and one malformed line cannot discard the rest.

### `keywords`

```bash
launchpilot keywords --title "Kaizen: Habit Tracker" --subtitle "Build daily routines" \
    --field "habit, habits, habit tracker, daily, app, free, productivity, streak" \
    -t "habit tracker" -t "gratitude journal"

launchpilot keywords listing.toml --json
launchpilot keywords --title "Kaizen" -t "habit tracker" -t "morning streak" --build
```

```
  Budget  ███████████████████████░░░░░░░  77/100  · 58 wasted

  ✗ ASO_KEYWORD_SPACES        -9c   9 space(s) in the keyword field.
  ✗ ASO_DUPLICATE_OF_TITLE    -8c   'tracker' is already in the title.
  ! ASO_CATEGORY_WORD        -13c   'productivity' is already indexed from your category.
  ! ASO_PLURAL_PAIR           -7c   'habits' and 'habit' differ only by pluralisation.

  Target phrase        Reachable   Indexed from
  habit tracker        yes         title (habit, tracker)
  gratitude journal    no          missing: gratitude, journal

  suggested  routine,morning,streak,gratitude,journal,habits
  47/100 characters, 30 reclaimed
```

The 100-character keyword field is the most technical artefact in a listing and
the only one **never shown to a user** — so nothing about it is self-correcting.
A listing with a third of its budget wasted looks exactly like a perfect one.

Every rule follows from one documented Apple behaviour: the app name, subtitle
and keyword field are indexed as a **single pool of words**, and matches are
formed by combining them. Three consequences do most of the work:

- **A phrase is reachable when every one of its *words* is in the pool.** The
  phrase itself never has to appear. `habit,tracker` ranks for "habit tracker".
- **A word already in your title is already indexed.** Repeating it costs
  characters and buys no reach.
- **Every space is overhead**, since Apple does the combining. `habit tracker`
  and `habit,tracker` index identically; the second is a character shorter.

`--build` packs the minimum set of words covering your target phrases into the
budget, dropping anything already in the title, and emits a bare field for
piping. Target order is treated as priority, so the phrases you listed first
survive truncation.

> **On the waste figure.** Costs are deduplicated per word. One word commonly
> trips several rules at once — `habit` can be both a duplicate within the field
> *and* already present in the title — but deleting it reclaims its characters
> once, not once per rule. Summing the findings would inflate the total by
> exactly the double-counting this tool exists to call out.

The word lists and severities live in
[`core/specs/aso.yaml`](src/launchpilot/core/specs/aso.yaml).

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

**Every tool above also runs in the browser**, with no install, no account and no
server of ours in the path. The offline tools read file headers rather than
pixels; the market tools call Apple's public catalogue directly, which answers
with `access-control-allow-origin: *`.

```bash
python3 -m http.server 8000 --directory web
```

Each browser engine is conformance-tested against its Python original — finding
codes, character costs, coverage, winnability, every signal's observation and
rationale, streak and reset detection. CI fails if they disagree or if any
generated file is stale. See [web/README.md](web/README.md).

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
- [x] `niche` — pre-build market assessment from the public catalogue
- [x] `keywords` — 100-character field audit, coverage map and builder
- [x] Every tool in the browser, conformance-tested against the CLI
- [x] `competitors` — the field for a term, and what it does with screenshots
- [x] `rank` — search position per keyword, with local history tracking
- [x] `markets` — which storefront a term is actually winnable in
- [x] `app` — one listing's health, and an Overview page that anchors the session
- [x] `competitors --terms` — the vocabulary a field shares, and what you lack
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
