"""Tests for MetadataValidator and listing loading."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from appmates.core.errors import MetadataParseError
from appmates.core.models.app_metadata import AppListing, AppMetadata
from appmates.core.models.report import Severity, Status, Store
from appmates.core.services.metadata_validator import MetadataValidator, load_listing


def codes(report: object) -> set[str]:
    return {f.code for f in report.findings}  # type: ignore[attr-defined]


VALID = AppMetadata(
    locale="en-US",
    title="Kaizen Habits",
    subtitle="Small steps, big change",
    short_description="Track habits and build streaks.",
    description="Kaizen helps you build lasting habits, one day at a time.",
    keywords="habit,streak,focus,routine",
)


# --- happy path ----------------------------------------------------------


def test_valid_listing_is_clean() -> None:
    report = MetadataValidator().validate_locale(VALID)
    assert report.status is Status.PASS


# --- length limits -------------------------------------------------------


def test_apple_title_over_thirty_characters_is_an_error() -> None:
    meta = VALID.model_copy(update={"title": "K" * 31})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)

    finding = next(f for f in report.findings if f.code == "APPLE_TITLE_TOO_LONG")
    assert finding.severity is Severity.ERROR
    assert "1 over" in finding.message


def test_play_short_description_limit_is_eighty() -> None:
    meta = VALID.model_copy(update={"short_description": "s" * 81})
    report = MetadataValidator([Store.GOOGLE]).validate_locale(meta)
    assert "GOOGLE_SHORT_DESCRIPTION_TOO_LONG" in codes(report)


def test_field_near_its_limit_warns() -> None:
    """Translations run longer, so 29/30 is worth flagging before localisation."""
    meta = VALID.model_copy(update={"title": "K" * 29})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)

    finding = next(f for f in report.findings if f.code == "APPLE_TITLE_NEAR_LIMIT")
    assert finding.severity is Severity.WARNING


def test_missing_required_field_is_an_error() -> None:
    meta = VALID.model_copy(update={"description": None})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)
    assert "APPLE_MISSING_DESCRIPTION" in codes(report)


def test_blank_required_field_counts_as_missing() -> None:
    meta = VALID.model_copy(update={"title": "   "})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)
    assert "APPLE_MISSING_TITLE" in codes(report)


def test_optional_field_may_be_absent() -> None:
    meta = VALID.model_copy(update={"subtitle": None, "promotional_text": None})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)
    assert report.status is Status.PASS


def test_the_same_listing_can_pass_one_store_and_fail_another() -> None:
    """80-char short description is fine for Apple (unchecked) but a Play field."""
    meta = VALID.model_copy(update={"short_description": "s" * 100})

    assert MetadataValidator([Store.APPLE]).validate_locale(meta).status is Status.PASS
    assert MetadataValidator([Store.GOOGLE]).validate_locale(meta).status is Status.FAIL


# --- Apple keyword rules -------------------------------------------------


def test_keyword_spaces_after_commas_are_flagged() -> None:
    meta = VALID.model_copy(update={"keywords": "habit, streak, focus"})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)

    finding = next(f for f in report.findings if f.code == "APPLE_KEYWORDS_SPACING")
    assert "2 space(s)" in finding.message


def test_duplicate_keywords_are_flagged() -> None:
    meta = VALID.model_copy(update={"keywords": "habit,streak,habit"})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)
    assert "APPLE_KEYWORDS_DUPLICATE" in codes(report)


def test_keywords_repeating_the_title_are_informational() -> None:
    meta = VALID.model_copy(update={"title": "Kaizen Habits", "keywords": "habits,focus"})
    report = MetadataValidator([Store.APPLE]).validate_locale(meta)

    finding = next(f for f in report.findings if f.code == "APPLE_KEYWORDS_REDUNDANT")
    assert finding.severity is Severity.INFO


def test_keyword_rules_do_not_run_for_play() -> None:
    meta = VALID.model_copy(update={"keywords": "habit, habit"})
    report = MetadataValidator([Store.GOOGLE]).validate_locale(meta)
    assert not any(c.startswith("APPLE_KEYWORDS") for c in codes(report))


# --- listing-level -------------------------------------------------------


def test_multiple_locales_are_reported_separately() -> None:
    listing = AppListing(
        locales=[VALID, VALID.model_copy(update={"locale": "fr-FR", "title": "T" * 40})]
    )
    report = MetadataValidator([Store.APPLE]).validate_listing(listing)

    assert len(report.locales) == 2
    assert report.locales[0].status is Status.PASS
    assert report.locales[1].status is Status.FAIL
    assert report.error_count == 1


def test_strict_mode_promotes_warnings() -> None:
    listing = AppListing(locales=[VALID.model_copy(update={"title": "K" * 29})])
    report = MetadataValidator([Store.APPLE]).validate_listing(listing)

    assert report.is_ok() is True
    assert report.is_ok(strict=True) is False


# --- loading -------------------------------------------------------------


def test_load_toml_with_locales(tmp_path: Path) -> None:
    path = tmp_path / "listing.toml"
    path.write_text(
        '[[locales]]\nlocale = "en-US"\ntitle = "Kaizen"\ndescription = "Hi"\n',
        encoding="utf-8",
    )
    listing = load_listing(path)
    assert len(listing.locales) == 1
    assert listing.locales[0].title == "Kaizen"


def test_load_bare_single_locale_json(tmp_path: Path) -> None:
    """A one-off check should not require the [[locales]] wrapper."""
    path = tmp_path / "listing.json"
    path.write_text(json.dumps({"title": "Kaizen", "description": "Hi"}), encoding="utf-8")

    listing = load_listing(path)
    assert len(listing.locales) == 1
    assert listing.locales[0].locale == "en-US"


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(MetadataParseError, match="not found"):
        load_listing(tmp_path / "nope.toml")


def test_load_unsupported_extension_raises(tmp_path: Path) -> None:
    path = tmp_path / "listing.yaml"
    path.write_text("title: Kaizen", encoding="utf-8")
    with pytest.raises(MetadataParseError, match="Unsupported"):
        load_listing(path)


def test_load_malformed_toml_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad.toml"
    path.write_text("this is not = = valid toml", encoding="utf-8")
    with pytest.raises(MetadataParseError, match="Could not parse"):
        load_listing(path)


def test_load_non_mapping_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "list.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(MetadataParseError, match="mapping"):
        load_listing(path)


def test_load_invalid_types_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"locales": [{"title": 12345}]}), encoding="utf-8")
    with pytest.raises(MetadataParseError, match="Invalid metadata"):
        load_listing(path)
