"""Tests for check_submission."""

from __future__ import annotations

import json
from pathlib import Path

from appmates.core.models.report import Status
from appmates.core.services.submission_checker import check_submission


def _write_listing(tmp_path: Path, **fields: object) -> Path:
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(fields), encoding="utf-8")
    return path


def test_runs_only_the_checks_given_input() -> None:
    report = check_submission(keyword_field="habit,streak")
    assert report.ran == ["keywords"]
    assert report.screenshots is None
    assert report.metadata is None
    assert report.keywords is not None


def test_clean_inputs_pass_every_check(screenshot_dir: Path, tmp_path: Path) -> None:
    listing = _write_listing(
        tmp_path,
        title="Kaizen Habits",
        short_description="Track habits and build streaks.",
        description="Kaizen helps you build lasting habits.",
        keywords="habit,streak,focus",
    )
    report = check_submission(screenshots_dir=screenshot_dir, metadata_file=listing)
    assert report.ran == ["screenshots", "metadata", "keywords"]
    assert report.status is Status.PASS
    assert report.is_ok()


def test_keyword_field_defaults_from_the_metadata_locale(tmp_path: Path) -> None:
    listing = _write_listing(
        tmp_path,
        title="Kaizen Habits",
        short_description="Track habits and build streaks.",
        description="Kaizen helps you build lasting habits.",
        keywords="habit,streak,streak",
    )
    report = check_submission(metadata_file=listing)
    assert report.keywords is not None
    assert report.keywords.title == "Kaizen Habits"
    codes = {f.code for f in report.keywords.findings}
    assert "ASO_DUPLICATE_IN_FIELD" in codes


def test_explicit_keyword_field_overrides_the_listing(tmp_path: Path) -> None:
    listing = _write_listing(tmp_path, title="Kaizen", description="d" * 20, keywords="habit")
    report = check_submission(metadata_file=listing, keyword_field="focus,routine")
    assert report.keywords is not None
    assert report.keywords.field_value == "focus,routine"


def test_error_in_any_check_fails_the_whole_report(tmp_path: Path) -> None:
    listing = _write_listing(tmp_path, title="K" * 40)  # over the 30-char limit
    report = check_submission(metadata_file=listing)
    assert report.status is Status.FAIL
    assert not report.is_ok()


def test_all_findings_combine_every_ran_check(screenshot_dir: Path, tmp_path: Path) -> None:
    listing = _write_listing(tmp_path, title="K" * 40, keywords="habit,habit")
    report = check_submission(screenshots_dir=screenshot_dir, metadata_file=listing)
    codes = {f.code for f in report.all_findings}
    assert "APPLE_TITLE_TOO_LONG" in codes
    assert "ASO_DUPLICATE_IN_FIELD" in codes
