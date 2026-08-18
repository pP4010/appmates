"""Tests for ScreenshotFixer.

The safety guarantee under test throughout: the fixer never modifies its input.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from appmates.core.errors import OutputExistsError, SourceIsDestinationError
from appmates.core.models.report import Store
from appmates.core.services.image_fixer import ScreenshotFixer, targets_for
from appmates.core.services.image_validator import ScreenshotValidator
from tests.conftest import APPLE_6_5, APPLE_6_9, APPLE_LEGACY_6_5, PLAY_FHD, MakeImage


def action_codes(plan: object) -> set[str]:
    return {a.code for a in plan.actions}  # type: ignore[attr-defined]


# --- planning ------------------------------------------------------------


def test_valid_screenshot_needs_no_work(make_image: MakeImage, tmp_path: Path) -> None:
    plan = ScreenshotFixer(Store.APPLE).plan_file(make_image(size=APPLE_6_9), tmp_path / "out.png")
    assert plan.changed is False
    assert plan.actions == []


def test_plan_detects_alpha_and_legacy_size(make_image: MakeImage, tmp_path: Path) -> None:
    plan = ScreenshotFixer(Store.APPLE).plan_file(
        make_image(size=APPLE_LEGACY_6_5, mode="RGBA"), tmp_path / "out.png"
    )
    assert {"FLATTEN_ALPHA", "CONVERT_RGB", "RESIZE"} <= action_codes(plan)
    assert plan.target_size == APPLE_6_5


def test_plan_reports_unreadable_files(tmp_path: Path) -> None:
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image")

    plan = ScreenshotFixer(Store.APPLE).plan_file(broken, tmp_path / "out.png")
    assert plan.error is not None


def test_explicit_target_overrides_detection(make_image: MakeImage, tmp_path: Path) -> None:
    fixer = ScreenshotFixer(Store.APPLE, target_spec_id="apple-iphone-6.9")
    plan = fixer.plan_file(make_image(size=APPLE_6_5), tmp_path / "out.png")
    assert plan.target_size == APPLE_6_9


def test_landscape_input_keeps_landscape_orientation(make_image: MakeImage, tmp_path: Path) -> None:
    landscape = make_image(size=(APPLE_LEGACY_6_5[1], APPLE_LEGACY_6_5[0]))
    plan = ScreenshotFixer(Store.APPLE).plan_file(landscape, tmp_path / "out.png")
    assert plan.target_size == (APPLE_6_5[1], APPLE_6_5[0])


def test_invalid_background_colour_raises() -> None:
    with pytest.raises(ValueError):
        ScreenshotFixer(Store.APPLE, background="not-a-colour")


# --- execution -----------------------------------------------------------


def test_fix_produces_output_that_validates_clean(tmp_path: Path, make_image: MakeImage) -> None:
    """The round trip that matters: broken input in, store-ready output out."""
    source = tmp_path / "src"
    for i in range(3):
        make_image(name=f"s{i}.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)

    out = tmp_path / "out"
    result = ScreenshotFixer(Store.APPLE).fix_directory(source, out)

    assert result.changed_count == 3
    assert result.failed == []

    report = ScreenshotValidator([Store.APPLE]).validate_set(out)
    assert report.is_ok(strict=True) is True


def test_originals_are_never_modified(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    original = make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)
    before = original.read_bytes()

    ScreenshotFixer(Store.APPLE).fix_directory(source, tmp_path / "out")

    assert original.read_bytes() == before
    with Image.open(original) as img:
        assert img.mode == "RGBA"
        assert img.size == APPLE_LEGACY_6_5


def test_alpha_is_flattened_onto_the_chosen_background(
    tmp_path: Path, make_image: MakeImage
) -> None:
    source = tmp_path / "src"
    make_image(
        name="a.png",
        size=APPLE_6_5,
        mode="RGBA",
        color=(0, 0, 0, 0),  # fully transparent
        directory=source,
    )
    out = tmp_path / "out"
    ScreenshotFixer(Store.APPLE, background="#FF0000").fix_directory(source, out)

    with Image.open(out / "a.png") as img:
        assert img.mode == "RGB"
        assert img.getpixel((10, 10)) == (255, 0, 0)


def test_resize_letterboxes_instead_of_stretching(tmp_path: Path, make_image: MakeImage) -> None:
    """A 1:1 source padded to a tall target must keep its square content."""
    source = tmp_path / "src"
    make_image(name="sq.png", size=(1000, 1000), color="blue", directory=source)

    out = tmp_path / "out"
    ScreenshotFixer(
        Store.APPLE, target_spec_id="apple-iphone-6.9", background="#FFFFFF"
    ).fix_directory(source, out)

    with Image.open(out / "sq.png") as img:
        assert img.size == APPLE_6_9
        # Padding at the top, original content through the middle.
        assert img.getpixel((660, 5)) == (255, 255, 255)
        assert img.getpixel((660, 1434)) == (0, 0, 255)


def test_dry_run_writes_nothing(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)
    out = tmp_path / "out"

    result = ScreenshotFixer(Store.APPLE).fix_directory(source, out, dry_run=True)

    assert result.dry_run is True
    assert result.changed_count == 1
    assert not out.exists()


def test_dry_run_tolerates_source_as_destination(tmp_path: Path, make_image: MakeImage) -> None:
    """The CLI passes the source dir as a placeholder when --out is omitted."""
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, directory=source)

    result = ScreenshotFixer(Store.APPLE).fix_directory(source, source, dry_run=True)
    assert result.changed_count == 1


# --- safety guards -------------------------------------------------------


def test_refuses_to_write_over_the_source_directory(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_6_5, directory=source)

    with pytest.raises(SourceIsDestinationError):
        ScreenshotFixer(Store.APPLE).fix_directory(source, source)


def test_refuses_a_non_empty_output_directory(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, directory=source)
    out = tmp_path / "out"
    out.mkdir()
    (out / "existing.txt").write_text("do not clobber me")

    with pytest.raises(OutputExistsError):
        ScreenshotFixer(Store.APPLE).fix_directory(source, out)


def test_force_allows_a_non_empty_output_directory(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, directory=source)
    out = tmp_path / "out"
    out.mkdir()
    (out / "existing.txt").write_text("replaceable")

    result = ScreenshotFixer(Store.APPLE).fix_directory(source, out, force=True)
    assert result.changed_count == 1


def test_empty_output_directory_is_acceptable(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, directory=source)
    out = tmp_path / "out"
    out.mkdir()

    assert ScreenshotFixer(Store.APPLE).fix_directory(source, out).changed_count == 1


# --- compression ---------------------------------------------------------


def test_oversized_png_is_recompressed_under_the_play_limit(
    tmp_path: Path, make_image: MakeImage
) -> None:
    source = tmp_path / "src"
    make_image(
        name="big.png",
        size=PLAY_FHD,
        directory=source,
        padding_bytes=9 * 1024 * 1024,
    )
    out = tmp_path / "out"
    ScreenshotFixer(Store.GOOGLE).fix_directory(source, out)

    written = list(out.iterdir())
    assert len(written) == 1
    assert written[0].stat().st_size <= 8 * 1024 * 1024


def test_jpeg_input_stays_jpeg(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.jpg", size=APPLE_LEGACY_6_5, directory=source)
    out = tmp_path / "out"

    ScreenshotFixer(Store.APPLE).fix_directory(source, out)
    with Image.open(out / "a.jpg") as img:
        assert img.format == "JPEG"


# --- helpers -------------------------------------------------------------


def test_targets_for_excludes_legacy_sizes() -> None:
    ids = {s.id for s in targets_for(Store.APPLE)}
    assert "apple-iphone-6.9" in ids
    assert "apple-iphone-6.5-legacy" not in ids
