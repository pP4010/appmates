"""Screenshot validation and repair commands."""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated

import typer

from launchpilot.cli.console import ExitCode, console, emit_json, fail
from launchpilot.core.errors import LaunchPilotError
from launchpilot.core.models.report import Store
from launchpilot.core.services.image_fixer import ScreenshotFixer, targets_for
from launchpilot.core.services.image_validator import (
    ScreenshotValidator,
    detect_target_store,
    suppress_findings,
)
from launchpilot.core.services.reporting import render_fix_result, render_validation


class StoreChoice(StrEnum):
    AUTO = "auto"
    APPLE = "apple"
    GOOGLE = "google"
    BOTH = "both"


def _resolve_stores(choice: StoreChoice, directory: Path) -> list[Store]:
    """Turn the ``--store`` flag into the store list to validate against.

    ``auto`` exists because App Store and Play screenshots are different assets:
    every Apple size violates Play's "long side <= 2x short side" rule, so
    checking one directory against both always yields errors.
    """
    if choice is StoreChoice.BOTH:
        return [Store.APPLE, Store.GOOGLE]
    if choice is StoreChoice.AUTO:
        return [detect_target_store(directory)]
    return [Store(choice.value)]


def validate_screenshots(
    directory: Annotated[
        Path,
        typer.Argument(
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            help="Directory of screenshots to check.",
        ),
    ],
    store: Annotated[
        StoreChoice,
        typer.Option("--store", "-s", help="Which store's rules to apply."),
    ] = StoreChoice.AUTO,
    strict: Annotated[
        bool,
        typer.Option("--strict", help="Treat warnings as failures (exit 1)."),
    ] = False,
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Emit the report as JSON instead of a table."),
    ] = False,
    ignore: Annotated[
        list[str] | None,
        typer.Option("--ignore", "-i", help="Suppress a finding code. Repeatable."),
    ] = None,
) -> None:
    """Check screenshots against App Store / Play requirements.

    Exit code is 1 when errors are found, so this can gate a release pipeline.
    """
    try:
        stores = _resolve_stores(store, directory)
        report = ScreenshotValidator(stores).validate_set(directory)
    except LaunchPilotError as exc:
        raise fail(str(exc)) from exc

    report = suppress_findings(report, ignore or [])

    if as_json:
        emit_json(report)
    else:
        if store is StoreChoice.AUTO:
            detected = stores[0].value
            console.print(
                f"[muted]Auto-detected target store:[/muted] [bold]{detected}[/bold] "
                "[muted](override with --store)[/muted]"
            )
        console.print(render_validation(report))

    if not report.is_ok(strict=strict):
        raise typer.Exit(int(ExitCode.FINDINGS))


def fix_screenshots(
    directory: Annotated[
        Path,
        typer.Argument(exists=True, file_okay=False, dir_okay=True, readable=True),
    ],
    output: Annotated[
        Path | None,
        typer.Option("--out", "-o", help="Where to write repaired copies. Required to write."),
    ] = None,
    store: Annotated[
        StoreChoice,
        typer.Option("--store", "-s", help="Which store's rules to target."),
    ] = StoreChoice.AUTO,
    target: Annotated[
        str | None,
        typer.Option("--target", "-t", help="Force a spec id, e.g. apple-iphone-6.9."),
    ] = None,
    background: Annotated[
        str,
        typer.Option("--background", "-b", help="Fill colour for flattening and padding."),
    ] = "#FFFFFF",
    force: Annotated[
        bool,
        typer.Option("--force", help="Allow writing into a non-empty output directory."),
    ] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Repair screenshots: flatten alpha, convert to sRGB, resize to spec.

    Originals are never modified. Without --out this only prints the plan.
    """
    if store is StoreChoice.BOTH:
        raise fail("--store both cannot be used with fix; pick one target store.")

    resolved = detect_target_store(directory) if store is StoreChoice.AUTO else Store(store.value)
    dry_run = output is None
    out_dir = output or directory

    try:
        fixer = ScreenshotFixer(resolved, background=background, target_spec_id=target)
    except ValueError as exc:
        raise fail(f"Invalid --background colour {background!r}: {exc}") from exc

    if target and fixer.spec.get(target) is None:
        valid = ", ".join(s.id for s in targets_for(resolved))
        raise fail(f"Unknown --target {target!r}. Valid ids: {valid}")

    try:
        result = fixer.fix_directory(directory, out_dir, dry_run=dry_run, force=force)
    except LaunchPilotError as exc:
        raise fail(str(exc)) from exc

    if as_json:
        emit_json(result)
    else:
        console.print(render_fix_result(result))
        if dry_run:
            console.print(
                "[muted]Dry run — pass[/muted] [bold]--out <dir>[/bold] "
                "[muted]to write the repaired copies.[/muted]"
            )

    if result.failed:
        raise typer.Exit(int(ExitCode.FINDINGS))
