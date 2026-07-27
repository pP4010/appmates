"""One app's listing, as the public catalogue describes it.

The interesting part of this model is what it refuses to claim.

Screenshot URLs serve a downscaled image that preserves the original aspect
ratio but not its resolution, so device class is *inferred* from the ratio and
the uploaded pixel size is never reported. The catalogue exposes iPhone
screenshots for roughly half of apps, so an empty set means "not exposed", not
"none shipped". Subtitles and the keyword field are not public at all.

Every one of those is a place where a tool could invent a number that looks
authoritative. The fields below are named so that it cannot.
"""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field, computed_field

from launchpilot.core.models.report import Finding, Severity, Status


class AppProfile(BaseModel):
    """Everything the catalogue says about one app."""

    track_id: int
    bundle_id: str | None = None
    name: str
    seller: str
    store_url: str | None = None
    artwork: str | None = None

    version: str | None = None
    release_notes: str | None = None
    description: str = ""

    released: dt.date | None = None
    updated: dt.date | None = None

    rating: float | None = None
    rating_count: int = 0

    price: float = 0.0
    formatted_price: str | None = None
    genres: list[str] = Field(default_factory=list)
    primary_genre: str | None = None
    content_rating: str | None = None
    minimum_os: str | None = None
    file_size_bytes: int = 0
    locales: list[str] = Field(default_factory=list)

    iphone_screenshots: list[str] = Field(default_factory=list)
    ipad_screenshots: list[str] = Field(default_factory=list)
    screenshots_exposed: bool = False
    """Whether the catalogue returned any screenshot URLs at all.

    Distinct from an empty list, which it would be easy to render as "this app
    ships no screenshots" — a claim the data does not support.
    """

    supports_iphone: bool = True
    supports_ipad: bool = False
    """Read from the device list, and load-bearing for the screenshot checks.

    The catalogue frequently returns one screenshot set and not the other. An
    app that supports iPhone but exposed no iPhone screenshots has almost
    certainly shipped them — the API withheld them — so that check is
    unanswerable rather than failed. An iPad-only app genuinely has none, and
    the check does not apply. Without the device list the two are
    indistinguishable, and the first would be reported as a defect.
    """

    inferred_device: str | None = None
    """Device family guessed from the screenshot aspect ratio.

    The served thumbnail preserves the ratio but not the resolution, so this is
    the most that can be said. The exact upload size is not visible.
    """

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_free(self) -> bool:
        return self.price == 0.0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def size_mb(self) -> float:
        return round(self.file_size_bytes / 1_048_576, 1)

    def days_since_update(self, today: dt.date | None = None) -> int | None:
        if self.updated is None:
            return None
        return ((today or dt.date.today()) - self.updated).days

    def age_days(self, today: dt.date | None = None) -> int | None:
        if self.released is None:
            return None
        return ((today or dt.date.today()) - self.released).days


class HealthCheck(BaseModel):
    """One readiness question, and whether the listing answers it."""

    code: str
    label: str
    passed: bool
    detail: str
    severity: Severity = Severity.INFO
    fix_hint: str | None = None
    checkable: bool = True
    """False when the catalogue cannot answer the question at all.

    An unanswerable check is not a failure — reporting it as one would push
    someone to 'fix' something that was never broken — but it must not be
    silently counted as a pass either.
    """


class AppHealthReport(BaseModel):
    """A listing's readiness, with the checks that produced it."""

    profile: AppProfile
    checks: list[HealthCheck] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    evaluated_on: dt.date

    @property
    def answerable(self) -> list[HealthCheck]:
        return [c for c in self.checks if c.checkable]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def score(self) -> float:
        """Share of answerable checks that passed, 0-100.

        Unanswerable checks are excluded rather than counted either way: an app
        whose screenshots the catalogue withheld should not score lower than one
        whose screenshots it happened to return.
        """
        answerable = self.answerable
        if not answerable:
            return 0.0
        return round(100 * sum(1 for c in answerable if c.passed) / len(answerable), 1)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed_count(self) -> int:
        return sum(1 for c in self.answerable if c.passed)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def checked_count(self) -> int:
        return len(self.answerable)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def unknown_count(self) -> int:
        return len(self.checks) - len(self.answerable)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> Status:
        if any(f.severity is Severity.ERROR for f in self.findings):
            return Status.FAIL
        if any(f.severity is Severity.WARNING for f in self.findings):
            return Status.WARN
        return Status.PASS

    @property
    def failing(self) -> list[HealthCheck]:
        """What to fix, worst first."""
        order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
        return sorted(
            (c for c in self.answerable if not c.passed),
            key=lambda c: order[c.severity],
        )
