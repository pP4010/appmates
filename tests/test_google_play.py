"""Tests for the closed-testing evaluator.

The rule under test is "12 testers opted in *continuously* for 14 days". Most
of these cases exist to pin down the word "continuously", which is where a
naive implementation silently reports success.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

import pytest

from launchpilot.core.models.testing import (
    REQUIRED_DAYS,
    REQUIRED_TESTERS,
    DailyTesterCount,
)
from launchpilot.core.services.google_play import (
    ClosedTestingTracker,
    MockPlayDataSource,
    evaluate,
    flat_history,
)

# Aliased on import: pytest tries to collect any module-level name starting
# with "Test", and `TesterDataSource` trips that heuristic.
from launchpilot.core.services.google_play import (  # isort: skip
    TesterDataSource as DataSourceProtocol,
)

HistoryFactory = Callable[..., list[DailyTesterCount]]


def reasons(status: object) -> set[str]:
    return {r.code for r in status.blocking_reasons}  # type: ignore[attr-defined]


# --- the happy path ------------------------------------------------------


def test_fourteen_full_days_is_eligible(history_factory: HistoryFactory, today: dt.date) -> None:
    status = evaluate(history_factory([12] * 14), today=today)

    assert status.eligible is True
    assert status.current_streak_days == 14
    assert status.days_remaining == 0
    assert status.blocking_reasons == []
    assert status.progress_pct == 100.0


def test_more_than_enough_testers_is_fine(history_factory: HistoryFactory, today: dt.date) -> None:
    status = evaluate(history_factory([30] * 20), today=today)
    assert status.eligible is True


# --- not there yet -------------------------------------------------------


def test_partial_streak_projects_a_date(history_factory: HistoryFactory, today: dt.date) -> None:
    status = evaluate(history_factory([12] * 9), today=today)

    assert status.eligible is False
    assert status.current_streak_days == 9
    assert status.days_remaining == 5
    assert status.projected_eligible_date == today + dt.timedelta(days=5)
    assert reasons(status) == {"STREAK_TOO_SHORT"}


def test_too_few_testers_blocks_and_gives_no_projection(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    status = evaluate(history_factory([8] * 20), today=today)

    assert status.eligible is False
    assert status.testers_needed == 4
    assert status.current_streak_days == 0
    # No projection is possible while recruitment is still short.
    assert status.projected_eligible_date is None
    assert "NOT_ENOUGH_TESTERS" in reasons(status)


def test_empty_history_is_not_eligible(today: dt.date) -> None:
    status = evaluate([], today=today)
    assert status.eligible is False
    assert status.active_testers == 0
    assert status.current_streak_days == 0


# --- continuity: the part that catches people out ------------------------


def test_dip_below_threshold_resets_the_streak(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    """20 days of testing, but one bad day on day 11 restarts the clock."""
    counts = [12] * 10 + [11] + [12] * 9
    status = evaluate(history_factory(counts), today=today)

    assert status.eligible is False
    assert status.current_streak_days == 9  # only the days after the dip
    assert status.longest_streak_days == 10
    assert status.streak_was_reset is True
    assert "STREAK_RESET" in reasons(status)


def test_naive_check_would_have_passed_the_dipped_timeline(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    """Guards the core value of this module against a regression to `>=`."""
    counts = [12] * 10 + [11] + [12] * 9
    history = history_factory(counts)

    naive_pass = len(history) >= REQUIRED_DAYS and history[-1].opted_in >= REQUIRED_TESTERS
    assert naive_pass is True
    assert evaluate(history, today=today).eligible is False


def test_gap_in_dates_breaks_the_streak(today: dt.date) -> None:
    """A day with no recorded count is missing evidence, not a passing day."""
    history = [
        DailyTesterCount(date=today - dt.timedelta(days=20 - i), opted_in=12)
        for i in range(20)
        if i != 10  # day 10 absent entirely
    ]
    status = evaluate(history, today=today)
    assert status.current_streak_days < REQUIRED_DAYS


def test_streak_recovers_to_eligible_after_a_reset(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    counts = [12] * 3 + [5] + [12] * 14
    status = evaluate(history_factory(counts), today=today)

    assert status.current_streak_days == 14
    assert status.eligible is True
    # Still surfaced, so the developer understands why it took so long.
    assert status.streak_was_reset is True


def test_unordered_history_is_sorted_before_evaluation(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    history = history_factory([12] * 14)
    shuffled = [history[i] for i in (5, 0, 13, 2, 7, 1, 9, 3, 11, 4, 12, 6, 10, 8)]
    assert evaluate(shuffled, today=today).eligible is True


# --- release approval gate ----------------------------------------------


def test_pending_release_blocks_even_with_a_full_streak(
    history_factory: HistoryFactory, today: dt.date
) -> None:
    """Google's clock does not start until the build is approved."""
    status = evaluate(history_factory([12] * 20), release_approved=False, today=today)

    assert status.eligible is False
    assert status.current_streak_days == 0
    assert status.projected_eligible_date is None
    assert "RELEASE_NOT_APPROVED" in reasons(status)


# --- thresholds are configurable ----------------------------------------


def test_custom_thresholds_are_honoured(history_factory: HistoryFactory, today: dt.date) -> None:
    status = evaluate(history_factory([20] * 7), required_testers=20, required_days=7, today=today)
    assert status.eligible is True
    assert status.required_testers == 20


# --- flat_history helper -------------------------------------------------


def test_flat_history_length_and_endpoint(today: dt.date) -> None:
    history = flat_history(14, 12, today=today)
    assert len(history) == 14
    assert history[-1].date == today
    assert history[0].date == today - dt.timedelta(days=13)


def test_flat_history_of_zero_days_is_empty(today: dt.date) -> None:
    assert flat_history(0, 12, today=today) == []


def test_flat_history_cannot_express_a_dip(today: dt.date) -> None:
    """Documents the known limitation the CLI warns about."""
    status = evaluate(flat_history(20, 12, today=today), today=today)
    assert status.streak_was_reset is False


# --- data source + tracker ----------------------------------------------


def test_mock_source_satisfies_the_protocol() -> None:
    assert isinstance(MockPlayDataSource(), DataSourceProtocol)


def test_tracker_reads_from_its_source(today: dt.date) -> None:
    source = MockPlayDataSource()
    source.set_history("com.example.app", flat_history(14, 12, today=today))

    status = ClosedTestingTracker(source).check("com.example.app", today=today)
    assert status.eligible is True


def test_tracker_on_unknown_package_returns_empty(today: dt.date) -> None:
    status = ClosedTestingTracker(MockPlayDataSource()).check("nope", today=today)
    assert status.active_testers == 0


def test_with_ramp_builds_a_recruitment_curve(today: dt.date) -> None:
    # The ramp adds one tester per day from 2, so it only crosses 12 on day 10.
    # 25 days therefore leaves a 15-day qualifying streak.
    source = MockPlayDataSource.with_ramp("com.example.app", days=25, peak=14, today=today)
    status = ClosedTestingTracker(source).check("com.example.app", today=today)

    assert status.active_testers == 14
    assert status.current_streak_days == 15
    assert status.eligible is True


def test_with_ramp_is_not_yet_eligible_while_still_recruiting(today: dt.date) -> None:
    source = MockPlayDataSource.with_ramp("com.example.app", days=20, peak=14, today=today)
    status = ClosedTestingTracker(source).check("com.example.app", today=today)

    assert status.active_testers == 14
    assert status.current_streak_days == 10
    assert status.eligible is False


def test_with_ramp_can_inject_a_dip(today: dt.date) -> None:
    source = MockPlayDataSource.with_ramp(
        "com.example.app", days=20, peak=14, dip_on_day=15, today=today
    )
    status = ClosedTestingTracker(source).check("com.example.app", today=today)

    assert status.streak_was_reset is True
    assert status.eligible is False


@pytest.mark.parametrize("days", [0, 1, 13, 14, 15])
def test_days_remaining_never_negative(days: int, today: dt.date) -> None:
    status = evaluate(flat_history(days, 12, today=today), today=today)
    assert status.days_remaining >= 0
    assert 0 <= status.progress_pct <= 100
