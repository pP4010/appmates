"""Tests for settings and the rich rendering layer.

The renderers are exercised through a real ``Console`` writing to a string
buffer. The assertions stay coarse — that a renderable is produced and key
facts appear — because pinning exact layout would break on every cosmetic
change without catching real bugs.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
from rich.console import Console

from launchpilot.core.config import Settings, get_settings
from launchpilot.core.models.app_metadata import AppListing, AppMetadata
from launchpilot.core.models.report import Severity, Store
from launchpilot.core.services.google_play import evaluate, flat_history
from launchpilot.core.services.image_fixer import ScreenshotFixer
from launchpilot.core.services.image_validator import ScreenshotValidator
from launchpilot.core.services.metadata_validator import MetadataValidator
from launchpilot.core.services.reporting import (
    render_fix_result,
    render_metadata,
    render_specs,
    render_testing_status,
    render_validation,
    severity_text,
)
from launchpilot.core.specs.registry import all_specs
from tests.conftest import APPLE_6_5, APPLE_LEGACY_6_5, MakeImage


def draw(renderable: object) -> str:
    console = Console(file=None, width=120, record=True)
    with console.capture() as capture:
        console.print(renderable)
    return capture.get()


# --- settings ------------------------------------------------------------


def test_defaults(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)  # avoid picking up a developer's own .env
    settings = Settings()

    assert settings.strict is False
    assert settings.max_screenshot_bytes == 8 * 1024 * 1024
    assert settings.has_google_credentials is False
    assert settings.has_apple_credentials is False


def test_env_prefix_is_honoured(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LAUNCHPILOT_STRICT", "true")
    monkeypatch.setenv("LAUNCHPILOT_MAX_SCREENSHOT_BYTES", "1024")

    settings = Settings()
    assert settings.strict is True
    assert settings.max_screenshot_bytes == 1024


def test_google_credentials_detected(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LAUNCHPILOT_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "/tmp/sa.json")

    assert Settings().has_google_credentials is True


def test_apple_credentials_need_all_three(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_KEY_ID", "ABC123")
    assert Settings().has_apple_credentials is False

    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_ISSUER_ID", "issuer")
    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_PRIVATE_KEY_PATH", "/tmp/key.p8")
    assert Settings().has_apple_credentials is True


def test_get_settings_is_not_cached(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A long-running API process must see env changes between requests."""
    monkeypatch.chdir(tmp_path)
    assert get_settings().strict is False

    monkeypatch.setenv("LAUNCHPILOT_STRICT", "true")
    assert get_settings().strict is True


def test_unknown_env_vars_are_ignored(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LAUNCHPILOT_NOT_A_REAL_SETTING", "x")
    assert Settings().strict is False


# --- rendering -----------------------------------------------------------


@pytest.mark.parametrize("severity", list(Severity))
def test_severity_text_is_styled(severity: Severity) -> None:
    assert severity.value in severity_text(severity).plain


def test_render_validation_shows_findings_and_hints(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "shots"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=directory)
    make_image(name="b.png", size=APPLE_6_5, directory=directory)

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    out = draw(render_validation(report))

    assert "APPLE_ALPHA_CHANNEL" in out
    assert "SET_MIXED_SIZES" in out  # directory-level panel rendered
    assert "FAIL" in out


def test_render_validation_marks_clean_files(screenshot_dir: Path) -> None:
    report = ScreenshotValidator([Store.APPLE]).validate_set(screenshot_dir)
    out = draw(render_validation(report))

    assert "clean" in out
    assert "PASS" in out


def test_render_validation_handles_unreadable_files(tmp_path: Path) -> None:
    directory = tmp_path / "shots"
    directory.mkdir()
    (directory / "broken.png").write_bytes(b"nope")

    report = ScreenshotValidator([Store.APPLE]).validate_set(directory)
    assert "UNREADABLE_IMAGE" in draw(render_validation(report))


def test_render_metadata(tmp_path: Path) -> None:
    listing = AppListing(
        locales=[
            AppMetadata(locale="en-US", title="K" * 40, description="Hi", short_description="Hi"),
            AppMetadata(
                locale="fr-FR", title="Kaizen", description="Salut", short_description="Salut"
            ),
        ]
    )
    out = draw(render_metadata(MetadataValidator([Store.APPLE]).validate_listing(listing)))

    assert "APPLE_TITLE_TOO_LONG" in out
    assert "fr-FR" in out
    assert "clean" in out


def test_render_testing_status_in_progress(today: dt.date) -> None:
    status = evaluate(flat_history(9, 12, today=today), today=today)
    out = draw(render_testing_status(status, synthetic=True))

    assert "NOT YET ELIGIBLE" in out
    assert "9 / 14" in out
    assert "flat tester count" in out  # the synthetic-data caveat


def test_render_testing_status_eligible(today: dt.date) -> None:
    status = evaluate(flat_history(14, 12, today=today), today=today)
    out = draw(render_testing_status(status))

    assert "ELIGIBLE" in out
    assert "flat tester count" not in out


def test_render_testing_status_shows_a_reset(today: dt.date, history_factory: object) -> None:
    counts = [12] * 10 + [11] + [12] * 9
    status = evaluate(history_factory(counts), today=today)  # type: ignore[operator]
    out = draw(render_testing_status(status))

    assert "Reset" in out
    assert "restarted" in out


def test_render_fix_result_dry_run(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)
    make_image(name="b.png", size=APPLE_6_5, directory=source)

    result = ScreenshotFixer(Store.APPLE).fix_directory(source, tmp_path / "out", dry_run=True)
    out = draw(render_fix_result(result))

    assert "dry run" in out
    assert "FLATTEN_ALPHA" in out
    assert "nothing to do" in out  # the already-valid file


def test_render_fix_result_reports_failures(tmp_path: Path) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / "broken.png").write_bytes(b"not an image")

    result = ScreenshotFixer(Store.APPLE).fix_directory(source, tmp_path / "out", dry_run=True)
    assert len(result.failed) == 1
    assert "broken.png" in draw(render_fix_result(result))


def test_render_specs_includes_provenance() -> None:
    out = draw(render_specs(all_specs()))

    assert "1320×2868" in out
    assert "legacy" in out
    assert "developer.apple.com" in out
    assert "forbidden" in out  # alpha rule summary
