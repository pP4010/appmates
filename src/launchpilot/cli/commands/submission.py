"""`launchpilot submission-check` — one go/no-go answer, composed from the
checks AppMates already runs separately."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from launchpilot.cli.console import ExitCode, console, emit_json, fail
from launchpilot.core.errors import LaunchPilotError
from launchpilot.core.services.reporting import render_submission
from launchpilot.core.services.submission_checker import check_submission


def submission_check(
    screenshots: Annotated[
        Path | None,
        typer.Option(
            "--screenshots",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            help="Directory of screenshots to check.",
        ),
    ] = None,
    metadata_file: Annotated[
        Path | None,
        typer.Option(
            "--metadata",
            exists=True,
            dir_okay=False,
            readable=True,
            help="TOML or JSON listing file.",
        ),
    ] = None,
    locale: Annotated[
        str,
        typer.Option(
            "--locale",
            help="Which locale in --metadata feeds the keyword audit's title/subtitle/keywords.",
        ),
    ] = "en-US",
    field: Annotated[
        str | None,
        typer.Option(
            "--keywords", help="Keyword field to audit, if not reading one from --metadata."
        ),
    ] = None,
    strict: Annotated[
        bool, typer.Option("--strict", help="Treat warnings as failures (exit 1).")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Run every local check at once and give one go/no-go answer.

    Equivalent to running validate-screenshots, validate-metadata and keywords
    separately and doing the "is this actually ready" arithmetic by hand —
    this runs whichever of the three you give inputs for and combines them.
    """
    if screenshots is None and metadata_file is None and field is None:
        raise fail("Give at least one of --screenshots, --metadata, or --keywords.")

    try:
        report = check_submission(
            screenshots_dir=screenshots,
            metadata_file=metadata_file,
            metadata_locale=locale,
            keyword_field=field,
        )
    except LaunchPilotError as exc:
        raise fail(str(exc)) from exc

    if as_json:
        emit_json(report)
    else:
        console.print(render_submission(report))

    if not report.is_ok(strict=strict):
        raise typer.Exit(int(ExitCode.FINDINGS))
