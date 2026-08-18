"""Models for Google Play closed-testing eligibility tracking."""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field, computed_field

REQUIRED_TESTERS = 12
"""Reduced from 20 in December 2024. Personal developer accounts only."""

REQUIRED_DAYS = 14
"""Never changed. Must be *continuous*."""


class DailyTesterCount(BaseModel):
    """Opted-in tester count on a given day.

    "Opted in" means the tester accepted the invite *and* installed the build
    under the matching Google account. Invited-but-not-installed does not count.
    """

    date: dt.date
    opted_in: int = Field(ge=0)


class BlockingReason(BaseModel):
    code: str
    message: str


class ClosedTestingStatus(BaseModel):
    eligible: bool
    active_testers: int
    required_testers: int = REQUIRED_TESTERS
    required_days: int = REQUIRED_DAYS
    current_streak_days: int
    """Consecutive days, ending today, at or above the tester threshold."""
    longest_streak_days: int
    streak_started_on: dt.date | None = None
    projected_eligible_date: dt.date | None = None
    streak_was_reset: bool = False
    """True when the count dipped below the threshold after a streak had begun."""
    release_approved: bool = True
    blocking_reasons: list[BlockingReason] = Field(default_factory=list)
    evaluated_on: dt.date

    @computed_field  # type: ignore[prop-decorator]
    @property
    def days_remaining(self) -> int:
        return max(0, self.required_days - self.current_streak_days)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def testers_needed(self) -> int:
        return max(0, self.required_testers - self.active_testers)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def progress_pct(self) -> float:
        return round(min(1.0, self.current_streak_days / self.required_days) * 100, 1)
