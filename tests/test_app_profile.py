"""Listing-health tests.

The subject of most of these is not whether a rule fires, but whether the
engine refuses to draw a conclusion the data does not support.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from appmates.core.models.report import Severity
from appmates.core.services.app_profile import (
    AppHealthChecker,
    infer_device,
    profile_from_entry,
    screenshot_ratio,
)
from appmates.core.specs.registry import load_app_health_spec

TODAY = dt.date(2026, 7, 27)

IPHONE_SHOT = "https://cdn/a/{i}.png/392x852bb.png"
IPAD_SHOT = "https://cdn/p/{i}.png/576x768bb.png"

SEVERITY_ORDER = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}


def entry(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "trackId": 1,
        "trackName": "Kaizen",
        "sellerName": "Paolo",
        "description": "A habit tracker. " * 20,
        "version": "1.0.0",
        "releaseNotes": "Fixed a crash when adding a habit on the first launch.",
        "releaseDate": "2024-01-01T00:00:00Z",
        "currentVersionReleaseDate": "2026-07-01T00:00:00Z",
        "userRatingCount": 500,
        "averageUserRating": 4.6,
        "price": 0.0,
        "genres": ["Productivity"],
        "fileSizeBytes": 50 * 1024 * 1024,
        "languageCodesISO2A": ["EN", "FR", "DE"],
        "supportedDevices": ["iPhone13-iPhone13", "iPadAir-iPadAir"],
        "screenshotUrls": [IPHONE_SHOT.format(i=i) for i in range(6)],
        "ipadScreenshotUrls": [IPAD_SHOT.format(i=i) for i in range(4)],
    }
    base.update(overrides)
    return base


def report(**overrides: Any) -> Any:
    return AppHealthChecker().check(profile_from_entry(entry(**overrides)), today=TODAY)


def check(rep: Any, code: str) -> Any:
    return next(c for c in rep.checks if c.code == code)


# --- profile parsing -----------------------------------------------------


def test_profile_reads_the_catalogue_fields() -> None:
    p = profile_from_entry(entry())
    assert p.name == "Kaizen"
    assert p.rating_count == 500
    assert p.locales == ["EN", "FR", "DE"]
    assert p.size_mb == 50.0
    assert p.days_since_update(TODAY) == 26


def test_device_support_is_read_from_the_device_list() -> None:
    p = profile_from_entry(entry())
    assert p.supports_iphone is True
    assert p.supports_ipad is True

    ipad_only = profile_from_entry(entry(supportedDevices=["iPadAir-iPadAir"]))
    assert ipad_only.supports_iphone is False
    assert ipad_only.supports_ipad is True


def test_an_absent_device_list_assumes_iphone() -> None:
    """Better to assume the common case than to silently skip a check."""
    assert profile_from_entry(entry(supportedDevices=[])).supports_iphone is True


# --- ratio inference -----------------------------------------------------


def test_ratio_comes_from_the_url() -> None:
    assert screenshot_ratio("https://cdn/a.png/392x852bb.png") == pytest.approx(2.173, abs=0.01)
    assert screenshot_ratio("https://cdn/a.png/no-size") is None


def test_device_family_is_inferred_from_the_ratio() -> None:
    spec = load_app_health_spec()
    assert "iPhone" in (infer_device(["https://cdn/a.png/392x852bb.png"], spec) or "")
    assert "iPad" in (infer_device(["https://cdn/a.png/576x768bb.png"], spec) or "")


def test_an_unrecognised_ratio_is_reported_as_unknown() -> None:
    assert infer_device(["https://cdn/a.png/100x100bb.png"], load_app_health_spec()) is None


def test_resolution_is_never_claimed() -> None:
    """The served image is downscaled, so the upload size is not knowable.

    Nothing in the profile may expose a pixel count that could be mistaken for
    the uploaded resolution.
    """
    p = profile_from_entry(entry())
    assert not hasattr(p, "screenshot_width")
    assert p.inferred_device is not None


# --- answerability -------------------------------------------------------


def test_withheld_screenshots_are_unanswerable_not_failed() -> None:
    rep = report(screenshotUrls=[], ipadScreenshotUrls=[])
    assert check(rep, "APP_SCREENSHOTS_NOT_EXPOSED").checkable is False
    assert rep.unknown_count == 1


def test_an_iphone_app_missing_only_iphone_shots_is_unanswerable() -> None:
    """The catalogue returns one set and not the other for about half of apps.

    Judging that as a defect would tell a developer to fix something that was
    never broken.
    """
    rep = report(screenshotUrls=[])
    assert check(rep, "APP_TOO_FEW_SCREENSHOTS").checkable is False
    assert check(rep, "APP_UNUSED_SCREENSHOT_SLOTS").checkable is False


def test_an_ipad_only_app_is_not_marked_down_for_missing_iphone_shots() -> None:
    rep = report(screenshotUrls=[], supportedDevices=["iPadAir-iPadAir"])
    assert check(rep, "APP_TOO_FEW_SCREENSHOTS").passed is True


def test_an_iphone_only_app_is_not_marked_down_for_missing_ipad_shots() -> None:
    rep = report(ipadScreenshotUrls=[], supportedDevices=["iPhone13-iPhone13"])
    entry_check = check(rep, "APP_NO_IPAD_SCREENSHOTS")
    assert entry_check.passed is True
    assert "does not run on iPad" in entry_check.detail


def test_an_ipad_app_missing_ipad_shots_is_unanswerable() -> None:
    assert check(report(ipadScreenshotUrls=[]), "APP_NO_IPAD_SCREENSHOTS").checkable is False


def test_unanswerable_checks_do_not_lower_the_score() -> None:
    """An app whose screenshots the API withheld must not rank below one whose
    it happened to return."""
    assert report(screenshotUrls=[], ipadScreenshotUrls=[]).score >= report().score


def test_a_missing_size_is_unanswerable() -> None:
    assert check(report(fileSizeBytes=0), "APP_OVER_CELLULAR_LIMIT").checkable is False


def test_a_missing_update_date_is_unanswerable() -> None:
    assert check(report(currentVersionReleaseDate=None), "APP_STALE").checkable is False


# --- checks --------------------------------------------------------------


def test_a_long_name_fails() -> None:
    rep = report(trackName="K" * 40)
    assert check(rep, "APP_TITLE_TOO_LONG").passed is False
    assert check(rep, "APP_TITLE_TOO_LONG").severity is Severity.ERROR


def test_a_stale_listing_is_flagged() -> None:
    rep = report(currentVersionReleaseDate="2026-01-01T00:00:00Z")
    assert check(rep, "APP_STALE").passed is False


def test_a_very_stale_listing_is_an_error() -> None:
    rep = report(currentVersionReleaseDate="2024-01-01T00:00:00Z")
    assert check(rep, "APP_VERY_STALE").severity is Severity.ERROR


def test_an_oversized_binary_is_flagged() -> None:
    rep = report(fileSizeBytes=300 * 1024 * 1024)
    over = check(rep, "APP_OVER_CELLULAR_LIMIT")
    assert over.passed is False
    assert "200 MB" in (over.fix_hint or "")


def test_a_binary_under_the_limit_passes() -> None:
    assert check(report(fileSizeBytes=180 * 1024 * 1024), "APP_OVER_CELLULAR_LIMIT").passed is True


def test_missing_release_notes_are_flagged() -> None:
    assert check(report(releaseNotes=""), "APP_NO_RELEASE_NOTES").passed is False


def test_a_single_locale_is_unanswerable_not_failed() -> None:
    """The catalogue's language field has been observed reporting only English
    for apps confirmed to have several App Store Connect localizations.

    Scoring that as a defect would tell a developer to fix something that was
    never broken.
    """
    assert check(report(languageCodesISO2A=["EN"]), "APP_FEW_LOCALES").checkable is False


def test_several_locales_still_pass_and_are_checkable() -> None:
    rep = report(languageCodesISO2A=["EN", "FR", "DE"])
    entry_check = check(rep, "APP_FEW_LOCALES")
    assert entry_check.checkable is True
    assert entry_check.passed is True


def test_low_ratings_are_flagged() -> None:
    assert check(report(userRatingCount=12), "APP_LOW_RATINGS").passed is False


def test_a_missing_description_is_an_error() -> None:
    rep = report(description="")
    assert check(rep, "APP_NO_DESCRIPTION").passed is False
    assert rep.status.value == "fail"


# --- report --------------------------------------------------------------


def test_a_healthy_listing_scores_full_marks() -> None:
    rep = report(
        screenshotUrls=[IPHONE_SHOT.format(i=i) for i in range(10)],
        userRatingCount=5000,
    )
    assert rep.score == 100.0
    assert rep.findings == []
    assert rep.status.value == "pass"


def test_failing_checks_are_ordered_worst_first() -> None:
    rep = report(trackName="K" * 40, userRatingCount=2, languageCodesISO2A=["EN"])
    severities = [SEVERITY_ORDER[c.severity] for c in rep.failing]
    assert severities == sorted(severities)


def test_findings_come_only_from_answerable_failures() -> None:
    rep = report(screenshotUrls=[], ipadScreenshotUrls=[])
    codes = {f.code for f in rep.findings}
    assert all(c.checkable for c in rep.checks if c.code in codes)


def test_the_score_counts_only_answerable_checks() -> None:
    rep = report(screenshotUrls=[], ipadScreenshotUrls=[])
    assert rep.checked_count + rep.unknown_count == len(rep.checks)
    assert rep.score == pytest.approx(100 * rep.passed_count / rep.checked_count, abs=0.1)
