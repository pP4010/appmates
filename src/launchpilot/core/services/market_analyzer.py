"""Niche winnability analysis.

Answers a question the established ASO tools structurally cannot: *should I build
this app at all?* Rank trackers and keyword optimisers assume a live app — you
cannot track the ranking of something that does not exist. This runs before a
line of code is written.

The scoring is a pure function over :class:`AppSnapshot` lists. Fetching lives in
:mod:`launchpilot.core.clients.itunes`, so every rule here is testable offline
and a bad network day can never change a verdict.
"""

from __future__ import annotations

import datetime as dt
import itertools
import re
import statistics
from collections import Counter
from collections.abc import Sequence
from typing import Any

from launchpilot.core.models.market import (
    AppSnapshot,
    Band,
    KeywordReport,
    NicheReport,
    Signal,
)
from launchpilot.core.specs.registry import MarketSpec, SignalSpec, load_market_spec

# How many top results form the "leaders" sample. Ten matches what a user
# actually sees before deciding whether to scroll, which is the population whose
# strength genuinely matters.
LEADER_SAMPLE = 10

DEFAULT_FETCH_LIMIT = 200


def _parse_date(value: Any) -> dt.date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _normalise(text: str) -> str:
    """Lowercase and strip punctuation, so 'Habit-Tracker!' matches 'habit tracker'."""
    return re.sub(r"[^a-z0-9\s]+", " ", text.lower())


def keyword_in_name(keyword: str, name: str) -> bool:
    """Whether every word of the search term appears in the app name.

    Word-wise rather than substring: "habit tracker" should match
    "Tracker of Habits" but not be defeated by word order, while "hab" must not
    match "habit" — partial words would inflate the targeting signal.
    """
    haystack = set(_normalise(name).split())
    needles = _normalise(keyword).split()
    return bool(needles) and all(word in haystack for word in needles)


def snapshot_from_entry(entry: dict[str, Any], keyword: str) -> AppSnapshot | None:
    """Convert one catalogue entry, or ``None`` if it is unusable."""
    track_id = entry.get("trackId")
    name = entry.get("trackName")
    if not isinstance(track_id, int) or not isinstance(name, str):
        return None

    return AppSnapshot(
        track_id=track_id,
        name=name,
        seller=str(entry.get("sellerName") or entry.get("artistName") or "unknown"),
        rating_count=int(entry.get("userRatingCount") or 0),
        rating=float(entry["averageUserRating"]) if entry.get("averageUserRating") else None,
        price=float(entry.get("price") or 0.0),
        genres=[g for g in entry.get("genres", []) if isinstance(g, str)],
        released=_parse_date(entry.get("releaseDate")),
        updated=_parse_date(entry.get("currentVersionReleaseDate")),
        has_keyword_in_name=keyword_in_name(keyword, name),
    )


def interpolate(curve: Sequence[tuple[float, float]], observed: float) -> float:
    """Piecewise-linear lookup, clamped at both ends.

    A curve rather than thresholds so that one extra competitor never flips a
    verdict on its own — step functions produce cliff effects that make the
    output feel arbitrary.
    """
    if not curve:
        return 0.0
    points = sorted(curve, key=lambda p: p[0])
    if observed <= points[0][0]:
        return float(points[0][1])
    if observed >= points[-1][0]:
        return float(points[-1][1])

    for (x0, y0), (x1, y1) in itertools.pairwise(points):
        if x0 <= observed <= x1:
            if x1 == x0:
                return float(y0)
            ratio = (observed - x0) / (x1 - x0)
            return float(y0 + ratio * (y1 - y0))
    return float(points[-1][1])


class Aggregates:
    """The raw observations every signal reads from."""

    def __init__(
        self,
        leaders: Sequence[AppSnapshot],
        result_count: int,
        today: dt.date,
        *,
        all_apps: Sequence[AppSnapshot] = (),
        serious_threshold: int = 1000,
    ) -> None:
        self.result_count = float(result_count)
        self.serious_competitor_count = float(
            sum(1 for a in all_apps or leaders if a.rating_count > serious_threshold)
        )

        ratings = [a.rating_count for a in leaders]
        self.median_rating_count = float(statistics.median(ratings)) if ratings else 0.0

        ages = [d for a in leaders if (d := a.days_since_update(today)) is not None]
        self.median_days_since_update = float(statistics.median(ages)) if ages else 0.0

        stars = [a.rating for a in leaders if a.rating is not None]
        self.median_rating = float(statistics.median(stars)) if stars else 0.0

        if leaders:
            hits = sum(1 for a in leaders if a.has_keyword_in_name)
            self.keyword_in_name_share = 100.0 * hits / len(leaders)

            sellers = Counter(a.seller for a in leaders)
            repeats = sum(count for count in sellers.values() if count > 1)
            self.repeat_publisher_share = 100.0 * repeats / len(leaders)
        else:
            self.keyword_in_name_share = 0.0
            self.repeat_publisher_share = 0.0

    def get(self, name: str) -> float:
        try:
            value = getattr(self, name)
        except AttributeError as exc:
            raise ValueError(f"market.yaml references unknown aggregate {name!r}") from exc
        return float(value)


def _band_for(score: float, spec: MarketSpec) -> Band:
    if score >= spec.bands.favourable_at:
        return Band.FAVOURABLE
    if score <= spec.bands.hostile_at:
        return Band.HOSTILE
    return Band.NEUTRAL


def _build_signal(signal_spec: SignalSpec, aggregates: Aggregates, spec: MarketSpec) -> Signal:
    observed = aggregates.get(signal_spec.aggregate)
    score = interpolate(signal_spec.curve, observed)
    band = _band_for(score, spec)
    template = signal_spec.rationale.get(band.value, "")

    return Signal(
        code=signal_spec.code,
        label=signal_spec.label,
        observed=round(observed, 2),
        unit=signal_spec.unit,
        score=round(score, 1),
        weight=signal_spec.weight,
        band=band,
        rationale=template.format(observed=observed),
    )


def analyse_keyword(
    keyword: str,
    *,
    country: str,
    result_count: int,
    entries: Sequence[dict[str, Any]],
    spec: MarketSpec | None = None,
    today: dt.date | None = None,
) -> KeywordReport:
    """Score one keyword from already-fetched catalogue entries."""
    spec = spec or load_market_spec()
    today = today or dt.date.today()

    snapshots = [s for e in entries if (s := snapshot_from_entry(e, keyword)) is not None]
    # The store's own ordering is its relevance ranking, which is the thing a
    # searcher actually sees. Do not re-sort by rating count here.
    leaders = snapshots[:LEADER_SAMPLE]

    notes: list[str] = []
    if not snapshots:
        notes.append("No apps returned for this term; the signals below are not meaningful.")
    elif len(leaders) < LEADER_SAMPLE:
        notes.append(
            f"Only {len(leaders)} app(s) available to sample, so the leader signals are noisy."
        )
    if result_count >= DEFAULT_FETCH_LIMIT:
        notes.append(
            f"The catalogue caps results at {DEFAULT_FETCH_LIMIT}; "
            "the result count is a floor, not a market size."
        )

    aggregates = Aggregates(
        leaders,
        result_count,
        today,
        all_apps=snapshots,
        serious_threshold=spec.serious_competitor_ratings,
    )
    signals = [_build_signal(s, aggregates, spec) for s in spec.signals] if snapshots else []

    return KeywordReport(
        keyword=keyword,
        country=country.upper(),
        result_count=result_count,
        apps_sampled=len(leaders),
        signals=signals,
        top_apps=leaders,
        notes=notes,
    )


class NicheAnalyzer:
    """Fetches and scores a set of keywords."""

    def __init__(self, source: Any, spec: MarketSpec | None = None) -> None:
        self.source = source
        self.spec = spec or load_market_spec()

    def analyse(
        self,
        keywords: Sequence[str],
        *,
        country: str = "us",
        limit: int = DEFAULT_FETCH_LIMIT,
        today: dt.date | None = None,
    ) -> NicheReport:
        reports = []
        for keyword in keywords:
            result_count, entries = self.source.search(keyword, country=country, limit=limit)
            reports.append(
                analyse_keyword(
                    keyword,
                    country=country,
                    result_count=result_count,
                    entries=entries,
                    spec=self.spec,
                    today=today,
                )
            )

        return NicheReport(
            country=country.upper(),
            generated_at=dt.datetime.now(dt.UTC),
            keywords=reports,
            methodology_version=self.spec.version,
            source=self.spec.source,
        )
