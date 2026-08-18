"""Google Play closed-testing status command."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Annotated

import typer
from pydantic import ValidationError

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.models.testing import (
    REQUIRED_DAYS,
    REQUIRED_TESTERS,
    DailyTesterCount,
)
from appmates.core.services.google_play import evaluate, flat_history
from appmates.core.services.reporting import render_testing_status


def _load_history(path: Path) -> list[DailyTesterCount]:
    """Read a day-by-day timeline.

    Accepts ``[{"date": "2026-07-01", "opted_in": 12}, ...]`` or the same list
    under a ``"history"`` key, which is what the Play console export looks like.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise fail(f"Could not read {path}: {exc}") from exc

    if isinstance(data, dict):
        data = data.get("history", [])
    if not isinstance(data, list):
        raise fail(f"{path} must contain a list of {{date, opted_in}} entries.")

    try:
        return [DailyTesterCount.model_validate(item) for item in data]
    except ValidationError as exc:
        raise fail(f"Invalid history in {path}: {exc}") from exc


def check_testers(
    days_passed: Annotated[
        int,
        typer.Option("--days-passed", "-d", min=0, help="Days the test has been running."),
    ] = 0,
    active_testers: Annotated[
        int,
        typer.Option("--active-testers", "-t", min=0, help="Testers currently opted in."),
    ] = 0,
    from_file: Annotated[
        Path | None,
        typer.Option(
            "--from-file",
            "-f",
            exists=True,
            dir_okay=False,
            help="JSON timeline of daily tester counts. Detects mid-test dips.",
        ),
    ] = None,
    release_approved: Annotated[
        bool,
        typer.Option(
            "--release-approved/--release-pending",
            help="Whether Google has approved the closed-testing release.",
        ),
    ] = True,
    required_testers: Annotated[
        int, typer.Option("--required-testers", min=1, help="Override the tester threshold.")
    ] = REQUIRED_TESTERS,
    required_days: Annotated[
        int, typer.Option("--required-days", min=1, help="Override the day threshold.")
    ] = REQUIRED_DAYS,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Check progress toward Google Play production access (12 testers / 14 days).

    Exits 1 while the requirement is unmet, so it can gate a release job.
    """
    synthetic = from_file is None

    if synthetic and days_passed == 0 and active_testers == 0:
        raise fail("Provide --days-passed and --active-testers, or --from-file with a timeline.")

    history = (
        _load_history(from_file)
        if from_file is not None
        else flat_history(days_passed, active_testers)
    )

    status = evaluate(
        history,
        required_testers=required_testers,
        required_days=required_days,
        release_approved=release_approved,
        today=dt.date.today(),
    )

    if as_json:
        emit_json(status)
    else:
        console.print(render_testing_status(status, synthetic=synthetic))

    if not status.eligible:
        raise typer.Exit(int(ExitCode.FINDINGS))
