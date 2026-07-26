"""Competitor and rank tests.

Offline throughout. The recorded fixture deliberately preserves the mix of apps
whose screenshots the catalogue exposes and withholds — roughly half in
practice — because handling that asymmetry correctly is most of what this
module does.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from launchpilot.core.models.competitors import Device
from launchpilot.core.services.competitor_analyzer import (
    CompetitorAnalyzer,
    RankHistory,
    analyse_competitors,
    build_strategy,
    competitor_from_entry,
    count_by,
    download_screenshots,
    extract_terms,
    find_position,
    median_or_zero,
    parse_screenshot,
)

FIXTURE = Path(__file__).parent / "fixtures" / "itunes_competitors.json"
TODAY = dt.date(2026, 7, 26)
NOW = dt.datetime(2026, 7, 26, 12, 0, tzinfo=dt.UTC)

SHOT = "https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/ab/cd/Screen_1.png/392x696bb.png"


@pytest.fixture
def corpus() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def entry(
    *,
    track_id: int = 1,
    name: str = "An App",
    seller: str = "Acme",
    ratings: int = 100,
    iphone: int = 0,
    ipad: int = 0,
    portrait: bool = True,
) -> dict[str, Any]:
    dims = "392x696bb" if portrait else "696x392bb"
    return {
        "trackId": track_id,
        "trackName": name,
        "sellerName": seller,
        "userRatingCount": ratings,
        "averageUserRating": 4.5,
        "price": 0.0,
        "currentVersionReleaseDate": "2026-07-01T00:00:00Z",
        "screenshotUrls": [f"https://cdn/x/{i}.png/{dims}.png" for i in range(iphone)],
        "ipadScreenshotUrls": [f"https://cdn/p/{i}.png/{dims}.png" for i in range(ipad)],
    }


class FakeSource:
    def __init__(self, entries: list[dict[str, Any]], app: dict[str, Any] | None = None) -> None:
        self.entries = entries
        self.app = app
        self.searches: list[str] = []

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        self.searches.append(term)
        return len(self.entries), self.entries

    def lookup(self, app_id: str, *, country: str) -> dict[str, Any] | None:
        return self.app


# --- screenshot URL parsing ----------------------------------------------


def test_dimensions_come_from_the_url_without_downloading() -> None:
    shot = parse_screenshot(SHOT, Device.IPHONE)
    assert (shot.width, shot.height) == (392, 696)
    assert shot.is_portrait is True


def test_landscape_is_detected() -> None:
    shot = parse_screenshot("https://cdn/a.png/900x600bb.png", Device.IPHONE)
    assert shot.is_portrait is False


def test_an_unparseable_url_yields_unknown_dimensions() -> None:
    shot = parse_screenshot("https://cdn/no-size-here", Device.IPHONE)
    assert shot.width is None
    assert shot.is_portrait is None


def test_a_width_only_thumbnail_uses_the_w_suffix() -> None:
    """Regression: `bb` requires both dimensions and 400s on a zero height.

    Using it for width-only resizes made every download fail silently.
    """
    assert parse_screenshot(SHOT, Device.IPHONE).at_size(180).endswith("/180x0w.png")


def test_a_boxed_thumbnail_uses_the_bb_suffix() -> None:
    assert parse_screenshot(SHOT, Device.IPHONE).at_size(180, 320).endswith("/180x320bb.png")


def test_at_size_on_an_unparseable_url_returns_it_unchanged() -> None:
    shot = parse_screenshot("nosegments", Device.IPHONE)
    assert shot.at_size(100) == "nosegments"


# --- entry conversion ----------------------------------------------------


def test_iphone_and_ipad_counts_are_reported_separately() -> None:
    """A single total reads as "ships ten phone screenshots" when it ships none.

    The catalogue routinely returns one set and not the other.
    """
    app = competitor_from_entry(entry(iphone=0, ipad=10), 1)
    assert app is not None
    assert app.iphone_count == 0
    assert app.ipad_count == 10
    assert app.screenshot_count == 10


def test_withheld_screenshots_are_distinguished_from_none() -> None:
    withheld = competitor_from_entry({"trackId": 1, "trackName": "X"}, 1)
    assert withheld is not None
    assert withheld.screenshots_exposed is False

    exposed = competitor_from_entry(entry(iphone=3), 1)
    assert exposed is not None
    assert exposed.screenshots_exposed is True


def test_position_is_recorded_from_the_result_order() -> None:
    app = competitor_from_entry(entry(), 7)
    assert app is not None and app.position == 7


def test_unusable_entries_are_rejected() -> None:
    assert competitor_from_entry({"trackName": "no id"}, 1) is None
    assert competitor_from_entry({"trackId": 1}, 1) is None


def test_seller_falls_back_to_artist_name() -> None:
    app = competitor_from_entry({"trackId": 1, "trackName": "A", "artistName": "Studio"}, 1)
    assert app is not None and app.seller == "Studio"


def test_days_since_update_is_computed() -> None:
    app = competitor_from_entry(entry(), 1)
    assert app is not None
    assert app.days_since_update(TODAY) == 25


# --- niche strategy ------------------------------------------------------


def test_withheld_apps_do_not_drag_the_median_down() -> None:
    """Counting a withheld gallery as zero would halve every niche median."""
    apps = [
        competitor_from_entry(entry(track_id=1, iphone=7), 1),
        competitor_from_entry(entry(track_id=2, iphone=7), 2),
        competitor_from_entry({"trackId": 3, "trackName": "Withheld"}, 3),
        competitor_from_entry({"trackId": 4, "trackName": "Also withheld"}, 4),
    ]
    strategy = build_strategy([a for a in apps if a])

    assert strategy.median_count == 7
    assert strategy.apps_sampled == 2
    assert strategy.apps_missing == 2
    assert strategy.coverage_percent == 50.0


def test_orientation_is_decided_per_app_by_majority() -> None:
    apps = [
        competitor_from_entry(entry(track_id=1, iphone=5, portrait=True), 1),
        competitor_from_entry(entry(track_id=2, iphone=5, portrait=False), 2),
    ]
    strategy = build_strategy([a for a in apps if a])
    assert strategy.portrait_apps == 1
    assert strategy.landscape_apps == 1


def test_ipad_only_apps_do_not_contribute_an_iphone_count() -> None:
    apps = [competitor_from_entry(entry(iphone=0, ipad=8), 1)]
    strategy = build_strategy([a for a in apps if a])
    assert strategy.counts == []
    assert strategy.ipad_apps == 1
    assert strategy.median_count == 0


def test_apps_using_every_slot_are_counted() -> None:
    apps = [
        competitor_from_entry(entry(track_id=1, iphone=10), 1),
        competitor_from_entry(entry(track_id=2, iphone=4), 2),
    ]
    assert build_strategy([a for a in apps if a]).uses_max_slots == 1


def test_strategy_of_an_empty_field_is_empty() -> None:
    strategy = build_strategy([])
    assert strategy.apps_sampled == 0
    assert strategy.median_count == 0
    assert strategy.coverage_percent == 0


# --- report --------------------------------------------------------------


def test_report_respects_the_requested_size() -> None:
    entries = [entry(track_id=i, iphone=5) for i in range(20)]
    report = analyse_competitors("x", country="us", result_count=20, entries=entries, top_n=6)
    assert len(report.apps) == 6
    assert [a.position for a in report.apps] == [1, 2, 3, 4, 5, 6]


def test_report_notes_how_many_screenshots_were_withheld() -> None:
    entries = [entry(track_id=1, iphone=5), {"trackId": 2, "trackName": "Withheld"}]
    report = analyse_competitors("x", country="us", result_count=2, entries=entries)
    assert any("withheld" in n for n in report.notes)


def test_an_empty_result_set_is_reported_not_crashed() -> None:
    report = analyse_competitors("x", country="us", result_count=0, entries=[])
    assert report.apps == []
    assert report.strategy is None
    assert report.notes


def test_a_recorded_response_parses_and_summarises(corpus: dict[str, Any]) -> None:
    report = analyse_competitors(
        "habit tracker",
        country="us",
        result_count=corpus["resultCount"],
        entries=corpus["results"],
        top_n=12,
    )
    assert len(report.apps) == 12
    assert report.strategy is not None
    # The fixture keeps the real mix; both sides must be non-empty or the
    # asymmetry this module exists to handle is not being exercised.
    assert report.strategy.apps_sampled > 0
    assert report.strategy.apps_missing > 0


# --- position ------------------------------------------------------------


def test_position_is_one_based() -> None:
    entries = [entry(track_id=10), entry(track_id=20), entry(track_id=30)]
    assert find_position(20, entries) == 2
    assert find_position(10, entries) == 1


def test_an_absent_app_has_no_position() -> None:
    assert find_position(999, [entry(track_id=1)]) is None


# --- rank ----------------------------------------------------------------


def test_rank_reports_a_position_per_keyword() -> None:
    entries = [entry(track_id=1), entry(track_id=42), entry(track_id=3)]
    source = FakeSource(entries, app={"trackId": 42, "trackName": "Mine"})
    report = CompetitorAnalyzer(source).rank("42", ["a", "b"], now=NOW)

    assert report.app_name == "Mine"
    assert [p.position for p in report.positions] == [2, 2]
    assert report.ranked_for == 2
    assert report.best_position == 2
    assert source.searches == ["a", "b"]


def test_a_missing_app_reports_the_depth_it_searched() -> None:
    source = FakeSource([entry(track_id=1)], app={"trackId": 99, "trackName": "Mine"})
    report = CompetitorAnalyzer(source).rank("99", ["a"], now=NOW)

    position = report.positions[0]
    assert position.found is False
    assert position.searched_depth == 1
    assert report.best_position is None


def test_an_unknown_app_raises_a_clear_error() -> None:
    source = FakeSource([], app=None)
    with pytest.raises(LookupError, match="No app found"):
        CompetitorAnalyzer(source).rank("nope", ["a"], now=NOW)


# --- history -------------------------------------------------------------


def test_history_round_trips_and_reports_movement(tmp_path: Path) -> None:
    history = RankHistory(tmp_path / "h.jsonl")
    entries = [entry(track_id=1), entry(track_id=2), entry(track_id=42)]
    source = FakeSource(entries, app={"trackId": 42, "trackName": "Mine"})
    analyzer = CompetitorAnalyzer(source)

    first = analyzer.rank("42", ["a"], history=history, now=NOW)
    assert first.positions[0].movement is None
    history.append(first)

    # Same app, now second instead of third.
    source.entries = [entry(track_id=1), entry(track_id=42)]
    later = analyzer.rank("42", ["a"], history=history, now=NOW + dt.timedelta(days=1))
    assert later.positions[0].position == 2
    assert later.positions[0].movement == 1  # gained one place


def test_a_drop_reports_negative_movement(tmp_path: Path) -> None:
    history = RankHistory(tmp_path / "h.jsonl")
    source = FakeSource([entry(track_id=42)], app={"trackId": 42, "trackName": "Mine"})
    analyzer = CompetitorAnalyzer(source)
    history.append(analyzer.rank("42", ["a"], now=NOW))

    source.entries = [entry(track_id=1), entry(track_id=2), entry(track_id=42)]
    later = analyzer.rank("42", ["a"], history=history, now=NOW)
    assert later.positions[0].movement == -2


def test_history_is_append_only(tmp_path: Path) -> None:
    """A crashed run must not be able to truncate a month of records."""
    path = tmp_path / "h.jsonl"
    history = RankHistory(path)
    source = FakeSource([entry(track_id=42)], app={"trackId": 42, "trackName": "Mine"})
    analyzer = CompetitorAnalyzer(source)

    for _ in range(3):
        history.append(analyzer.rank("42", ["a"], now=NOW))
    assert len(path.read_text(encoding="utf-8").strip().splitlines()) == 3


def test_a_malformed_line_does_not_discard_the_rest(tmp_path: Path) -> None:
    path = tmp_path / "h.jsonl"
    path.write_text(
        '{"date":"2026-01-01","track_id":1,"country":"US","keyword":"a","position":5}\n'
        "{ this is not json\n"
        '{"date":"2026-01-02","track_id":1,"country":"US","keyword":"a","position":3}\n',
        encoding="utf-8",
    )
    history = RankHistory(path)
    assert len(history.read()) == 2
    assert history.latest(1, "a", "US")["position"] == 3


def test_history_picks_the_most_recent_matching_record(tmp_path: Path) -> None:
    path = tmp_path / "h.jsonl"
    path.write_text(
        '{"date":"2026-01-01","track_id":1,"country":"US","keyword":"a","position":9}\n'
        '{"date":"2026-03-01","track_id":1,"country":"US","keyword":"a","position":4}\n'
        '{"date":"2026-02-01","track_id":1,"country":"US","keyword":"a","position":6}\n',
        encoding="utf-8",
    )
    assert RankHistory(path).latest(1, "a", "US")["position"] == 4


def test_history_does_not_mix_keywords_or_storefronts(tmp_path: Path) -> None:
    path = tmp_path / "h.jsonl"
    path.write_text(
        '{"date":"2026-01-01","track_id":1,"country":"US","keyword":"a","position":9}\n'
        '{"date":"2026-01-01","track_id":1,"country":"FR","keyword":"a","position":2}\n'
        '{"date":"2026-01-01","track_id":1,"country":"US","keyword":"b","position":3}\n',
        encoding="utf-8",
    )
    history = RankHistory(path)
    assert history.latest(1, "a", "US")["position"] == 9
    assert history.latest(1, "a", "FR")["position"] == 2
    assert history.latest(1, "z", "US") is None


def test_a_missing_history_file_is_empty_not_an_error(tmp_path: Path) -> None:
    assert RankHistory(tmp_path / "never.jsonl").read() == []


# --- downloads -----------------------------------------------------------


def test_downloads_only_iphone_screenshots_and_names_them_by_position(
    tmp_path: Path,
) -> None:
    app = competitor_from_entry(entry(name="My App", iphone=3, ipad=5), 4)
    assert app is not None
    written = download_screenshots(app, tmp_path, fetch=lambda url: b"png-bytes")

    assert len(written) == 3
    assert all(p.name.startswith("04-My-App-") for p in written)
    assert all(p.read_bytes() == b"png-bytes" for p in written)


def test_a_failed_download_is_skipped_not_fatal(tmp_path: Path) -> None:
    app = competitor_from_entry(entry(iphone=3), 1)
    assert app is not None
    calls = {"n": 0}

    def flaky(url: str) -> bytes:
        calls["n"] += 1
        return b"" if calls["n"] == 2 else b"data"

    assert len(download_screenshots(app, tmp_path, fetch=flaky)) == 2


def test_download_respects_the_limit(tmp_path: Path) -> None:
    app = competitor_from_entry(entry(iphone=8), 1)
    assert app is not None
    assert len(download_screenshots(app, tmp_path, fetch=lambda u: b"x", limit=3)) == 3


def test_download_requests_the_asked_for_width(tmp_path: Path) -> None:
    app = competitor_from_entry(entry(iphone=1), 1)
    assert app is not None
    seen: list[str] = []
    download_screenshots(app, tmp_path, fetch=lambda u: (seen.append(u), b"x")[1], width=200)
    assert "200x0w.png" in seen[0]


def test_a_hostile_app_name_cannot_escape_the_directory(tmp_path: Path) -> None:
    app = competitor_from_entry(entry(name="../../etc/passwd", iphone=1), 1)
    assert app is not None
    written = download_screenshots(app, tmp_path, fetch=lambda u: b"x")
    assert written[0].parent == tmp_path
    assert ".." not in written[0].name


# --- helpers -------------------------------------------------------------


def test_count_by_builds_a_sorted_frequency_table() -> None:
    assert count_by([7, 3, 7, 10, 3, 7]) == {3: 2, 7: 3, 10: 1}


def test_median_or_zero_handles_an_empty_sequence() -> None:
    assert median_or_zero([]) == 0.0
    assert median_or_zero([1, 2, 3]) == 2.0


# --- term extraction -----------------------------------------------------


def app_with(name: str, description: str = "", position: int = 1) -> Any:
    return competitor_from_entry(
        {"trackId": position, "trackName": name, "description": description}, position
    )


def test_terms_are_counted_once_per_app_not_per_occurrence() -> None:
    """One verbose description must not outvote the rest of the field."""
    apps = [
        app_with("Alpha", "budget budget budget budget budget", 1),
        app_with("Beta", "savings tool", 2),
    ]
    terms = {t.term: t for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert terms["budget"].apps_in_description == 1


def test_app_name_usage_outweighs_description_usage() -> None:
    """A word inside a 30-character name is a decision; prose may be incidental."""
    named = [app_with(f"Habit {i}", "unrelated copy", i) for i in range(4)]
    described = [app_with(f"App {i}", "habit " * 5, i) for i in range(4)]

    in_names = {t.term: t.score for t in extract_terms([a for a in named if a], min_apps=1)}
    in_prose = {t.term: t.score for t in extract_terms([a for a in described if a], min_apps=1)}
    assert in_names["habit"] > in_prose["habit"]


def test_plural_variants_are_merged_into_one_term() -> None:
    """Otherwise the term everyone agrees on splits and neither half ranks."""
    apps = [
        app_with("Habit Tracker", "", 1),
        app_with("Daily Habits", "", 2),
        app_with("My Habit", "", 3),
    ]
    terms = {t.term for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert "habit" in terms
    assert "habits" not in terms


def test_an_app_using_both_forms_still_counts_once() -> None:
    apps = [app_with("Habit and Habits", "", 1)]
    terms = {t.term: t for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert terms["habit"].apps_in_name == 1


def test_prose_stopwords_are_excluded() -> None:
    apps = [app_with(f"App {i}", "you will want more from this", i) for i in range(5)]
    terms = {t.term for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert not ({"you", "will", "want", "more", "from", "this"} & terms)


def test_urls_and_emails_do_not_become_terms() -> None:
    """Nearly every listing links to support, so these would look like consensus."""
    apps = [
        app_with(f"App {i}", "Great tool. https://example.com/help mail@example.com", i)
        for i in range(6)
    ]
    terms = {t.term for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert not ({"http", "https", "www", "example", "com"} & terms)


def test_a_term_used_by_one_app_is_not_a_convention() -> None:
    apps = [app_with("Solo Snowflake", "", 1), app_with("Other Thing", "", 2)]
    terms = {t.term for t in extract_terms([a for a in apps if a], min_apps=2)}
    assert "snowflake" not in terms


def test_your_own_terms_are_marked() -> None:
    apps = [app_with(f"Habit Tracker {i}", "", i) for i in range(3)]
    terms = {t.term: t for t in extract_terms([a for a in apps if a], your_text="My Habit App")}
    assert terms["habit"].in_your_listing is True
    assert terms["tracker"].in_your_listing is False


def test_your_plural_counts_as_having_the_term() -> None:
    apps = [app_with(f"Habit {i}", "", i) for i in range(3)]
    terms = {t.term: t for t in extract_terms([a for a in apps if a], your_text="Habits Daily")}
    assert terms["habit"].in_your_listing is True


def test_missing_terms_are_the_ones_you_lack() -> None:
    from launchpilot.core.models.competitors import CompetitorReport

    apps = [app_with(f"Habit Tracker {i}", "", i) for i in range(3)]
    report = CompetitorReport(keyword="x", country="US", result_count=3)
    report.terms = extract_terms([a for a in apps if a], your_text="Habit")
    assert [t.term for t in report.missing_terms] == ["tracker"]


def test_short_words_and_bare_numbers_are_dropped() -> None:
    apps = [app_with(f"Go 42 Ab {i}", "", i) for i in range(3)]
    terms = {t.term for t in extract_terms([a for a in apps if a], min_apps=1)}
    assert not ({"go", "42", "ab"} & terms)


def test_extraction_of_an_empty_field_is_empty() -> None:
    assert extract_terms([]) == []


def test_the_result_is_capped() -> None:
    apps = [app_with(f"Alpha Beta Gamma Delta Epsilon Zeta {i}", "", i) for i in range(4)]
    assert len(extract_terms([a for a in apps if a], top_n=3, min_apps=1)) == 3
