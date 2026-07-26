"""CLI tests.

These assert on exit codes and ``--json`` payloads rather than on the rich
tables: the rendered output wraps to terminal width and changes with cosmetic
tweaks, so asserting on it produces brittle tests that fail for the wrong
reasons. Exit codes and JSON are the actual contract with CI users.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from launchpilot import __version__
from launchpilot.cli.console import ExitCode
from launchpilot.cli.main import app
from tests.conftest import APPLE_6_9, APPLE_LEGACY_6_5, PLAY_FHD, MakeImage

runner = CliRunner()

_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def run(*args: str) -> Any:
    return runner.invoke(app, list(args))


def plain(result: Any) -> str:
    """stdout with styling removed.

    CI sets ``FORCE_COLOR``, so rich emits escape sequences there but not on a
    plain local terminal. Stripping them keeps these assertions from depending
    on whether colour happens to be enabled.
    """
    return _ANSI.sub("", result.stdout)


def payload(result: Any) -> Any:
    return json.loads(result.stdout)


# --- entry point ---------------------------------------------------------


def test_no_args_shows_help() -> None:
    assert run().exit_code == int(ExitCode.USAGE)


def test_version_flag() -> None:
    result = run("--version")
    assert result.exit_code == int(ExitCode.OK)
    assert __version__ in plain(result)


def test_version_output_is_greppable() -> None:
    """Regression: rich's number highlighter used to split "0.1.0" mid-string."""
    result = run("--version")
    assert f"launchpilot {__version__}" in plain(result)


# --- validate-screenshots ------------------------------------------------


def test_validate_clean_directory_exits_zero(screenshot_dir: Path) -> None:
    result = run("validate-screenshots", str(screenshot_dir), "--store", "apple")
    assert result.exit_code == int(ExitCode.OK)


def test_validate_with_errors_exits_one(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "bad"
    make_image(name="a.png", size=APPLE_6_9, mode="RGBA", directory=directory)

    result = run("validate-screenshots", str(directory), "--store", "apple")
    assert result.exit_code == int(ExitCode.FINDINGS)


def test_validate_missing_directory_exits_two(tmp_path: Path) -> None:
    result = run("validate-screenshots", str(tmp_path / "nope"))
    assert result.exit_code == int(ExitCode.USAGE)


def test_validate_json_output_is_machine_readable(screenshot_dir: Path) -> None:
    result = run("validate-screenshots", str(screenshot_dir), "--store", "apple", "--json")
    data = payload(result)

    assert data["status"] == "pass"
    assert data["error_count"] == 0
    assert len(data["assets"]) == 3
    assert data["assets"][0]["facts"]["width"] == 1284


def test_validate_json_exposes_finding_codes(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "bad"
    make_image(name="a.png", size=APPLE_6_9, mode="RGBA", directory=directory)

    result = run("validate-screenshots", str(directory), "--store", "apple", "--json")
    codes = {f["code"] for a in payload(result)["assets"] for f in a["findings"]}
    assert "APPLE_ALPHA_CHANNEL" in codes


def test_strict_turns_warnings_into_a_failure(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "legacy"
    for i in range(2):
        make_image(name=f"s{i}.png", size=APPLE_LEGACY_6_5, directory=directory)

    assert run("validate-screenshots", str(directory), "-s", "apple").exit_code == 0
    assert run("validate-screenshots", str(directory), "-s", "apple", "--strict").exit_code == int(
        ExitCode.FINDINGS
    )


def test_ignore_suppresses_a_code(tmp_path: Path, make_image: MakeImage) -> None:
    directory = tmp_path / "bad"
    for i in range(2):
        make_image(name=f"s{i}.png", size=APPLE_6_9, mode="RGBA", directory=directory)

    assert run("validate-screenshots", str(directory), "-s", "apple").exit_code == 1
    result = run(
        "validate-screenshots", str(directory), "-s", "apple", "--ignore", "APPLE_ALPHA_CHANNEL"
    )
    assert result.exit_code == int(ExitCode.OK)


def test_empty_directory_exits_one(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    result = run("validate-screenshots", str(empty), "--store", "apple", "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)
    assert payload(result)["set_findings"][0]["code"] == "SET_EMPTY"


@pytest.mark.parametrize(
    ("size", "expected_store"),
    [(APPLE_6_9, "apple"), (PLAY_FHD, "google")],
)
def test_auto_store_detection(
    tmp_path: Path, make_image: MakeImage, size: tuple[int, int], expected_store: str
) -> None:
    directory = tmp_path / f"d{size[0]}"
    for i in range(2):
        make_image(name=f"s{i}.png", size=size, directory=directory)

    result = run("validate-screenshots", str(directory), "--json")
    assert payload(result)["stores"] == [expected_store]


def test_store_both_checks_against_both(screenshot_dir: Path) -> None:
    result = run("validate-screenshots", str(screenshot_dir), "--store", "both", "--json")
    assert payload(result)["stores"] == ["apple", "google"]


# --- fix-screenshots -----------------------------------------------------


def test_fix_without_out_is_a_dry_run(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)

    result = run("fix-screenshots", str(source), "--store", "apple", "--json")
    assert result.exit_code == int(ExitCode.OK)
    assert payload(result)["dry_run"] is True
    assert list(source.iterdir()) == [source / "a.png"]


def test_fix_writes_to_the_output_directory(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)
    out = tmp_path / "out"

    result = run("fix-screenshots", str(source), "--out", str(out), "--store", "apple")
    assert result.exit_code == int(ExitCode.OK)
    assert (out / "a.png").exists()


def test_fix_then_validate_round_trip(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    for i in range(3):
        make_image(name=f"s{i}.png", size=APPLE_LEGACY_6_5, mode="RGBA", directory=source)
    out = tmp_path / "out"

    run("fix-screenshots", str(source), "--out", str(out), "--store", "apple")
    result = run("validate-screenshots", str(out), "--store", "apple", "--strict")
    assert result.exit_code == int(ExitCode.OK)


def test_fix_rejects_store_both(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_6_9, directory=source)

    result = run("fix-screenshots", str(source), "--store", "both")
    assert result.exit_code == int(ExitCode.USAGE)


def test_fix_rejects_an_unknown_target(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_6_9, directory=source)

    result = run("fix-screenshots", str(source), "-s", "apple", "--target", "nope")
    assert result.exit_code == int(ExitCode.USAGE)


def test_fix_rejects_an_invalid_background(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_6_9, directory=source)

    result = run("fix-screenshots", str(source), "-s", "apple", "-b", "chartreusey")
    assert result.exit_code == int(ExitCode.USAGE)


def test_fix_refuses_to_overwrite_the_source(tmp_path: Path, make_image: MakeImage) -> None:
    source = tmp_path / "src"
    make_image(name="a.png", size=APPLE_LEGACY_6_5, directory=source)

    result = run("fix-screenshots", str(source), "--out", str(source), "-s", "apple")
    assert result.exit_code == int(ExitCode.USAGE)


# --- check-testers -------------------------------------------------------


def test_check_testers_eligible_exits_zero() -> None:
    result = run("check-testers", "--days-passed", "14", "--active-testers", "12")
    assert result.exit_code == int(ExitCode.OK)


def test_check_testers_not_yet_exits_one() -> None:
    result = run("check-testers", "-d", "9", "-t", "12", "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)

    data = payload(result)
    assert data["eligible"] is False
    assert data["days_remaining"] == 5


def test_check_testers_requires_input() -> None:
    assert run("check-testers").exit_code == int(ExitCode.USAGE)


def test_check_testers_pending_release_blocks() -> None:
    result = run("check-testers", "-d", "20", "-t", "12", "--release-pending", "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)
    codes = {r["code"] for r in payload(result)["blocking_reasons"]}
    assert "RELEASE_NOT_APPROVED" in codes


def test_check_testers_from_file_detects_a_dip(tmp_path: Path) -> None:
    import datetime as dt

    today = dt.date.today()
    counts = [12] * 10 + [11] + [12] * 9
    history = [
        {
            "date": str(today - dt.timedelta(days=len(counts) - 1 - i)),
            "opted_in": c,
        }
        for i, c in enumerate(counts)
    ]
    path = tmp_path / "history.json"
    path.write_text(json.dumps(history), encoding="utf-8")

    result = run("check-testers", "--from-file", str(path), "--json")
    data = payload(result)

    assert data["streak_was_reset"] is True
    assert data["eligible"] is False


def test_check_testers_accepts_a_wrapped_history(tmp_path: Path) -> None:
    import datetime as dt

    today = dt.date.today()
    history = {
        "history": [
            {"date": str(today - dt.timedelta(days=13 - i)), "opted_in": 12} for i in range(14)
        ]
    }
    path = tmp_path / "history.json"
    path.write_text(json.dumps(history), encoding="utf-8")

    assert run("check-testers", "--from-file", str(path)).exit_code == int(ExitCode.OK)


def test_check_testers_rejects_malformed_history(tmp_path: Path) -> None:
    path = tmp_path / "history.json"
    path.write_text('{"history": [{"date": "not-a-date", "opted_in": 12}]}', encoding="utf-8")

    assert run("check-testers", "--from-file", str(path)).exit_code == int(ExitCode.USAGE)


def test_check_testers_rejects_non_list_history(tmp_path: Path) -> None:
    path = tmp_path / "history.json"
    path.write_text('"not a list"', encoding="utf-8")

    assert run("check-testers", "--from-file", str(path)).exit_code == int(ExitCode.USAGE)


def test_check_testers_custom_thresholds() -> None:
    result = run(
        "check-testers", "-d", "7", "-t", "20", "--required-testers", "20", "--required-days", "7"
    )
    assert result.exit_code == int(ExitCode.OK)


# --- validate-metadata ---------------------------------------------------


def _write_listing(tmp_path: Path, **fields: Any) -> Path:
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(fields), encoding="utf-8")
    return path


def test_validate_metadata_clean_exits_zero(tmp_path: Path) -> None:
    path = _write_listing(
        tmp_path,
        title="Kaizen",
        short_description="Build habits.",
        description="Kaizen helps you build habits.",
    )
    assert run("validate-metadata", str(path)).exit_code == int(ExitCode.OK)


def test_validate_metadata_too_long_exits_one(tmp_path: Path) -> None:
    path = _write_listing(
        tmp_path,
        title="K" * 40,
        short_description="Build habits.",
        description="Kaizen helps you build habits.",
    )
    result = run("validate-metadata", str(path), "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)

    codes = {f["code"] for loc in payload(result)["locales"] for f in loc["findings"]}
    assert "APPLE_TITLE_TOO_LONG" in codes


def test_validate_metadata_single_store(tmp_path: Path) -> None:
    """Play has no subtitle field, so an over-length subtitle is Apple-only."""
    path = _write_listing(
        tmp_path,
        title="Kaizen",
        subtitle="S" * 40,
        short_description="Build habits.",
        description="Kaizen helps you build habits.",
    )
    assert run("validate-metadata", str(path), "-s", "google").exit_code == int(ExitCode.OK)
    assert run("validate-metadata", str(path), "-s", "apple").exit_code == int(ExitCode.FINDINGS)


def test_validate_metadata_bad_file_exits_two(tmp_path: Path) -> None:
    path = tmp_path / "listing.json"
    path.write_text("{not json", encoding="utf-8")
    assert run("validate-metadata", str(path)).exit_code == int(ExitCode.USAGE)


def test_validate_metadata_empty_locales_exits_two(tmp_path: Path) -> None:
    path = tmp_path / "listing.json"
    path.write_text(json.dumps({"locales": []}), encoding="utf-8")
    assert run("validate-metadata", str(path)).exit_code == int(ExitCode.USAGE)


# --- specs ---------------------------------------------------------------


def test_specs_lists_both_catalogues() -> None:
    result = run("specs")
    assert result.exit_code == int(ExitCode.OK)
    assert "1320×2868" in plain(result)


def test_specs_json_is_structured() -> None:
    result = run("specs", "--store", "apple", "--json")
    data = payload(result)

    assert len(data) == 1
    assert data[0]["store"] == "apple"
    assert any(s["id"] == "apple-iphone-6.9" for s in data[0]["sizes"])
    assert data[0]["last_verified"]


def test_specs_single_store() -> None:
    data = payload(run("specs", "-s", "google", "--json"))
    assert [d["store"] for d in data] == ["google"]


# --- niche ---------------------------------------------------------------


class _FakeCatalogue:
    """Stands in for the network so CLI tests stay hermetic."""

    def __init__(self, count: int, results: list[dict[str, Any]]) -> None:
        self.payload = (count, results)

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        return self.payload


def _fake_apps(n: int, ratings: int = 50) -> list[dict[str, Any]]:
    return [
        {
            "trackId": i,
            "trackName": f"App {i}",
            "sellerName": f"Dev {i}",
            "userRatingCount": ratings,
            "averageUserRating": 4.2,
            "price": 0.0,
            "genres": ["Productivity"],
            "releaseDate": "2020-01-01T00:00:00Z",
            "currentVersionReleaseDate": "2025-01-01T00:00:00Z",
        }
        for i in range(n)
    ]


@pytest.fixture
def offline_catalogue(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the niche command at a fake catalogue.

    Patched where it is looked up, not where it is defined, so the command's
    own import is the one replaced.
    """
    import launchpilot.cli.commands.niche as niche_module

    monkeypatch.setattr(
        niche_module,
        "ITunesSearchClient",
        lambda **kwargs: _FakeCatalogue(40, _fake_apps(12)),
    )


def test_niche_requires_a_keyword() -> None:
    assert run("niche").exit_code == int(ExitCode.USAGE)


def test_niche_rejects_blank_keywords(offline_catalogue: None) -> None:
    assert run("niche", "   ").exit_code == int(ExitCode.USAGE)


def test_niche_reports_a_verdict(offline_catalogue: None) -> None:
    result = run("niche", "habit tracker")
    assert result.exit_code == int(ExitCode.OK)
    assert "habit tracker" in plain(result)


def test_niche_json_carries_the_scored_signals(offline_catalogue: None) -> None:
    result = run("niche", "habit tracker", "--json")
    assert result.exit_code == int(ExitCode.OK)

    data = payload(result)
    assert data["keywords"][0]["keyword"] == "habit tracker"
    assert data["keywords"][0]["winnability"] > 0
    assert data["keywords"][0]["verdict"] in {"open", "contested", "locked"}
    assert {s["code"] for s in data["keywords"][0]["signals"]}

    # Every signal must carry its raw observation, not just a score: the whole
    # point is that a user can audit the reasoning.
    for signal in data["keywords"][0]["signals"]:
        assert "observed" in signal and "rationale" in signal and signal["rationale"]


def test_niche_json_never_invents_a_search_volume(offline_catalogue: None) -> None:
    """Apple does not publish per-keyword search counts, so neither do we."""
    raw = json.dumps(payload(run("niche", "habit tracker", "--json"))).lower()
    assert "volume" not in raw
    assert "popularity" not in raw


def test_niche_accepts_several_keywords(offline_catalogue: None) -> None:
    data = payload(run("niche", "one", "two", "three", "--json"))
    assert len(data["keywords"]) == 3


def test_niche_records_the_storefront(offline_catalogue: None) -> None:
    data = payload(run("niche", "x", "--country", "fr", "--json"))
    assert data["country"] == "FR"


def test_niche_surfaces_a_catalogue_failure_as_a_usage_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import launchpilot.cli.commands.niche as niche_module
    from launchpilot.core.clients.itunes import MarketDataError

    class Failing:
        def search(self, term: str, *, country: str, limit: int) -> Any:
            raise MarketDataError("catalogue unreachable")

    monkeypatch.setattr(niche_module, "ITunesSearchClient", lambda **kwargs: Failing())
    result = run("niche", "x")
    assert result.exit_code == int(ExitCode.USAGE)


def test_niche_leaders_flag_lists_competitors(offline_catalogue: None) -> None:
    result = run("niche", "habit tracker", "--leaders")
    assert result.exit_code == int(ExitCode.OK)
    assert "App 0" in plain(result)
