"""Google Play closed-testing eligibility.

Personal developer accounts created after 13 November 2023 must run a closed
test with at least 12 testers opted in **continuously** for 14 days before they
can apply for production access. Organisation accounts are exempt.

The subtlety this module exists to capture: the 14 days must be *unbroken*.
A naive ``days_passed >= 14 and testers >= 12`` check reports success for a
timeline where the tester count dipped to 11 on day 9 — and the developer then
discovers on day 14 that Play restarted their clock. The evaluator below tracks
the streak day by day so a dip is reported the moment it happens.

The evaluator is a pure function over a timeline. Where that timeline comes
from — a mock, a JSON export, or the Play Developer API — is the data source's
problem, which keeps the domain rule testable without network access.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from appmates.core.models.testing import (
    REQUIRED_DAYS,
    REQUIRED_TESTERS,
    BlockingReason,
    ClosedTestingStatus,
    DailyTesterCount,
)


def evaluate(
    history: Sequence[DailyTesterCount],
    *,
    required_testers: int = REQUIRED_TESTERS,
    required_days: int = REQUIRED_DAYS,
    release_approved: bool = True,
    today: dt.date | None = None,
) -> ClosedTestingStatus:
    """Assess a closed test against Play's production-access requirements.

    ``history`` is a per-day tester count, in any order; gaps in the dates break
    the streak, because a day with no recorded opt-ins cannot be counted as met.
    """
    today = today or dt.date.today()
    ordered = sorted(history, key=lambda d: d.date)

    current_streak, longest_streak, streak_start, was_reset = _measure_streaks(
        ordered, required_testers
    )
    active = ordered[-1].opted_in if ordered else 0

    if not release_approved:
        # Play does not start counting until the build is live to testers.
        current_streak = 0
        streak_start = None

    eligible = release_approved and active >= required_testers and current_streak >= required_days
    days_remaining = max(0, required_days - current_streak)

    projected: dt.date | None = None
    if not eligible and active >= required_testers and release_approved:
        projected = today + dt.timedelta(days=days_remaining)

    return ClosedTestingStatus(
        eligible=eligible,
        active_testers=active,
        required_testers=required_testers,
        required_days=required_days,
        current_streak_days=current_streak,
        longest_streak_days=longest_streak,
        streak_started_on=streak_start,
        projected_eligible_date=projected,
        streak_was_reset=was_reset,
        release_approved=release_approved,
        blocking_reasons=_blocking_reasons(
            active=active,
            required_testers=required_testers,
            current_streak=current_streak,
            required_days=required_days,
            release_approved=release_approved,
            was_reset=was_reset,
        ),
        evaluated_on=today,
    )


def _measure_streaks(
    ordered: Sequence[DailyTesterCount], threshold: int
) -> tuple[int, int, dt.date | None, bool]:
    """Return (current streak, longest streak, streak start, streak was reset)."""
    current = 0
    longest = 0
    start: dt.date | None = None
    had_streak = False
    was_reset = False
    previous: dt.date | None = None

    for entry in ordered:
        # A missing day is a hole in the evidence, so it breaks the streak.
        contiguous = previous is None or entry.date == previous + dt.timedelta(days=1)

        if entry.opted_in >= threshold and contiguous:
            current += 1
            start = start or entry.date
        elif entry.opted_in >= threshold:
            if had_streak:
                was_reset = True
            current = 1
            start = entry.date
        else:
            if current > 0:
                was_reset = True
            current = 0
            start = None

        had_streak = had_streak or current > 0
        longest = max(longest, current)
        previous = entry.date

    return current, longest, start, was_reset


def _blocking_reasons(
    *,
    active: int,
    required_testers: int,
    current_streak: int,
    required_days: int,
    release_approved: bool,
    was_reset: bool,
) -> list[BlockingReason]:
    reasons: list[BlockingReason] = []

    if not release_approved:
        reasons.append(
            BlockingReason(
                code="RELEASE_NOT_APPROVED",
                message=(
                    "The closed-testing release is not approved yet. The 14-day clock "
                    "does not start until Google approves it."
                ),
            )
        )
    if active < required_testers:
        missing = required_testers - active
        reasons.append(
            BlockingReason(
                code="NOT_ENOUGH_TESTERS",
                message=(
                    f"{active}/{required_testers} testers opted in. Recruit {missing} more. "
                    "A tester only counts once they accept the invite and install the build."
                ),
            )
        )
    if current_streak < required_days:
        reasons.append(
            BlockingReason(
                code="STREAK_TOO_SHORT",
                message=(
                    f"{current_streak}/{required_days} continuous days met. "
                    f"{required_days - current_streak} to go."
                ),
            )
        )
    if was_reset:
        reasons.append(
            BlockingReason(
                code="STREAK_RESET",
                message=(
                    "The tester count dropped below the threshold, which restarted the "
                    "14-day count. Keep every tester opted in until you apply."
                ),
            )
        )
    return reasons


def flat_history(
    days_passed: int,
    active_testers: int,
    *,
    today: dt.date | None = None,
) -> list[DailyTesterCount]:
    """Synthesise a timeline with a constant tester count.

    Backs the convenience ``--days-passed / --active-testers`` flags. It cannot
    detect a dip, since a flat count has none by construction — the CLI says so
    when reporting a result derived this way.
    """
    today = today or dt.date.today()
    if days_passed <= 0:
        return []
    return [
        DailyTesterCount(
            date=today - dt.timedelta(days=days_passed - 1 - i),
            opted_in=active_testers,
        )
        for i in range(days_passed)
    ]


@runtime_checkable
class TesterDataSource(Protocol):
    """Where a tester timeline comes from.

    ``MockPlayDataSource`` implements this today; a ``PlayDeveloperApiSource``
    backed by httpx will implement it next, without the evaluator changing.
    """

    def fetch_history(self, package_name: str) -> list[DailyTesterCount]: ...


class MockPlayDataSource:
    """In-memory data source for development, demos and tests."""

    def __init__(self, histories: dict[str, list[DailyTesterCount]] | None = None) -> None:
        self._histories = histories or {}

    def fetch_history(self, package_name: str) -> list[DailyTesterCount]:
        return list(self._histories.get(package_name, []))

    def set_history(self, package_name: str, history: list[DailyTesterCount]) -> None:
        self._histories[package_name] = list(history)

    @classmethod
    def with_ramp(
        cls,
        package_name: str,
        *,
        days: int = 20,
        peak: int = 14,
        dip_on_day: int | None = None,
        today: dt.date | None = None,
    ) -> MockPlayDataSource:
        """Build a plausible recruitment curve, optionally with a dip.

        ``dip_on_day`` drops the count below the threshold on that day, which is
        how the streak-reset path gets exercised without hand-writing a timeline.
        """
        today = today or dt.date.today()
        history: list[DailyTesterCount] = []
        for i in range(days):
            count = min(peak, i + 2)
            if dip_on_day is not None and i == dip_on_day:
                count = REQUIRED_TESTERS - 1
            history.append(
                DailyTesterCount(date=today - dt.timedelta(days=days - 1 - i), opted_in=count)
            )
        return cls({package_name: history})


class ClosedTestingTracker:
    """Convenience facade binding a data source to the evaluator."""

    def __init__(self, source: TesterDataSource) -> None:
        self.source = source

    def check(
        self,
        package_name: str,
        *,
        release_approved: bool = True,
        today: dt.date | None = None,
    ) -> ClosedTestingStatus:
        return evaluate(
            self.source.fetch_history(package_name),
            release_approved=release_approved,
            today=today,
        )
