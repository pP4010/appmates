#!/usr/bin/env python
"""Generate the golden corpus the browser engine is tested against.

The web checker reimplements the rule logic in JavaScript. The specification
*numbers* stay single-sourced in YAML, but the logic exists twice, and two
implementations of the same rules drift the moment someone edits one of them.

This script runs the Python validator — the implementation covered by the main
test suite — across a deliberately awkward grid of inputs and records what it
produced. ``web/test/conformance.test.js`` then asserts the JavaScript engine
returns the same finding codes for the same inputs. A divergence fails CI on
whichever side changed.

Run with ``--check`` in CI to detect a stale corpus.
"""

from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import sys
from pathlib import Path
from typing import Any

from launchpilot.core.models.report import ImageFacts, Store
from launchpilot.core.models.testing import DailyTesterCount
from launchpilot.core.services.competitor_analyzer import analyse_competitors, extract_terms
from launchpilot.core.services.google_play import evaluate
from launchpilot.core.services.image_validator import ScreenshotValidator
from launchpilot.core.services.keyword_builder import KeywordBuilder
from launchpilot.core.services.market_analyzer import analyse_keyword

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = REPO_ROOT / "web" / "test" / "conformance-cases.json"

MB = 1024 * 1024

# Sizes chosen to land on every branch: current Apple sizes, the legacy and
# deprecated entries, Play's exact minimum, its boundary conditions, and
# resolutions that match nothing at all.
SIZES: list[tuple[int, int]] = [
    (1320, 2868),  # apple 6.9" required
    (1284, 2778),  # apple 6.5"
    (1206, 2622),  # apple 6.3"
    (1242, 2208),  # apple 5.5"
    (2064, 2752),  # ipad 13"
    (1242, 2688),  # apple legacy 6.5" -> warning
    (640, 1136),  # apple deprecated -> error
    (1080, 1920),  # play canonical
    (1440, 2560),  # play high-res
    (1000, 2000),  # matches nothing
    (200, 356),  # below play minimum
    (2400, 4000),  # above play maximum
    (540, 960),  # below play recommended
    (1200, 1920),  # off-spec aspect ratio
    (2868, 1320),  # landscape orientation
    (1080, 2160),  # exactly 2x: boundary of PLAY_MAX_TWICE_MIN
    (1080, 2161),  # one pixel over the boundary
]

MODES: list[tuple[str, str, bool]] = [
    # (mode, format, has_alpha)
    ("RGB", "PNG", False),
    ("RGBA", "PNG", True),
    ("L", "PNG", False),
    ("LA", "PNG", True),
    ("P", "PNG", False),
    ("RGB", "JPEG", False),
    ("CMYK", "JPEG", False),
    # Formats neither store accepts, to exercise the *_FORMAT rule.
    ("P", "GIF", False),
    ("RGBA", "WEBP", True),
]

WEIGHTS: list[int] = [512 * 1024, 9 * MB]

STORE_SETS: list[list[Store]] = [
    [Store.APPLE],
    [Store.GOOGLE],
    [Store.APPLE, Store.GOOGLE],
]


def build_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    for (width, height), (mode, fmt, alpha), weight, stores in itertools.product(
        SIZES, MODES, WEIGHTS, STORE_SETS
    ):
        facts = ImageFacts(
            width=width,
            height=height,
            image_format=fmt,
            mode=mode,
            has_alpha=alpha,
            size_bytes=weight,
        )
        report = ScreenshotValidator(stores).validate_facts(facts)
        cases.append(
            {
                "facts": {
                    "width": width,
                    "height": height,
                    "imageFormat": fmt,
                    "mode": mode,
                    "hasAlpha": alpha,
                    "sizeBytes": weight,
                },
                "stores": [s.value for s in stores],
                # Sorted: the two engines emit rules in the same order today,
                # but ordering is not part of the contract. Codes are.
                "expectedCodes": sorted(f.code for f in report.findings),
                "expectedStatus": report.status.value,
                "expectedDeviceClass": report.device_class,
            }
        )
    return cases


def build_set_cases() -> list[dict[str, Any]]:
    """Directory-level scenarios: counts and mixed sizes."""
    scenarios: list[tuple[str, list[tuple[int, int]], list[Store]]] = [
        ("single apple screenshot", [(1320, 2868)], [Store.APPLE]),
        ("three apple screenshots", [(1320, 2868)] * 3, [Store.APPLE]),
        ("eleven apple screenshots", [(1320, 2868)] * 11, [Store.APPLE]),
        ("mixed apple sizes", [(1320, 2868), (1284, 2778)], [Store.APPLE]),
        ("single play screenshot", [(1080, 1920)], [Store.GOOGLE]),
        ("two play screenshots", [(1080, 1920)] * 2, [Store.GOOGLE]),
        ("nine play screenshots", [(1080, 1920)] * 9, [Store.GOOGLE]),
    ]

    cases: list[dict[str, Any]] = []
    for name, sizes, stores in scenarios:
        validator = ScreenshotValidator(stores)
        assets = [
            validator.validate_facts(
                ImageFacts(
                    width=w,
                    height=h,
                    image_format="PNG",
                    mode="RGB",
                    has_alpha=False,
                    size_bytes=512 * 1024,
                )
            )
            for w, h in sizes
        ]
        set_findings = list(validator.check_set(assets))
        cases.append(
            {
                "name": name,
                "sizes": [{"width": w, "height": h} for w, h in sizes],
                "stores": [s.value for s in stores],
                "expectedCodes": sorted(f.code for f in set_findings),
            }
        )
    return cases


KEYWORD_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "clean field",
        "field": "streak,focus,routine",
        "title": "Kaizen",
        "subtitle": "",
        "targets": ["streak focus"],
    },
    {
        "name": "spaces after commas",
        "field": "habit, streak, focus",
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "duplicate within the field",
        "field": "habit,streak,habit",
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "duplicate of the title",
        "field": "habit,streak",
        "title": "Habit Tracker",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "duplicate of the subtitle",
        "field": "routine,focus",
        "title": "Kaizen",
        "subtitle": "Daily routine builder",
        "targets": [],
    },
    {
        "name": "noise and category words",
        "field": "app,free,productivity,habit",
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "trademark risk",
        "field": "habit,instagram",
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "singular and plural pair",
        "field": "habit,habits",
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "over the character limit",
        "field": ",".join(f"word{i}" for i in range(20)),
        "title": "",
        "subtitle": "",
        "targets": [],
    },
    {
        "name": "uncovered targets",
        "field": "streak",
        "title": "Kaizen",
        "subtitle": "",
        "targets": ["morning streak", "gratitude journal"],
    },
    {
        "name": "coverage split across title and field",
        "field": "tracker",
        "title": "Habit",
        "subtitle": "",
        "targets": ["habit tracker"],
    },
    {
        "name": "accented words are not folded",
        "field": "café,météo",
        "title": "Cafés",
        "subtitle": "",
        "targets": ["café météo"],
    },
    {
        "name": "everything wrong at once",
        "field": "habit, habits, habit tracker, daily, routine, app, free, productivity, streak",
        "title": "Kaizen: Habit Tracker",
        "subtitle": "Build daily routines",
        "targets": ["habit tracker", "daily routine", "morning streak", "gratitude journal"],
    },
    {
        "name": "empty field with targets",
        "field": "",
        "title": "Kaizen",
        "subtitle": "",
        "targets": ["habit tracker"],
    },
]

BUILD_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "drops title words",
        "targets": ["habit tracker", "morning streak"],
        "title": "Habit Tracker",
        "subtitle": "",
    },
    {
        "name": "drops noise and category",
        "targets": ["free habit app", "productivity streak"],
        "title": "",
        "subtitle": "",
    },
    {
        "name": "deduplicates across phrases",
        "targets": ["habit streak", "habit routine"],
        "title": "",
        "subtitle": "",
    },
    {
        "name": "respects the budget",
        "targets": [f"unique{i} phrase{i}" for i in range(40)],
        "title": "",
        "subtitle": "",
    },
    {"name": "nothing to build", "targets": [], "title": "", "subtitle": ""},
]


def build_keyword_cases() -> list[dict[str, Any]]:
    """Keyword-field scenarios, scored by the Python builder.

    The browser reimplements this engine so the tool works with no backend; the
    JS side must produce identical codes, costs, coverage and suggestions.
    """
    builder = KeywordBuilder()
    cases = []
    for scenario in KEYWORD_SCENARIOS:
        report = builder.audit(
            scenario["field"],
            title=scenario["title"] or None,
            subtitle=scenario["subtitle"] or None,
            targets=scenario["targets"],
        )
        cases.append(
            {
                **scenario,
                "expectedCodes": sorted(f.code for f in report.findings),
                "expectedWasted": report.wasted_characters,
                "expectedLength": report.length,
                "expectedIndexedWords": report.indexed_words,
                "expectedUncovered": report.uncovered_targets,
                "expectedCoverage": [
                    {"phrase": c.phrase, "covered": c.covered, "missing": c.missing_words}
                    for c in report.coverage
                ],
                "expectedSuggestion": report.suggested_field,
            }
        )
    return cases


def build_build_cases() -> list[dict[str, Any]]:
    builder = KeywordBuilder()
    return [
        {
            **scenario,
            "expectedField": builder.build(
                scenario["targets"],
                title=scenario["title"] or None,
                subtitle=scenario["subtitle"] or None,
            ),
        }
        for scenario in BUILD_SCENARIOS
    ]


MARKET_TODAY = dt.date(2026, 7, 26)

# Fields chosen so every signal moves independently across the scenarios.
MARKET_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "empty niche",
        "keyword": "sourdough starter log",
        "apps": [{"ratings": 5, "stars": 4.0, "updated": "2024-01-01", "name": "Bread Diary"}] * 3,
        "result_count": 12,
    },
    {
        "name": "entrenched niche",
        "keyword": "photo editor",
        "apps": [
            {"ratings": 250_000, "stars": 4.8, "updated": "2026-07-24", "name": "Photo Editor Pro"}
        ]
        * 60,
        "result_count": 200,
    },
    {
        "name": "stale leaders",
        "keyword": "ham radio logbook",
        "apps": [{"ratings": 40, "stars": 3.6, "updated": "2023-02-01", "name": "QSO Log"}] * 6,
        "result_count": 90,
    },
    {
        "name": "untargeted leaders",
        "keyword": "morning routine",
        "apps": [{"ratings": 9_000, "stars": 4.7, "updated": "2026-06-01", "name": "Unrelated"}]
        * 12,
        "result_count": 180,
    },
    {
        "name": "publisher concentration",
        "keyword": "budget",
        "apps": [
            {
                "ratings": 5_000,
                "stars": 4.5,
                "updated": "2026-05-01",
                "name": "Budget A",
                "seller": "Big",
            },
            {
                "ratings": 5_000,
                "stars": 4.5,
                "updated": "2026-05-01",
                "name": "Budget B",
                "seller": "Big",
            },
            {
                "ratings": 5_000,
                "stars": 4.5,
                "updated": "2026-05-01",
                "name": "Budget C",
                "seller": "Big",
            },
            {
                "ratings": 400,
                "stars": 4.1,
                "updated": "2026-05-01",
                "name": "Budget D",
                "seller": "Solo",
            },
        ],
        "result_count": 60,
    },
    {
        "name": "missing dates and ratings",
        "keyword": "obscure tool",
        "apps": [{"ratings": 0, "stars": None, "updated": None, "name": "Bare"}] * 4,
        "result_count": 8,
    },
    {
        "name": "no results at all",
        "keyword": "zzzz nothing",
        "apps": [],
        "result_count": 0,
    },
    {
        "name": "thin sample",
        "keyword": "two apps only",
        "apps": [{"ratings": 100, "stars": 4.4, "updated": "2026-01-01", "name": "One"}] * 2,
        "result_count": 2,
    },
]


def _market_entries(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    entries = []
    for index, app in enumerate(scenario["apps"]):
        entry: dict[str, Any] = {
            "trackId": index,
            "trackName": f"{app['name']} {index}",
            "sellerName": app.get("seller", f"Dev {index}"),
            "userRatingCount": app["ratings"],
            "price": 0.0,
        }
        if app["stars"] is not None:
            entry["averageUserRating"] = app["stars"]
        if app["updated"] is not None:
            entry["currentVersionReleaseDate"] = f"{app['updated']}T00:00:00Z"
        entries.append(entry)
    return entries


def build_market_cases() -> list[dict[str, Any]]:
    """Niche scoring scenarios, scored by the Python analyser.

    ``today`` is pinned: the freshness signal reads a date difference, so an
    unpinned corpus would drift a point every day and fail CI for no reason.
    """
    cases = []
    for scenario in MARKET_SCENARIOS:
        entries = _market_entries(scenario)
        report = analyse_keyword(
            scenario["keyword"],
            country="us",
            result_count=scenario["result_count"],
            entries=entries,
            today=MARKET_TODAY,
        )
        cases.append(
            {
                "name": scenario["name"],
                "keyword": scenario["keyword"],
                "country": "us",
                "resultCount": scenario["result_count"],
                "today": MARKET_TODAY.isoformat(),
                "entries": entries,
                "expectedWinnability": report.winnability,
                "expectedVerdict": report.verdict.value,
                "expectedAppsSampled": report.apps_sampled,
                "expectedNotes": report.notes,
                "expectedSignals": [
                    {
                        "code": s.code,
                        "observed": s.observed,
                        "score": s.score,
                        "band": s.band.value,
                        "rationale": s.rationale,
                    }
                    for s in report.signals
                ],
            }
        )
    return cases


TESTING_TODAY = dt.date(2026, 7, 26)

TESTING_SCENARIOS: list[dict[str, Any]] = [
    {"name": "not started", "counts": [], "approved": True},
    {"name": "one day at target", "counts": [12], "approved": True},
    {"name": "nine days at target", "counts": [12] * 9, "approved": True},
    {"name": "fourteen days at target", "counts": [12] * 14, "approved": True},
    {"name": "twenty days at target", "counts": [12] * 20, "approved": True},
    {"name": "below target throughout", "counts": [8] * 14, "approved": True},
    # The case the whole module exists for: a dip that restarts Google's clock.
    {"name": "dip on day nine", "counts": [12] * 8 + [11] + [12] * 6, "approved": True},
    {"name": "dip then long recovery", "counts": [12] * 3 + [5] + [12] * 14, "approved": True},
    {"name": "release not approved", "counts": [12] * 20, "approved": False},
    {"name": "exactly at threshold", "counts": [12] * 13 + [12], "approved": True},
    {"name": "above threshold", "counts": [30] * 14, "approved": True},
    {"name": "final day drops", "counts": [12] * 13 + [3], "approved": True},
]


def build_testing_cases() -> list[dict[str, Any]]:
    """Closed-testing timelines, evaluated by the Python engine.

    ``today`` is pinned because the projected date is computed from it.
    """
    cases = []
    for scenario in TESTING_SCENARIOS:
        counts = scenario["counts"]
        history = [
            DailyTesterCount(
                date=TESTING_TODAY - dt.timedelta(days=len(counts) - 1 - offset),
                opted_in=value,
            )
            for offset, value in enumerate(counts)
        ]
        status = evaluate(history, release_approved=scenario["approved"], today=TESTING_TODAY)
        cases.append(
            {
                "name": scenario["name"],
                "history": [{"date": d.date.isoformat(), "optedIn": d.opted_in} for d in history],
                "releaseApproved": scenario["approved"],
                "today": TESTING_TODAY.isoformat(),
                "expectedEligible": status.eligible,
                "expectedActive": status.active_testers,
                "expectedStreak": status.current_streak_days,
                "expectedLongest": status.longest_streak_days,
                "expectedDaysRemaining": status.days_remaining,
                "expectedWasReset": status.streak_was_reset,
                "expectedBlockerCodes": sorted(b.code for b in status.blocking_reasons),
                "expectedProjected": (
                    status.projected_eligible_date.isoformat()
                    if status.projected_eligible_date
                    else None
                ),
            }
        )
    return cases


COMPETITOR_SCENARIOS: list[dict[str, Any]] = [
    {
        "name": "all exposed",
        "apps": [{"iphone": 7, "ipad": 0, "name": "Habit Tracker"}] * 5,
    },
    {
        "name": "half withheld",
        "apps": [
            {"iphone": 7, "ipad": 3, "name": "Habit One"},
            {"iphone": 0, "ipad": 0, "name": "Withheld Two"},
            {"iphone": 5, "ipad": 0, "name": "Habit Three"},
            {"iphone": 0, "ipad": 0, "name": "Withheld Four"},
        ],
    },
    {
        "name": "ipad only leader",
        "apps": [
            {"iphone": 0, "ipad": 10, "name": "Tablet First"},
            {"iphone": 6, "ipad": 0, "name": "Phone First"},
        ],
    },
    {
        "name": "landscape field",
        "apps": [{"iphone": 5, "ipad": 0, "name": "Racing Game", "portrait": False}] * 4,
    },
    {
        "name": "uses every slot",
        "apps": [{"iphone": 10, "ipad": 0, "name": "Maximal App"}] * 3,
    },
    {"name": "nothing at all", "apps": []},
]


def _competitor_entries(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    entries = []
    for index, app in enumerate(scenario["apps"]):
        dims = "392x696bb" if app.get("portrait", True) else "696x392bb"
        entries.append(
            {
                "trackId": index,
                "trackName": f"{app['name']} {index}",
                "sellerName": app.get("seller", f"Dev {index}"),
                "description": app.get("description", "Track your daily habit and build streaks."),
                "userRatingCount": 500,
                "averageUserRating": 4.5,
                "price": 0.0,
                "currentVersionReleaseDate": "2026-07-01T00:00:00Z",
                "screenshotUrls": [
                    f"https://cdn/{index}-{k}.png/{dims}.png" for k in range(app["iphone"])
                ],
                "ipadScreenshotUrls": [
                    f"https://cdn/{index}-p{k}.png/{dims}.png" for k in range(app["ipad"])
                ],
            }
        )
    return entries


def build_competitor_cases() -> list[dict[str, Any]]:
    cases = []
    for scenario in COMPETITOR_SCENARIOS:
        entries = _competitor_entries(scenario)
        report = analyse_competitors(
            "habit tracker", country="us", result_count=len(entries), entries=entries
        )
        terms = extract_terms(report.apps, your_text="My Habit App", min_apps=1)
        strategy = report.strategy
        cases.append(
            {
                "name": scenario["name"],
                "entries": entries,
                "expectedIphoneCounts": [a.iphone_count for a in report.apps],
                "expectedIpadCounts": [a.ipad_count for a in report.apps],
                "expectedExposed": [a.screenshots_exposed for a in report.apps],
                "expectedStrategy": (
                    {
                        "appsSampled": strategy.apps_sampled,
                        "appsMissing": strategy.apps_missing,
                        "medianCount": strategy.median_count,
                        "coveragePercent": strategy.coverage_percent,
                        "portraitApps": strategy.portrait_apps,
                        "landscapeApps": strategy.landscape_apps,
                        "ipadApps": strategy.ipad_apps,
                        "usesMaxSlots": strategy.uses_max_slots,
                    }
                    if strategy
                    else None
                ),
                "expectedTerms": [
                    {
                        "term": t.term,
                        "appsInName": t.apps_in_name,
                        "appsInDescription": t.apps_in_description,
                        "score": t.score,
                        "inYourListing": t.in_your_listing,
                    }
                    for t in terms
                ],
                "expectedNotes": report.notes,
            }
        )
    return cases


def render() -> str:
    payload = {
        "_comment": (
            "GENERATED by scripts/export_conformance.py from the Python validator. "
            "Do not edit by hand."
        ),
        "cases": build_cases(),
        "setCases": build_set_cases(),
        "keywordCases": build_keyword_cases(),
        "keywordBuildCases": build_build_cases(),
        "marketCases": build_market_cases(),
        "testingCases": build_testing_cases(),
        "competitorCases": build_competitor_cases(),
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the corpus is stale.")
    args = parser.parse_args()

    generated = render()

    if args.check:
        if not OUTPUT.exists():
            print(f"error: {OUTPUT.relative_to(REPO_ROOT)} is missing", file=sys.stderr)
            return 1
        if OUTPUT.read_text(encoding="utf-8") != generated:
            print(
                f"error: {OUTPUT.relative_to(REPO_ROOT)} is out of date.\n"
                "       Run: uv run python scripts/export_conformance.py",
                file=sys.stderr,
            )
            return 1
        print(f"{OUTPUT.relative_to(REPO_ROOT)} is up to date")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(generated, encoding="utf-8")
    count = generated.count('"expectedCodes"')
    print(f"wrote {OUTPUT.relative_to(REPO_ROOT)} ({count} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
