"""Access layer for the YAML spec catalogue.

Every rule in LaunchPilot reads its numbers from here. The day these specs come
from a database instead of a bundled YAML file, only this module changes.
"""

from __future__ import annotations

import datetime as dt
import functools
from importlib import resources
from typing import Any

import yaml
from pydantic import BaseModel, Field

from launchpilot.core.models.report import Store


class SizeSpec(BaseModel):
    id: str
    device_class: str
    width: int
    height: int
    status: str = "accepted"
    supersedes: str | None = None
    notes: str | None = None

    @property
    def is_legacy(self) -> bool:
        return self.status == "legacy"

    @property
    def is_deprecated(self) -> bool:
        return self.status == "deprecated"

    @property
    def portrait(self) -> tuple[int, int]:
        return (min(self.width, self.height), max(self.width, self.height))

    def matches(self, width: int, height: int) -> bool:
        """Exact match in either orientation.

        Apple applies zero tolerance here, so this is an equality test by design.
        """
        return self.portrait == (min(width, height), max(width, height))

    @property
    def label(self) -> str:
        return f"{self.device_class} ({self.width}x{self.height})"


class GraphicAssetSpec(BaseModel):
    id: str
    name: str
    width: int
    height: int
    formats: list[str]
    allow_alpha: bool
    max_bytes: int
    filename_patterns: list[str] = Field(default_factory=list)


class StoreRules(BaseModel):
    """Constraint block. Fields absent from a store's YAML stay ``None``."""

    formats: list[str] = Field(default_factory=list)
    allow_alpha: bool = False
    required_color_spaces: list[str] = Field(default_factory=list)
    max_bytes: int | None = None
    min_side: int | None = None
    max_side: int | None = None
    max_side_ratio: float | None = None
    preferred_aspect_ratio: float | None = None
    aspect_ratio_tolerance: float = 0.05
    min_count: int | None = None
    max_count: int | None = None
    min_count_per_class: int | None = None
    max_count_per_class: int | None = None
    recommended_min_width: int | None = None
    recommended_min_height: int | None = None


class StoreSpec(BaseModel):
    store: Store
    source_url: str
    last_verified: dt.date
    rules: StoreRules
    sizes: list[SizeSpec] = Field(default_factory=list)
    graphic_assets: list[GraphicAssetSpec] = Field(default_factory=list)

    def find_exact(self, width: int, height: int) -> SizeSpec | None:
        """Preferring current sizes over legacy ones when both match."""
        matches = [s for s in self.sizes if s.matches(width, height)]
        if not matches:
            return None
        return min(matches, key=lambda s: (s.status in {"legacy", "deprecated"}, s.id))

    def nearest(self, width: int, height: int) -> SizeSpec | None:
        """Closest non-legacy size, used to suggest what the author probably meant."""
        candidates = [s for s in self.sizes if s.status in {"required", "accepted"}]
        if not candidates:
            return None
        pw, ph = min(width, height), max(width, height)
        return min(
            candidates,
            key=lambda s: abs(s.portrait[0] - pw) + abs(s.portrait[1] - ph),
        )

    def get(self, spec_id: str) -> SizeSpec | None:
        return next((s for s in self.sizes if s.id == spec_id), None)


class BandThresholds(BaseModel):
    favourable_at: float
    hostile_at: float


class VerdictThresholds(BaseModel):
    open_at: float
    contested_at: float


class SignalSpec(BaseModel):
    """One scored observation in the niche analysis."""

    code: str
    label: str
    unit: str
    weight: float
    aggregate: str
    """Name of the observation this signal reads; resolved against ``Aggregates``."""

    curve: list[tuple[float, float]]
    """(observation, score) anchors, linearly interpolated and clamped."""

    direction: str = "lower_is_better"
    rationale: dict[str, str] = Field(default_factory=dict)


class MarketSpec(BaseModel):
    version: str
    source: str
    last_verified: dt.date
    bands: BandThresholds
    verdicts: VerdictThresholds
    serious_competitor_ratings: int = 1000
    signals: list[SignalSpec] = Field(default_factory=list)

    def get(self, code: str) -> SignalSpec | None:
        return next((s for s in self.signals if s.code == code), None)

    @property
    def total_weight(self) -> float:
        return sum(s.weight for s in self.signals)


_FILES: dict[Store, str] = {
    Store.APPLE: "apple.yaml",
    Store.GOOGLE: "google_play.yaml",
}


def _load_yaml(filename: str) -> dict[str, Any]:
    source = resources.files("launchpilot.core.specs").joinpath(filename)
    data: dict[str, Any] = yaml.safe_load(source.read_text(encoding="utf-8"))
    return data


@functools.cache
def load_spec(store: Store) -> StoreSpec:
    """Load and cache one store's specification."""
    raw = _load_yaml(_FILES[store])
    return StoreSpec(store=store, **raw)


def all_specs() -> list[StoreSpec]:
    return [load_spec(store) for store in Store]


@functools.cache
def load_market_spec() -> MarketSpec:
    """Load and cache the niche-scoring methodology."""
    return MarketSpec(**_load_yaml("market.yaml"))


class KeywordFieldSpec(BaseModel):
    max_length: int = 100
    separator: str = ","


class AsoSpec(BaseModel):
    """Keyword-field rules and the word lists they check against."""

    source_url: str
    last_verified: dt.date
    field: KeywordFieldSpec = Field(default_factory=KeywordFieldSpec)
    noise_words: set[str] = Field(default_factory=set)
    category_words: set[str] = Field(default_factory=set)
    prose_stopwords: set[str] = Field(default_factory=set)
    trademark_words: set[str] = Field(default_factory=set)
    findings: dict[str, str] = Field(default_factory=dict)


@functools.cache
def load_aso_spec() -> AsoSpec:
    """Load and cache the keyword-field rules."""
    return AsoSpec(**_load_yaml("aso.yaml"))
