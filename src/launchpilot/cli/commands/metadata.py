"""Store listing text validation command."""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated

import typer

from launchpilot.cli.console import ExitCode, console, emit_json, fail
from launchpilot.core.errors import LaunchPilotError
from launchpilot.core.models.report import Store
from launchpilot.core.services.metadata_validator import MetadataValidator, load_listing
from launchpilot.core.services.reporting import render_metadata


class MetadataStoreChoice(StrEnum):
    APPLE = "apple"
    GOOGLE = "google"
    BOTH = "both"


def validate_metadata(
    metadata_file: Annotated[
        Path,
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help="TOML or JSON file describing the listing.",
        ),
    ],
    store: Annotated[
        MetadataStoreChoice,
        typer.Option("--store", "-s", help="Which store's limits to apply."),
    ] = MetadataStoreChoice.BOTH,
    strict: Annotated[
        bool, typer.Option("--strict", help="Treat warnings as failures (exit 1).")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Check listing text against Apple and Play field limits.

    Unlike screenshots, one text file legitimately targets both stores at once,
    so --store defaults to checking both.
    """
    stores = (
        [Store.APPLE, Store.GOOGLE] if store is MetadataStoreChoice.BOTH else [Store(store.value)]
    )

    try:
        listing = load_listing(metadata_file)
    except LaunchPilotError as exc:
        raise fail(str(exc)) from exc

    if not listing.locales:
        raise fail(f"{metadata_file} contains no locales to check.")

    report = MetadataValidator(stores).validate_listing(listing)
    report.source = metadata_file

    if as_json:
        emit_json(report)
    else:
        console.print(render_metadata(report))

    if not report.is_ok(strict=strict):
        raise typer.Exit(int(ExitCode.FINDINGS))
