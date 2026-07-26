"""Niche analysis tests.

Everything here runs offline. The scoring path takes snapshots, never a URL, so
a bad network day can never change a verdict — and the recorded fixture keeps one
real catalogue response in the suite to catch parsing regressions.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest

from launchpilot.core.models.market import Band, Verdict
from launchpilot.core.services.market_analyzer import (
    LEADER_SAMPLE,
    Aggregates,
    NicheAnalyzer,
    analyse_keyword,
    interpolate,
    keyword_in_name,
    snapshot_from_entry,
)
from launchpilot.core.specs.registry import load_market_spec

FIXTURE = Path(__file__).parent / "fixtures" / "itunes_habit_tracker.json"
TODAY = dt.date(2026, 7, 26)


def entry(
    *,
    track_id: int = 1,
    name: str = "Some App",
    seller: str = "Acme",
    ratings: int = 100,
    stars: float = 4.5,
    updated: str = "2026-07-01T00:00:00Z",
    price: float = 0.0,
) -> dict[str, Any]:
    return {
        "trackId": track_id,
        "trackName": name,
        "sellerName": seller,
        "userRatingCount": ratings,
        "averageUserRating": stars,
        "price": price,
        "genres": ["Productivity"],
        "releaseDate": "2020-01-01T00:00:00Z",
        "currentVersionReleaseDate": updated,
    }


def entries(count: int, **kwargs: Any) -> list[dict[str, Any]]:
    return [entry(track_id=i, name=f"App {i}", seller=f"Dev {i}", **kwargs) for i in range(count)]


def entrenched(keyword: str, count: int, **kwargs: Any) -> list[dict[str, Any]]:
    """A genuinely hostile field: every signal pointing the same way.

    Naming matters here. Apps called "App 0" contain none of the search term, so
    KEYWORD_TARGETING reads 0% — a real opening — and a market that is hostile on
    every other axis correctly comes out CONTESTED rather than LOCKED. To test
    the locked case, the leaders have to actually be targeting the term and
    concentrated in a few publishers, as they are in a genuinely locked market.
    """
    kwargs.setdefault("ratings", 250_000)
    kwargs.setdefault("stars", 4.8)
    kwargs.setdefault("updated", "2026-07-24T00:00:00Z")
    return [
        entry(
            track_id=i,
            name=f"{keyword.title()} {i}",
            seller=f"Studio {i % 3}",
            **kwargs,
        )
        for i in range(count)
    ]


class FakeSource:
    def __init__(self, payload: tuple[int, list[dict[str, Any]]]) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str, int]] = []

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        self.calls.append((term, country, limit))
        return self.payload


# --- interpolation -------------------------------------------------------


def test_interpolate_hits_anchor_points_exactly() -> None:
    curve = [(0.0, 100.0), (10.0, 50.0), (20.0, 0.0)]
    assert interpolate(curve, 0) == 100
    assert interpolate(curve, 10) == 50
    assert interpolate(curve, 20) == 0


def test_interpolate_is_linear_between_anchors() -> None:
    assert interpolate([(0.0, 0.0), (10.0, 100.0)], 2.5) == 25


def test_interpolate_clamps_outside_the_curve() -> None:
    curve = [(10.0, 80.0), (20.0, 20.0)]
    assert interpolate(curve, 0) == 80
    assert interpolate(curve, 1_000) == 20


def test_interpolate_handles_degenerate_curves() -> None:
    assert interpolate([], 5) == 0.0
    assert interpolate([(5.0, 42.0)], 999) == 42.0


def test_interpolate_accepts_unsorted_anchors() -> None:
    assert interpolate([(20.0, 0.0), (0.0, 100.0)], 10) == 50


# --- keyword matching ----------------------------------------------------


@pytest.mark.parametrize(
    ("keyword", "name", "expected"),
    [
        ("habit tracker", "Habit Tracker", True),
        ("habit tracker", "Tracker of Habit", True),  # order independent
        ("habit tracker", "Habit-Tracker!", True),  # punctuation stripped
        ("habit tracker", "HABIT TRACKER PRO", True),
        ("habit tracker", "Habits Daily", False),  # 'tracker' missing
        ("hab", "Habit Tracker", False),  # no partial-word credit
        ("budget", "Budgeting Made Easy", False),  # stem is not a match
        ("", "Anything", False),
    ],
)
def test_keyword_in_name(keyword: str, name: str, expected: bool) -> None:
    assert keyword_in_name(keyword, name) is expected


# --- snapshot parsing ----------------------------------------------------


def test_snapshot_reads_the_fields_that_matter() -> None:
    snap = snapshot_from_entry(entry(ratings=500, stars=4.2, updated="2026-06-26T00:00:00Z"), "x")
    assert snap is not None
    assert snap.rating_count == 500
    assert snap.rating == 4.2
    assert snap.updated == dt.date(2026, 6, 26)
    assert snap.days_since_update(TODAY) == 30
    assert snap.is_free is True


def test_snapshot_rejects_entries_without_an_id_or_name() -> None:
    assert snapshot_from_entry({"trackName": "No id"}, "x") is None
    assert snapshot_from_entry({"trackId": 1}, "x") is None


def test_snapshot_tolerates_missing_optional_fields() -> None:
    snap = snapshot_from_entry({"trackId": 1, "trackName": "Bare"}, "bare")
    assert snap is not None
    assert snap.rating_count == 0
    assert snap.rating is None
    assert snap.updated is None
    assert snap.days_since_update(TODAY) is None
    assert snap.seller == "unknown"


def test_snapshot_falls_back_to_artist_name() -> None:
    snap = snapshot_from_entry({"trackId": 1, "trackName": "A", "artistName": "Studio"}, "a")
    assert snap is not None
    assert snap.seller == "Studio"


def test_snapshot_survives_an_unparseable_date() -> None:
    snap = snapshot_from_entry({**entry(), "currentVersionReleaseDate": "not a date"}, "x")
    assert snap is not None
    assert snap.updated is None


# --- aggregates ----------------------------------------------------------


def test_aggregates_compute_medians_over_the_leaders() -> None:
    apps = [snapshot_from_entry(e, "x") for e in entries(3, ratings=100)]
    leaders = [a for a in apps if a]
    agg = Aggregates(leaders, 50, TODAY)
    assert agg.median_rating_count == 100
    assert agg.result_count == 50


def test_aggregates_count_only_credible_competitors() -> None:
    apps = [
        snapshot_from_entry(entry(track_id=1, ratings=50_000), "x"),
        snapshot_from_entry(entry(track_id=2, ratings=2_000), "x"),
        snapshot_from_entry(entry(track_id=3, ratings=10), "x"),
    ]
    all_apps = [a for a in apps if a]
    agg = Aggregates(all_apps, 3, TODAY, all_apps=all_apps, serious_threshold=1000)
    assert agg.serious_competitor_count == 2


def test_aggregates_measure_repeat_publisher_share() -> None:
    raw = [
        entry(track_id=1, seller="Big Studio"),
        entry(track_id=2, seller="Big Studio"),
        entry(track_id=3, seller="Someone Else"),
        entry(track_id=4, seller="Another"),
    ]
    leaders = [s for e in raw if (s := snapshot_from_entry(e, "x"))]
    assert Aggregates(leaders, 4, TODAY).repeat_publisher_share == 50.0


def test_aggregates_measure_keyword_targeting_share() -> None:
    raw = [
        entry(track_id=1, name="Habit Tracker"),
        entry(track_id=2, name="Habit Tracker Pro"),
        entry(track_id=3, name="Unrelated"),
        entry(track_id=4, name="Also Unrelated"),
    ]
    leaders = [s for e in raw if (s := snapshot_from_entry(e, "habit tracker"))]
    assert Aggregates(leaders, 4, TODAY).keyword_in_name_share == 50.0


def test_aggregates_are_zero_without_leaders() -> None:
    agg = Aggregates([], 0, TODAY)
    assert agg.median_rating_count == 0
    assert agg.keyword_in_name_share == 0
    assert agg.repeat_publisher_share == 0


def test_aggregates_reject_an_unknown_name() -> None:
    with pytest.raises(ValueError, match="unknown aggregate"):
        Aggregates([], 0, TODAY).get("no_such_signal")


# --- scoring -------------------------------------------------------------


def test_an_empty_niche_scores_as_open() -> None:
    report = analyse_keyword(
        "sourdough starter log",
        country="us",
        result_count=12,
        entries=entries(4, ratings=5, stars=4.0, updated="2024-01-01T00:00:00Z"),
        today=TODAY,
    )
    assert report.verdict is Verdict.OPEN
    assert report.winnability > 60


def test_an_entrenched_niche_scores_as_locked() -> None:
    report = analyse_keyword(
        "photo editor",
        country="us",
        result_count=200,
        entries=entrenched("photo editor", 60),
        today=TODAY,
    )
    assert report.verdict is Verdict.LOCKED
    assert report.winnability < 35


def test_untargeted_leaders_soften_an_otherwise_hostile_market() -> None:
    """Leaders that rank without targeting the term are a genuine opening.

    Same install base, same ratings, same release cadence — the only difference
    is whether the incumbents chose this keyword. That alone should move the
    verdict, because taking a term nobody optimised for is tractable.
    """
    targeted_entries = entrenched("photo editor", 60)
    incidental_entries = [
        {**e, "trackName": f"Unrelated {i}"} for i, e in enumerate(targeted_entries)
    ]

    def score(raw: list[dict[str, Any]]) -> float:
        return analyse_keyword(
            "photo editor", country="us", result_count=200, entries=raw, today=TODAY
        ).winnability

    assert score(incidental_entries) > score(targeted_entries)


def test_scoring_separates_an_open_niche_from_a_locked_one() -> None:
    """The calibration failure this guards against.

    An earlier revision scored saturation from the raw result count, which the
    catalogue pads to ~190 for every term. Three unrelated markets came out at
    45, 46 and 47 — an instrument that cannot tell them apart is not measuring.
    """
    open_niche = analyse_keyword(
        "ham radio logbook",
        country="us",
        result_count=190,
        entries=entries(6, ratings=20, stars=4.5, updated="2025-01-01T00:00:00Z"),
        today=TODAY,
    )
    locked_niche = analyse_keyword(
        "photo editor",
        country="us",
        result_count=190,
        entries=entries(80, ratings=200_000, stars=4.8, updated="2026-07-20T00:00:00Z"),
        today=TODAY,
    )
    # Same result_count on both: the separation must come from real signals.
    assert open_niche.winnability - locked_niche.winnability > 30


def test_every_signal_in_the_spec_is_produced() -> None:
    spec = load_market_spec()
    report = analyse_keyword("x", country="us", result_count=10, entries=entries(3), today=TODAY)
    assert {s.code for s in report.signals} == {s.code for s in spec.signals}


def test_signal_scores_stay_within_bounds() -> None:
    report = analyse_keyword("x", country="us", result_count=10, entries=entries(5), today=TODAY)
    for signal in report.signals:
        assert 0 <= signal.score <= 100
        assert signal.rationale


def test_no_results_produces_no_signals_and_says_so() -> None:
    report = analyse_keyword("nonsense", country="us", result_count=0, entries=[], today=TODAY)
    assert report.signals == []
    assert report.winnability == 0.0
    assert any("not meaningful" in n for n in report.notes)


def test_a_thin_sample_is_flagged_as_noisy() -> None:
    report = analyse_keyword("x", country="us", result_count=3, entries=entries(3), today=TODAY)
    assert any("noisy" in n for n in report.notes)


def test_a_capped_result_count_is_flagged_as_a_floor() -> None:
    report = analyse_keyword("x", country="us", result_count=200, entries=entries(12), today=TODAY)
    assert any("floor" in n for n in report.notes)


def test_leaders_are_the_store_ordering_not_a_re_sort() -> None:
    """The store's order is its relevance ranking, which is what a searcher sees."""
    raw = [entry(track_id=1, name="First", ratings=5), entry(track_id=2, name="Second", ratings=99)]
    report = analyse_keyword("x", country="us", result_count=2, entries=raw, today=TODAY)
    assert [a.name for a in report.top_apps] == ["First", "Second"]


def test_leader_sample_is_capped() -> None:
    report = analyse_keyword("x", country="us", result_count=50, entries=entries(40), today=TODAY)
    assert report.apps_sampled == LEADER_SAMPLE
    assert len(report.top_apps) == LEADER_SAMPLE


def test_unusable_entries_are_skipped_not_fatal() -> None:
    raw = [entry(track_id=1), {"garbage": True}, entry(track_id=2)]
    report = analyse_keyword("x", country="us", result_count=3, entries=raw, today=TODAY)
    assert report.apps_sampled == 2


# --- report helpers ------------------------------------------------------


def test_report_surfaces_the_strongest_objection_and_best_opening() -> None:
    report = analyse_keyword(
        "photo editor",
        country="us",
        result_count=200,
        entries=entries(60, ratings=250_000, stars=4.9, updated="2026-07-25T00:00:00Z"),
        today=TODAY,
    )
    objection = report.strongest_objection
    assert objection is not None and objection.band is Band.HOSTILE
    assert objection.score == min(s.score for s in report.signals if s.band is Band.HOSTILE)


def test_best_opening_is_none_when_nothing_is_favourable() -> None:
    report = analyse_keyword(
        "photo editor",
        country="us",
        result_count=200,
        entries=entrenched(
            "photo editor", 80, ratings=500_000, stars=4.9, updated="2026-07-26T00:00:00Z"
        ),
        today=TODAY,
    )
    assert report.best_opening is None


def test_winnability_is_the_weighted_mean_of_its_signals() -> None:
    report = analyse_keyword("x", country="us", result_count=20, entries=entries(5), today=TODAY)
    total_weight = sum(s.weight for s in report.signals)
    expected = sum(s.score * s.weight for s in report.signals) / total_weight
    assert report.winnability == pytest.approx(expected, abs=0.1)


# --- analyzer ------------------------------------------------------------


def test_analyzer_queries_every_keyword_and_sorts_by_opportunity() -> None:
    source = FakeSource((20, entries(5, ratings=10)))
    report = NicheAnalyzer(source).analyse(["one", "two"], country="fr", today=TODAY)

    assert [c[0] for c in source.calls] == ["one", "two"]
    assert all(c[1] == "fr" for c in source.calls)
    assert report.country == "FR"
    assert len(report.keywords) == 2
    ordered = report.sorted_by_opportunity()
    assert ordered[0].winnability >= ordered[-1].winnability
    assert report.best_keyword is not None


def test_report_records_the_methodology_it_used() -> None:
    report = NicheAnalyzer(FakeSource((5, entries(2)))).analyse(["x"], today=TODAY)
    assert report.methodology_version == load_market_spec().version
    assert report.source


def test_best_keyword_is_none_for_an_empty_run() -> None:
    report = NicheAnalyzer(FakeSource((0, []))).analyse([], today=TODAY)
    assert report.best_keyword is None


# --- recorded real response ----------------------------------------------


def test_a_real_catalogue_response_parses_and_scores() -> None:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    report = analyse_keyword(
        "habit tracker",
        country="us",
        result_count=payload["resultCount"],
        entries=payload["results"],
        today=TODAY,
    )
    assert report.apps_sampled == LEADER_SAMPLE
    assert all(a.rating_count > 0 for a in report.top_apps)
    assert all(a.updated is not None for a in report.top_apps)
    # A mature, heavily-contested term should not read as an open field.
    assert report.verdict is not Verdict.OPEN
