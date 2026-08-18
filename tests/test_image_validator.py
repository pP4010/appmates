"""Tests for ScreenshotValidator."""

from __future__ import annotations

from pathlib import Path

import pytest

from appmates.core.errors import DirectoryNotFoundError
from appmates.core.models.report import Severity, Status, Store
from appmates.core.services.image_validator import (
    ScreenshotValidator,
    detect_target_store,
    discover_images,
    read_facts,
    suppress_findings,
)
from tests.conftest import APPLE_6_5, APPLE_6_9, APPLE_LEGACY_6_5, PLAY_FHD, MakeImage


def codes(findings: list) -> set[str]:
    return {f.code for f in findings}


# --- facts ---------------------------------------------------------------


def test_read_facts_reports_dimensions_and_mode(make_image: MakeImage) -> None:
    path = make_image(size=APPLE_6_5, mode="RGB")
    facts = read_facts(path)

    assert (facts.width, facts.height) == APPLE_6_5
    assert facts.image_format == "PNG"
    assert facts.has_alpha is False
    assert facts.size_bytes > 0


def test_read_facts_detects_alpha(make_image: MakeImage) -> None:
    facts = read_facts(make_image(mode="RGBA"))
    assert facts.has_alpha is True


def test_aspect_ratio_is_orientation_independent(make_image: MakeImage) -> None:
    portrait = read_facts(make_image(name="p.png", size=(1080, 1920)))
    landscape = read_facts(make_image(name="l.png", size=(1920, 1080)))
    assert portrait.aspect_ratio == landscape.aspect_ratio == pytest.approx(1.7778, abs=1e-3)


def test_zero_dimension_aspect_ratio_is_safe() -> None:
    from appmates.core.models.report import ImageFacts

    assert ImageFacts(width=0, height=0).aspect_ratio == 0.0


# --- discovery -----------------------------------------------------------


def test_discover_skips_non_images_and_hidden(tmp_path: Path, make_image: MakeImage) -> None:
    make_image(name="a.png", directory=tmp_path)
    make_image(name="b.jpg", directory=tmp_path)
    (tmp_path / "notes.txt").write_text("ignore me")
    (tmp_path / ".DS_Store").write_bytes(b"\x00")

    assert [p.name for p in discover_images(tmp_path)] == ["a.png", "b.jpg"]


def test_discover_missing_directory_raises(tmp_path: Path) -> None:
    with pytest.raises(DirectoryNotFoundError):
        discover_images(tmp_path / "nope")


# --- Apple rules ---------------------------------------------------------


def test_valid_apple_screenshot_is_clean(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(make_image(size=APPLE_6_9))
    assert report.findings == []
    assert report.status is Status.PASS
    assert report.device_class == 'iPhone 6.9"'


def test_alpha_channel_is_an_error(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(
        make_image(size=APPLE_6_5, mode="RGBA")
    )
    alpha = next(f for f in report.findings if f.code == "APPLE_ALPHA_CHANNEL")
    assert alpha.severity is Severity.ERROR
    assert alpha.fixable is True
    assert report.status is Status.FAIL


def test_legacy_size_warns_and_suggests_the_documented_successor(
    make_image: MakeImage,
) -> None:
    """1242x2688 must map to 6.5", not to the numerically-closer 6.3"."""
    report = ScreenshotValidator([Store.APPLE]).validate_file(make_image(size=APPLE_LEGACY_6_5))
    legacy = next(f for f in report.findings if f.code == "APPLE_LEGACY_SIZE")

    assert legacy.severity is Severity.WARNING
    assert legacy.fix_hint is not None
    assert "1284x2778" in legacy.fix_hint
    assert report.status is Status.WARN


def test_deprecated_size_is_an_error(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(make_image(size=(640, 1136)))
    assert "APPLE_SIZE_DEPRECATED" in codes(report.findings)
    assert report.status is Status.FAIL


def test_unknown_size_is_an_error_with_nearest_hint(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(make_image(size=(1000, 2000)))
    finding = next(f for f in report.findings if f.code == "APPLE_SIZE_UNKNOWN")
    assert finding.severity is Severity.ERROR
    assert finding.fix_hint and "Closest accepted size" in finding.fix_hint


def test_apple_accepts_landscape_orientation(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(
        make_image(size=(APPLE_6_9[1], APPLE_6_9[0]))
    )
    assert "APPLE_SIZE_UNKNOWN" not in codes(report.findings)


def test_non_rgb_mode_is_flagged(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_file(
        make_image(size=APPLE_6_5, mode="CMYK", fmt="JPEG", name="cmyk.jpg", color=(0, 0, 0, 0))
    )
    assert "APPLE_COLOR_SPACE" in codes(report.findings)


def test_unreadable_file_reports_rather_than_raising(tmp_path: Path) -> None:
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"definitely not a png")

    report = ScreenshotValidator([Store.APPLE]).validate_file(broken)
    assert codes(report.findings) == {"UNREADABLE_IMAGE"}
    assert report.facts is None


# --- Google Play rules ---------------------------------------------------


def test_valid_play_screenshot_is_clean(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(make_image(size=PLAY_FHD))
    assert report.findings == []


def test_play_rejects_long_side_over_twice_short_side(make_image: MakeImage) -> None:
    """The rule that quietly rejects tall modern phone screenshots."""
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(
        make_image(size=APPLE_LEGACY_6_5)  # 2688 > 2 * 1242
    )
    finding = next(f for f in report.findings if f.code == "PLAY_MAX_TWICE_MIN")
    assert finding.severity is Severity.ERROR


def test_play_flags_too_small(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(make_image(size=(200, 356)))
    assert "PLAY_SIDE_TOO_SMALL" in codes(report.findings)


def test_play_flags_too_large(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(make_image(size=(2400, 4000)))
    assert "PLAY_SIDE_TOO_LARGE" in codes(report.findings)


def test_play_warns_below_recommended_resolution(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(make_image(size=(540, 960)))
    below = next(f for f in report.findings if f.code == "PLAY_BELOW_RECOMMENDED")
    assert below.severity is Severity.WARNING


def test_play_warns_on_off_spec_aspect_ratio(make_image: MakeImage) -> None:
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(make_image(size=(1200, 1920)))
    ratio = next(f for f in report.findings if f.code == "PLAY_ASPECT_RATIO")
    assert ratio.severity is Severity.WARNING


def test_play_flags_oversized_file(make_image: MakeImage) -> None:
    big = make_image(size=PLAY_FHD, padding_bytes=9 * 1024 * 1024)
    report = ScreenshotValidator([Store.GOOGLE]).validate_file(big)
    assert "PLAY_FILE_TOO_LARGE" in codes(report.findings)


# --- set-level rules -----------------------------------------------------


def test_empty_directory_is_an_error(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    report = ScreenshotValidator([Store.APPLE]).validate_set(empty)
    assert codes(report.set_findings) == {"SET_EMPTY"}
    assert report.is_ok() is False


def test_clean_set_passes(screenshot_dir: Path) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_set(screenshot_dir)
    assert report.status is Status.PASS
    assert report.is_ok(strict=True) is True
    assert len(report.assets) == 3


def test_apple_rejects_more_than_ten_per_display_class(
    tmp_path: Path, make_image: MakeImage
) -> None:
    directory = tmp_path / "many"
    for i in range(11):
        make_image(name=f"s{i:02d}.png", size=APPLE_6_5, directory=directory)

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    assert "APPLE_TOO_MANY_PER_CLASS" in codes(report.set_findings)


def test_play_requires_at_least_two(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "one"
    make_image(name="only.png", size=PLAY_FHD, directory=directory)

    report = ScreenshotValidator([Store.GOOGLE]).validate_set(directory)
    assert "GOOGLE_TOO_FEW" in codes(report.set_findings)


def test_mixed_sizes_warn(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "mixed"
    make_image(name="a.png", size=APPLE_6_5, directory=directory)
    make_image(name="b.png", size=APPLE_6_9, directory=directory)

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    mixed = next(f for f in report.set_findings if f.code == "SET_MIXED_SIZES")
    assert mixed.severity is Severity.WARNING


# --- strictness, suppression, detection ----------------------------------


def test_strict_mode_promotes_warnings_to_failure(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "legacy"
    for i in range(2):
        make_image(name=f"s{i}.png", size=APPLE_LEGACY_6_5, directory=directory)

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    assert report.error_count == 0
    assert report.warning_count > 0
    assert report.is_ok() is True
    assert report.is_ok(strict=True) is False


def test_suppress_findings_removes_only_named_codes(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "legacy"
    for i in range(2):
        make_image(name=f"s{i}.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=directory)

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    assert "APPLE_ALPHA_CHANNEL" in codes(report.all_findings)

    suppressed = suppress_findings(report, ["APPLE_ALPHA_CHANNEL"])
    assert "APPLE_ALPHA_CHANNEL" not in codes(suppressed.all_findings)
    assert "APPLE_LEGACY_SIZE" in codes(suppressed.all_findings)


def test_suppress_with_no_codes_is_a_noop(screenshot_dir: Path) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_set(screenshot_dir)
    assert suppress_findings(report, []) is report


@pytest.mark.parametrize(
    ("size", "expected"),
    [
        (APPLE_6_9, Store.APPLE),
        (PLAY_FHD, Store.GOOGLE),
    ],
)
def test_detect_target_store(
    tmp_path: Path, make_image: MakeImage, size: tuple[int, int], expected: Store
) -> None:
    directory = tmp_path / f"d{size[0]}"
    for i in range(2):
        make_image(name=f"s{i}.png", size=size, directory=directory)

    assert detect_target_store(directory) is expected


def test_detect_target_store_defaults_to_apple_when_empty(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert detect_target_store(empty) is Store.APPLE


def test_validator_defaults_to_both_stores() -> None:
    assert ScreenshotValidator().stores == [Store.APPLE, Store.GOOGLE]
