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

import httpx
import pytest
from typer.testing import CliRunner

from appmates import __version__
from appmates.cli.console import ExitCode
from appmates.cli.main import app
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
    assert f"appmates {__version__}" in plain(result)


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
    import appmates.cli.commands.niche as niche_module

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
    import appmates.cli.commands.niche as niche_module
    from appmates.core.clients.itunes import MarketDataError

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


# --- keywords ------------------------------------------------------------


def test_keywords_requires_something_to_work_with() -> None:
    assert run("keywords").exit_code == int(ExitCode.USAGE)


def test_keywords_audits_a_field_and_exits_one_on_errors() -> None:
    result = run("keywords", "--title", "Habit Tracker", "--field", "habit, streak")
    assert result.exit_code == int(ExitCode.FINDINGS)


def test_keywords_clean_field_exits_zero() -> None:
    result = run("keywords", "--title", "Kaizen", "--field", "habit,streak")
    assert result.exit_code == int(ExitCode.OK)


def test_keywords_json_reports_waste_and_coverage() -> None:
    result = run(
        "keywords",
        "--title",
        "Kaizen: Habit Tracker",
        "--field",
        "habit, habits, app, free",
        "-t",
        "habit tracker",
        "-t",
        "gratitude journal",
        "--json",
    )
    data = payload(result)
    assert data["length"] == len("habit, habits, app, free")
    assert data["wasted_characters"] > 0
    assert data["uncovered_targets"] == ["gratitude journal"]
    assert {c["code"] for c in data["findings"]}


def test_keywords_build_prints_only_the_field() -> None:
    result = run(
        "keywords", "--title", "Kaizen", "-t", "habit tracker", "-t", "morning streak", "--build"
    )
    assert result.exit_code == int(ExitCode.OK)
    field = plain(result).strip()
    assert " " not in field
    assert set(field.split(",")) == {"habit", "tracker", "morning", "streak"}


def test_keywords_builds_from_targets_when_no_field_is_given() -> None:
    data = payload(run("keywords", "--title", "Kaizen", "-t", "habit tracker", "--json"))
    assert data["field_value"]
    assert data["uncovered_targets"] == []


def test_keywords_reads_a_listing_file(tmp_path: Path) -> None:
    listing = tmp_path / "listing.toml"
    listing.write_text(
        "[[locales]]\n"
        'locale = "en-US"\n'
        'title = "Kaizen: Habit Tracker"\n'
        'subtitle = "Build daily routines"\n'
        'keywords = "habit, habits, app"\n',
        encoding="utf-8",
    )
    data = payload(run("keywords", str(listing), "--json"))
    assert data["title"] == "Kaizen: Habit Tracker"
    assert data["wasted_characters"] > 0


def test_keywords_rejects_an_unknown_locale(tmp_path: Path) -> None:
    listing = tmp_path / "listing.toml"
    listing.write_text(
        '[[locales]]\nlocale = "en-US"\ntitle = "X"\nkeywords = "a"\n', encoding="utf-8"
    )
    result = run("keywords", str(listing), "--locale", "fr-FR")
    assert result.exit_code == int(ExitCode.USAGE)


def test_keywords_rejects_a_missing_file(tmp_path: Path) -> None:
    assert run("keywords", str(tmp_path / "nope.toml")).exit_code == int(ExitCode.USAGE)


# --- competitors / rank --------------------------------------------------


def _competitor_entries(n: int = 5, *, with_shots: bool = True) -> list[dict[str, Any]]:
    return [
        {
            "trackId": i,
            "trackName": f"Rival {i}",
            "sellerName": f"Studio {i}",
            "userRatingCount": 500 * (i + 1),
            "averageUserRating": 4.5,
            "price": 0.0,
            "currentVersionReleaseDate": "2026-06-01T00:00:00Z",
            "screenshotUrls": (
                [f"https://cdn/{i}-{k}.png/392x696bb.png" for k in range(5)] if with_shots else []
            ),
            "ipadScreenshotUrls": [],
        }
        for i in range(n)
    ]


class _FakeCompetitorSource:
    def __init__(self, entries: list[dict[str, Any]], app: dict[str, Any] | None = None) -> None:
        self.entries = entries
        self.app = app

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        return len(self.entries), self.entries

    def lookup(self, app_id: str, *, country: str) -> dict[str, Any] | None:
        return self.app


@pytest.fixture
def offline_competitors(monkeypatch: pytest.MonkeyPatch) -> None:
    import appmates.cli.commands.competitors as module

    monkeypatch.setattr(
        module,
        "ITunesSearchClient",
        lambda **kwargs: _FakeCompetitorSource(
            _competitor_entries(), app={"trackId": 2, "trackName": "Mine"}
        ),
    )


def test_competitors_lists_the_field(offline_competitors: None) -> None:
    result = run("competitors", "habit tracker", "--top", "3")
    assert result.exit_code == int(ExitCode.OK)
    assert "Rival 0" in plain(result)


def test_competitors_json_separates_iphone_and_ipad_counts(offline_competitors: None) -> None:
    data = payload(run("competitors", "habit tracker", "--json"))
    app = data["apps"][0]
    assert app["position"] == 1
    assert app["iphone_count"] == 5
    assert app["ipad_count"] == 0
    assert app["screenshots_exposed"] is True


def test_competitors_json_reports_the_niche_strategy(offline_competitors: None) -> None:
    data = payload(run("competitors", "habit tracker", "--json"))
    strategy = data["strategy"]
    assert strategy["median_count"] == 5
    assert strategy["apps_sampled"] == 5
    assert strategy["coverage_percent"] == 100.0


def test_competitors_screenshots_flag_lists_urls(offline_competitors: None) -> None:
    result = run("competitors", "habit tracker", "--screenshots")
    assert "392x696" in plain(result) or "cdn" in plain(result)


def test_competitors_marks_withheld_screenshots(monkeypatch: pytest.MonkeyPatch) -> None:
    import appmates.cli.commands.competitors as module

    monkeypatch.setattr(
        module,
        "ITunesSearchClient",
        lambda **kwargs: _FakeCompetitorSource(_competitor_entries(with_shots=False)),
    )
    data = payload(run("competitors", "x", "--json"))
    assert all(a["screenshots_exposed"] is False for a in data["apps"])
    assert data["strategy"]["apps_missing"] == 5


def test_competitors_surfaces_a_catalogue_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    import appmates.cli.commands.competitors as module
    from appmates.core.clients.itunes import MarketDataError

    class Failing:
        def search(self, term: str, *, country: str, limit: int) -> Any:
            raise MarketDataError("unreachable")

    monkeypatch.setattr(module, "ITunesSearchClient", lambda **kwargs: Failing())
    assert run("competitors", "x").exit_code == int(ExitCode.USAGE)


def test_rank_reports_a_position(offline_competitors: None) -> None:
    data = payload(run("rank", "2", "habit tracker", "--json"))
    assert data["app_name"] == "Mine"
    assert data["positions"][0]["position"] == 3
    assert data["positions"][0]["found"] is True


def test_rank_requires_a_keyword(offline_competitors: None) -> None:
    assert run("rank", "2").exit_code == int(ExitCode.USAGE)


def test_rank_rejects_an_unknown_app(monkeypatch: pytest.MonkeyPatch) -> None:
    import appmates.cli.commands.competitors as module

    monkeypatch.setattr(
        module, "ITunesSearchClient", lambda **kwargs: _FakeCompetitorSource([], app=None)
    )
    result = run("rank", "999999", "habit tracker")
    assert result.exit_code == int(ExitCode.USAGE)


def test_rank_writes_and_reads_its_history(offline_competitors: None, tmp_path: Path) -> None:
    history = tmp_path / "h.jsonl"
    run("rank", "2", "habit tracker", "--history", str(history))
    assert history.is_file()

    data = payload(run("rank", "2", "habit tracker", "--history", str(history), "--json"))
    assert data["positions"][0]["previous_position"] == 3
    assert data["positions"][0]["movement"] == 0


# --- markets -------------------------------------------------------------


@pytest.fixture
def offline_markets(monkeypatch: pytest.MonkeyPatch) -> None:
    import appmates.cli.commands.markets as module

    class ByCountry:
        def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[Any]]:
            # The US field is entrenched; France is wide open.
            ratings = 200_000 if country == "us" else 20
            count = 60 if country == "us" else 3
            entries = [
                {
                    "trackId": i,
                    "trackName": f"App {i}",
                    "sellerName": f"Dev {i}",
                    "userRatingCount": ratings,
                    "averageUserRating": 4.8,
                    "price": 0.0,
                    "currentVersionReleaseDate": "2026-07-20T00:00:00Z",
                }
                for i in range(count)
            ]
            return len(entries), entries

    monkeypatch.setattr(module, "ITunesSearchClient", lambda **kwargs: ByCountry())


def test_markets_scans_the_requested_storefronts(offline_markets: None) -> None:
    data = payload(run("markets", "habit tracker", "--countries", "us,fr", "--json"))
    assert {r["country"] for r in data["results"]} == {"us", "fr"}


def test_markets_ranks_the_open_storefront_first(offline_markets: None) -> None:
    data = payload(run("markets", "x", "--countries", "us,fr", "--json"))
    assert data["best_country"] == "fr"
    assert data["spread"] > 0


def test_markets_reports_when_verdicts_differ(offline_markets: None) -> None:
    data = payload(run("markets", "x", "--countries", "us,fr", "--json"))
    assert data["verdicts_differ"] is True


def test_markets_renders_a_table(offline_markets: None) -> None:
    result = run("markets", "x", "--countries", "us,fr")
    assert result.exit_code == int(ExitCode.OK)
    text = plain(result)
    assert "France" in text and "United States" in text


def test_markets_defaults_to_the_curated_set(offline_markets: None) -> None:
    from appmates.core.services.market_scanner import DEFAULT_STOREFRONTS

    data = payload(run("markets", "x", "--json"))
    assert len(data["results"]) == len(DEFAULT_STOREFRONTS)


# --- competitor terms ----------------------------------------------------


def test_competitors_terms_are_absent_unless_asked_for_or_json(
    offline_competitors: None,
) -> None:
    assert "What this field targets" not in plain(run("competitors", "x"))


def test_competitors_terms_flag_shows_the_shared_vocabulary(
    offline_competitors: None,
) -> None:
    result = run("competitors", "x", "--terms")
    assert result.exit_code == int(ExitCode.OK)
    assert "What this field targets" in plain(result)


def test_competitors_json_marks_terms_you_already_have(offline_competitors: None) -> None:
    data = payload(run("competitors", "x", "--json", "--mine", "Rival Tracker"))
    marked = {t["term"]: t["in_your_listing"] for t in data["terms"]}
    assert marked.get("rival") is True


# --- app -------------------------------------------------------------------


def _app_entry(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "trackId": 6768688178,
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
        "languageCodesISO2A": ["EN"],
        "supportedDevices": ["iPhone13-iPhone13"],
        "screenshotUrls": [],
        "ipadScreenshotUrls": [],
    }
    base.update(overrides)
    return base


class _FakeAppSource:
    def __init__(self, entry: dict[str, Any], page_shots: dict[str, list[str]] | None) -> None:
        self.entry = entry
        self.page_shots = page_shots

    def lookup(self, app_id: str, *, country: str) -> dict[str, Any] | None:
        return self.entry

    def fetch_page_screenshots(self, track_id: int, *, country: str) -> dict[str, list[str]] | None:
        return self.page_shots


def _offline_app(monkeypatch: pytest.MonkeyPatch, entry: dict[str, Any], page_shots: Any) -> None:
    import appmates.cli.commands.app as module

    monkeypatch.setattr(
        module, "ITunesSearchClient", lambda **kwargs: _FakeAppSource(entry, page_shots)
    )


def test_app_falls_back_to_the_page_when_the_catalogue_withholds_screenshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _offline_app(
        monkeypatch,
        _app_entry(),
        {"iphone": ["https://cdn/a.jpg/1242x2688bb.jpg"] * 3, "ipad": []},
    )
    result = run("app", "6768688178")
    assert result.exit_code == int(ExitCode.OK)
    assert "recovered from the App Store product page" in plain(result)


def test_app_json_marks_recovered_screenshots(monkeypatch: pytest.MonkeyPatch) -> None:
    _offline_app(
        monkeypatch,
        _app_entry(),
        {"iphone": ["https://cdn/a.jpg/1242x2688bb.jpg"] * 3, "ipad": []},
    )
    data = payload(run("app", "6768688178", "--json"))
    assert data["screenshots_recovered_from_page"] is True
    assert data["profile"]["screenshots_exposed"] is True


def test_app_stays_unanswerable_when_the_page_fallback_finds_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _offline_app(monkeypatch, _app_entry(), None)
    result = run("app", "6768688178")
    assert result.exit_code == int(ExitCode.OK)
    assert "recovered from the App Store product page" not in plain(result)


def test_app_recovers_iphone_shots_even_when_the_catalogue_has_ipad_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The catalogue returning iPad shots without iPhone ones is a known,
    common quirk (roughly half of apps) — not a reason to skip recovering the
    iPhone set a developer actually came here to check."""
    _offline_app(
        monkeypatch,
        _app_entry(screenshotUrls=[], ipadScreenshotUrls=["https://cdn/pad.jpg/2048x2732bb.jpg"]),
        {"iphone": ["https://cdn/a.jpg/1242x2688bb.jpg"] * 3, "ipad": []},
    )
    data = payload(run("app", "6768688178", "--json"))
    assert data["screenshots_recovered_from_page"] is True
    assert len(data["profile"]["iphone_screenshots"]) == 3
    # The catalogue's own iPad shots are kept rather than overwritten by the
    # page fallback's (empty, in this case) iPad set.
    assert data["profile"]["ipad_screenshots"] == ["https://cdn/pad.jpg/2048x2732bb.jpg"]


def test_app_does_not_call_the_fallback_when_the_catalogue_has_screenshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    class _CountingSource(_FakeAppSource):
        def fetch_page_screenshots(
            self, track_id: int, *, country: str
        ) -> dict[str, list[str]] | None:
            nonlocal calls
            calls += 1
            return super().fetch_page_screenshots(track_id, country=country)

    import appmates.cli.commands.app as module

    monkeypatch.setattr(
        module,
        "ITunesSearchClient",
        lambda **kwargs: _CountingSource(
            _app_entry(screenshotUrls=["https://cdn/a.jpg/1242x2688bb.jpg"] * 3), None
        ),
    )
    run("app", "6768688178")
    assert calls == 0


# --- pricing ---------------------------------------------------------------


def test_pricing_exits_zero() -> None:
    assert run("pricing", "9.99").exit_code == int(ExitCode.OK)


def test_pricing_ppp_tier_scales_lower_income_storefronts() -> None:
    data = payload(run("pricing", "10", "--countries", "us,in", "--json"))
    by_country = {t["country"]: t for t in data["territories"]}
    assert by_country["us"]["suggested_price"] == 10.0
    assert by_country["in"]["suggested_price"] < 10.0


def test_pricing_uniform_model_charges_the_same_everywhere() -> None:
    data = payload(run("pricing", "10", "--model", "uniform", "--countries", "us,in", "--json"))
    prices = {t["suggested_price"] for t in data["territories"]}
    assert prices == {10.0}


def test_pricing_unknown_model_exits_two() -> None:
    assert run("pricing", "10", "--model", "bogus").exit_code == int(ExitCode.USAGE)


# --- submission-check --------------------------------------------------


def test_submission_check_with_no_input_exits_two() -> None:
    assert run("submission-check").exit_code == int(ExitCode.USAGE)


def test_submission_check_keywords_only(tmp_path: Path) -> None:
    result = run("submission-check", "--keywords", "habit,streak", "--json")
    assert result.exit_code == int(ExitCode.OK)
    data = payload(result)
    assert data["screenshots"] is None
    assert data["metadata"] is None
    assert data["keywords"] is not None


def test_submission_check_combines_metadata_and_keywords(tmp_path: Path) -> None:
    path = _write_listing(tmp_path, title="K" * 40, description="d" * 20, keywords="habit,habit")
    result = run("submission-check", "--metadata", str(path), "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)

    data = payload(result)
    codes = {f["code"] for loc in data["metadata"]["locales"] for f in loc["findings"]}
    codes |= {f["code"] for f in data["keywords"]["findings"]}
    assert "APPLE_TITLE_TOO_LONG" in codes
    assert "ASO_DUPLICATE_IN_FIELD" in codes


def test_submission_check_screenshots(screenshot_dir: Path) -> None:
    result = run("submission-check", "--screenshots", str(screenshot_dir), "--json")
    assert result.exit_code == int(ExitCode.OK)
    assert payload(result)["screenshots"] is not None


# --- asc ---------------------------------------------------------------
#
# The client is never allowed to touch the network here: `_patch_asc_client`
# swaps `AppStoreConnectClient` for a factory that wires in an
# `httpx.MockTransport`, the same isolation `test_appstore_connect_client.py`
# and `test_asc_sync.py` use directly. `asc_key_path` (tests/conftest.py) is
# a throwaway keypair — never anything resembling a real Apple key.

_ASC_ROUTES = {
    "/apps": {"data": [{"id": "42", "type": "apps"}]},
    "/appInfos": {
        "data": [{"id": "info1", "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"}}]
    },
    "/appInfoLocalizations": {
        "data": [
            {
                "id": "iloc-en",
                "attributes": {"locale": "en-US", "name": "Kaizen", "subtitle": "Build habits"},
            }
        ]
    },
    "/appStoreVersions": {
        "data": [{"id": "v1", "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"}}]
    },
    "/appStoreVersionLocalizations": {
        "data": [
            {
                "id": "vloc-en",
                "attributes": {
                    "locale": "en-US",
                    "description": "Kaizen helps you build habits.",
                    "promotionalText": "Start today.",
                    "keywords": "habit,streak",
                },
            }
        ]
    },
    "/appPriceSchedule": {"data": None},
}


def _set_asc_env(monkeypatch: pytest.MonkeyPatch, asc_key_path: Path) -> None:
    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_KEY_ID", "TEST123")
    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_ISSUER_ID", "issuer-id")
    monkeypatch.setenv("LAUNCHPILOT_APP_STORE_PRIVATE_KEY_PATH", str(asc_key_path))


def _patch_asc_client(
    monkeypatch: pytest.MonkeyPatch, routes: dict[str, Any], *, record: list[Any] | None = None
) -> None:
    import appmates.cli.commands.appstore_connect as module

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "PATCH":
            if record is not None:
                record.append((path, json.loads(request.read())))
            return httpx.Response(200, json={"data": {}})
        for suffix, body in routes.items():
            if path.endswith(suffix):
                return httpx.Response(200, json=body)
        raise AssertionError(f"unrouted request: {request.method} {path}")

    real_client = module.AppStoreConnectClient

    def factory(**kwargs: Any) -> Any:
        kwargs["client"] = httpx.Client(transport=httpx.MockTransport(handler))
        kwargs["min_interval"] = 0.0
        return real_client(**kwargs)

    monkeypatch.setattr(module, "AppStoreConnectClient", factory)


def test_asc_status_without_credentials_exits_two(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)  # avoid picking up a developer's own .env
    assert run("asc", "status").exit_code == int(ExitCode.USAGE)


def test_asc_status_valid_credentials_exits_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    _patch_asc_client(monkeypatch, {"/apps": {"data": []}})

    result = run("asc", "status", "--json")
    assert result.exit_code == int(ExitCode.OK)
    assert payload(result) == {"configured": True, "valid": True, "error": None}


def test_asc_status_rejected_credentials_exits_findings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)

    import appmates.cli.commands.appstore_connect as module

    real_client = module.AppStoreConnectClient

    def factory(**kwargs: Any) -> Any:
        kwargs["client"] = httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"errors": []}))
        )
        kwargs["min_interval"] = 0.0
        return real_client(**kwargs)

    monkeypatch.setattr(module, "AppStoreConnectClient", factory)

    result = run("asc", "status", "--json")
    assert result.exit_code == int(ExitCode.FINDINGS)
    assert payload(result)["valid"] is False


def test_asc_pull_writes_the_same_shape_validate_metadata_reads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    _patch_asc_client(monkeypatch, _ASC_ROUTES)

    out = tmp_path / "pulled.json"
    result = run("asc", "pull", "com.example.app", "--out", str(out))
    assert result.exit_code == int(ExitCode.OK)

    pulled = json.loads(out.read_text(encoding="utf-8"))
    assert pulled["locales"][0]["locale"] == "en-US"
    assert pulled["locales"][0]["title"] == "Kaizen"
    assert "current_prices" in pulled

    # The exact contract: validate-metadata reads what asc pull wrote, unchanged.
    # Apple-only: a listing pulled from App Store Connect has no Google-specific
    # fields (short_description) to begin with, so checking Google here would
    # fail for a reason that has nothing to do with what was pulled.
    assert run("validate-metadata", str(out), "-s", "apple").exit_code == int(ExitCode.OK)


def test_asc_pull_app_not_found_exits_two(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    _patch_asc_client(monkeypatch, {**_ASC_ROUTES, "/apps": {"data": []}})

    result = run("asc", "pull", "com.missing.app")
    assert result.exit_code == int(ExitCode.USAGE)


def test_asc_push_metadata_dry_run_sends_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    sent: list[Any] = []
    _patch_asc_client(monkeypatch, _ASC_ROUTES, record=sent)

    listing_path = _write_listing(
        tmp_path,
        locales=[
            {
                "locale": "en-US",
                "title": "Kaizen: Habits",  # changed from "Kaizen"
                "subtitle": "Build habits",
                "description": "Kaizen helps you build habits.",
                "promotional_text": "Start today.",
                "keywords": "habit,streak",
            }
        ],
    )

    result = run("asc", "push-metadata", "com.example.app", str(listing_path), "--json")
    assert result.exit_code == int(ExitCode.OK)
    data = payload(result)
    assert data["would_push"] is True
    assert data["changes"][0]["field"] == "title"
    assert sent == []  # dry run: nothing was actually sent


def test_asc_push_metadata_blocked_on_error_findings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    sent: list[Any] = []
    _patch_asc_client(monkeypatch, _ASC_ROUTES, record=sent)

    listing_path = _write_listing(
        tmp_path,
        locales=[{"locale": "en-US", "title": "K" * 40}],  # over the 30-char limit
    )

    result = run("asc", "push-metadata", "com.example.app", str(listing_path), "--yes")
    assert result.exit_code == int(ExitCode.FINDINGS)
    assert sent == []  # blocked: nothing was actually sent


def test_asc_push_metadata_yes_sends_the_diff(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    sent: list[Any] = []
    _patch_asc_client(monkeypatch, _ASC_ROUTES, record=sent)

    listing_path = _write_listing(
        tmp_path,
        locales=[
            {
                "locale": "en-US",
                "title": "Kaizen: Habits",
                "subtitle": "Build habits",
                "description": "Kaizen helps you build habits.",
                "promotional_text": "Start today.",
                "keywords": "habit,streak",
            }
        ],
    )

    result = run("asc", "push-metadata", "com.example.app", str(listing_path), "--yes", "--json")
    assert result.exit_code == int(ExitCode.OK)
    assert payload(result) == {"pushed": True, "fields_sent": 1}
    assert len(sent) == 1
    path, body = sent[0]
    assert "appInfoLocalizations" in path
    assert body["data"]["attributes"] == {"name": "Kaizen: Habits"}


def test_asc_push_metadata_nothing_changed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, asc_key_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _set_asc_env(monkeypatch, asc_key_path)
    _patch_asc_client(monkeypatch, _ASC_ROUTES)

    listing_path = _write_listing(
        tmp_path,
        locales=[
            {
                "locale": "en-US",
                "title": "Kaizen",
                "subtitle": "Build habits",
                "description": "Kaizen helps you build habits.",
                "promotional_text": "Start today.",
                "keywords": "habit,streak",
            }
        ],
    )

    result = run("asc", "push-metadata", "com.example.app", str(listing_path), "--yes")
    assert result.exit_code == int(ExitCode.OK)
