"""Competitor and ranking models.

Two honesty constraints shape everything here.

**Screenshots are only partially exposed.** Measured across a 55-app sample,
the public catalogue returned iPhone screenshots for 47% of apps and some set
for 55%. An app missing from the gallery has not necessarily skipped
screenshots — the API simply did not return them. :class:`CompetitorApp`
therefore distinguishes "no screenshots" from "not exposed", and the niche-level
statistics report the sample they were computed from rather than implying they
cover the whole field.

**A search position is not an App Store ranking.** The public endpoint returns
results in its own relevance order. That order is a genuine, useful signal and
it is what this tool reports — but the App Store app serves search from a
different path, with personalisation and paid placements. :class:`RankPosition`
is named for what it measures.
"""

from __future__ import annotations

import datetime as dt
import statistics
from enum import StrEnum

from pydantic import BaseModel, Field, computed_field


class Device(StrEnum):
    IPHONE = "iphone"
    IPAD = "ipad"


class Screenshot(BaseModel):
    """One competitor screenshot, described without downloading it.

    The catalogue's URLs carry a resize directive as their last path segment
    (``.../Screen_1.png/392x696bb.png``), so dimensions and orientation come
    from the string itself.
    """

    url: str
    device: Device = Device.IPHONE
    width: int | None = None
    height: int | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_portrait(self) -> bool | None:
        if not self.width or not self.height:
            return None
        return self.height >= self.width

    def at_size(self, width: int, height: int = 0) -> str:
        """The same image at a different size.

        The CDN's two resize suffixes are not interchangeable: ``bb`` fits
        inside a box and requires both dimensions, so ``300x0bb.png`` is
        answered with a 400. ``w`` constrains width only and accepts a zero
        height. Getting this wrong produces a silent stream of failed
        downloads, so the suffix is chosen from whether a height was given.
        """
        base, _, _ = self.url.rpartition("/")
        if not base:
            return self.url
        return f"{base}/{width}x{height}bb.png" if height else f"{base}/{width}x0w.png"


class CompetitorApp(BaseModel):
    """One app in a keyword's results, in the order the store returned it."""

    position: int
    track_id: int
    name: str
    seller: str
    rating_count: int = 0
    rating: float | None = None
    price: float = 0.0
    updated: dt.date | None = None
    genres: list[str] = Field(default_factory=list)
    screenshots: list[Screenshot] = Field(default_factory=list)
    screenshots_exposed: bool = False
    """Whether the catalogue returned any screenshot URLs at all.

    Distinct from an empty list: absence here means the API withheld them, not
    that the developer shipped none.
    """

    @computed_field  # type: ignore[prop-decorator]
    @property
    def screenshot_count(self) -> int:
        return len(self.screenshots)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def iphone_count(self) -> int:
        """Reported separately from iPad on purpose.

        The catalogue routinely returns one set and not the other — an app can
        show ten iPad screenshots and no iPhone ones — so a single total reads
        as "this competitor ships ten phone screenshots" when it ships none.
        """
        return sum(1 for s in self.screenshots if s.device is Device.IPHONE)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def ipad_count(self) -> int:
        return sum(1 for s in self.screenshots if s.device is Device.IPAD)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_free(self) -> bool:
        return self.price == 0.0

    def days_since_update(self, today: dt.date | None = None) -> int | None:
        if self.updated is None:
            return None
        return ((today or dt.date.today()) - self.updated).days


class ScreenshotStrategy(BaseModel):
    """What the leaders in a niche actually do with their screenshots.

    Useful as a norm to design against: knowing the field ships a median of
    seven portrait screenshots tells you more than any single competitor does.
    """

    apps_sampled: int
    """Apps whose screenshots the catalogue exposed. Everything below is
    computed from these only."""

    apps_missing: int
    """Apps whose screenshots the catalogue withheld."""

    counts: list[int] = Field(default_factory=list)
    portrait_apps: int = 0
    landscape_apps: int = 0
    ipad_apps: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def median_count(self) -> float:
        return round(statistics.median(self.counts), 1) if self.counts else 0.0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def coverage_percent(self) -> float:
        total = self.apps_sampled + self.apps_missing
        return round(100 * self.apps_sampled / total, 1) if total else 0.0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def uses_max_slots(self) -> int:
        """Apps using all ten slots Apple allows."""
        return sum(1 for c in self.counts if c >= 10)


class CompetitorReport(BaseModel):
    keyword: str
    country: str
    result_count: int
    apps: list[CompetitorApp] = Field(default_factory=list)
    strategy: ScreenshotStrategy | None = None
    notes: list[str] = Field(default_factory=list)


class RankPosition(BaseModel):
    """Where an app sits in the public catalogue's results for one term."""

    keyword: str
    position: int | None = None
    """1-based. ``None`` means the app did not appear in the fetched window."""

    searched_depth: int = 0
    """How far down the results were examined; a miss only rules out this depth."""

    result_count: int = 0
    previous_position: int | None = None
    previous_date: dt.date | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def found(self) -> bool:
        return self.position is not None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def movement(self) -> int | None:
        """Places gained since the previous snapshot. Positive is upward."""
        if self.position is None or self.previous_position is None:
            return None
        return self.previous_position - self.position


class RankReport(BaseModel):
    app_name: str
    track_id: int
    country: str
    checked_at: dt.datetime
    positions: list[RankPosition] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def ranked_for(self) -> int:
        return sum(1 for p in self.positions if p.found)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def best_position(self) -> int | None:
        found = [p.position for p in self.positions if p.position is not None]
        return min(found) if found else None
