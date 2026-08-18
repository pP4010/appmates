"""Spec catalogue inspection command."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

import typer

from appmates.cli.console import console, emit_json
from appmates.core.models.report import Store
from appmates.core.services.reporting import render_specs
from appmates.core.specs.registry import load_spec


class SpecStoreChoice(StrEnum):
    APPLE = "apple"
    GOOGLE = "google"
    ALL = "all"


def specs(
    store: Annotated[
        SpecStoreChoice, typer.Option("--store", "-s", help="Which catalogue to show.")
    ] = SpecStoreChoice.ALL,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Show the bundled store specifications and when they were last verified."""
    targets = [Store.APPLE, Store.GOOGLE] if store is SpecStoreChoice.ALL else [Store(store.value)]
    loaded = [load_spec(s) for s in targets]

    if as_json:
        emit_json([s.model_dump(mode="json") for s in loaded])
    else:
        console.print(render_specs(loaded))
