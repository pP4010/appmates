"""Market analysis models.

The central design constraint: **every number here must be traceable to
something observed**, and the reasoning must be inspectable.

The App Store ecosystem's dominant "keyword popularity" metric is Apple Search
Ads' 5-100 score, which is a relative index Apple has never documented, does not
publish a changelog for, and degraded sharply in September 2025 — most keywords
previously scoring 20-60 are now pinned at the floor. Tools that surface it as
"search volume" are showing false precision.

AppMates therefore reports what can be counted from public listings and shows
its working. A :class:`Signal` carries the raw observation *and* the score it
produced *and* the band it fell into, so a user can disagree with the weighting
and still trust the underlying facts.
"""

from __future__ import annotations

import datetime as dt
from enum import StrEnum

from pydantic import BaseModel, Field, computed_field


class Verdict(StrEnum):
    """How winnable a keyword looks."""

    OPEN = "open"
    """Weak or stale incumbents; a good app can plausibly rank."""

    CONTESTED = "contested"
    """Winnable, but it will take sustained effort."""

    LOCKED = "locked"
    """Entrenched leaders. Ranking here is a multi-year project."""


class Band(StrEnum):
    """Where a single observation falls, before weighting."""

    FAVOURABLE = "favourable"
    NEUTRAL = "neutral"
    HOSTILE = "hostile"


class AppSnapshot(BaseModel):
    """One competing app, as the public catalogue describes it."""

    track_id: int
    name: str
    seller: str
    rating_count: int = 0
    rating: float | None = None
    price: float = 0.0
    genres: list[str] = Field(default_factory=list)
    released: dt.date | None = None
    updated: dt.date | None = None
    has_keyword_in_name: bool = False

    def days_since_update(self, today: dt.date | None = None) -> int | None:
        if self.updated is None:
            return None
        return ((today or dt.date.today()) - self.updated).days

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_free(self) -> bool:
        return self.price == 0.0


class Signal(BaseModel):
    """One observation, scored.

    ``score`` is normalised 0-100 where **higher always means more winnable**,
    regardless of whether the raw observation is "more" or "less" of something.
    Keeping that direction uniform is what lets signals be averaged at all.
    """

    code: str
    label: str
    observed: float
    unit: str
    score: float
    weight: float
    band: Band
    rationale: str

    @computed_field  # type: ignore[prop-decorator]
    @property
    def contribution(self) -> float:
        """This signal's share of the final score, before normalisation."""
        return round(self.score * self.weight, 2)


class KeywordReport(BaseModel):
    """The verdict for one search term in one storefront."""

    keyword: str
    country: str
    result_count: int
    """Apps the store returned. Caps at 200 — the API's page limit, not the market's size."""

    apps_sampled: int
    signals: list[Signal] = Field(default_factory=list)
    top_apps: list[AppSnapshot] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def winnability(self) -> float:
        """Weighted mean of the signals, 0-100, higher is more winnable."""
        total_weight = sum(s.weight for s in self.signals)
        if not total_weight:
            return 0.0
        return round(sum(s.contribution for s in self.signals) / total_weight, 1)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def verdict(self) -> Verdict:
        score = self.winnability
        if score >= 60:
            return Verdict.OPEN
        if score >= 35:
            return Verdict.CONTESTED
        return Verdict.LOCKED

    @property
    def strongest_objection(self) -> Signal | None:
        """The signal arguing hardest against entering — what to read first."""
        hostile = [s for s in self.signals if s.band is Band.HOSTILE]
        if not hostile:
            return None
        return min(hostile, key=lambda s: s.score)

    @property
    def best_opening(self) -> Signal | None:
        favourable = [s for s in self.signals if s.band is Band.FAVOURABLE]
        if not favourable:
            return None
        return max(favourable, key=lambda s: s.score)


class NicheReport(BaseModel):
    """A run across several keywords."""

    country: str
    generated_at: dt.datetime
    keywords: list[KeywordReport] = Field(default_factory=list)
    methodology_version: str = ""
    source: str = ""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def best_keyword(self) -> str | None:
        if not self.keywords:
            return None
        return max(self.keywords, key=lambda k: k.winnability).keyword

    def sorted_by_opportunity(self) -> list[KeywordReport]:
        return sorted(self.keywords, key=lambda k: k.winnability, reverse=True)
