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
import itertools
import json
import sys
from pathlib import Path
from typing import Any

from launchpilot.core.models.report import ImageFacts, Store
from launchpilot.core.services.image_validator import ScreenshotValidator

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


def render() -> str:
    payload = {
        "_comment": (
            "GENERATED by scripts/export_conformance.py from the Python validator. "
            "Do not edit by hand."
        ),
        "cases": build_cases(),
        "setCases": build_set_cases(),
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
