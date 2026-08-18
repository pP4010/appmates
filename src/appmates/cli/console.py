"""Shared console, exit codes and output helpers."""

from __future__ import annotations

import json
from enum import IntEnum
from typing import Any

import typer
from pydantic import BaseModel
from rich.console import Console
from rich.theme import Theme

THEME = Theme(
    {
        "error": "bold red",
        "warning": "yellow",
        "info": "cyan",
        "success": "bold green",
        "muted": "dim",
    }
)

console = Console(theme=THEME)
err_console = Console(theme=THEME, stderr=True)


class ExitCode(IntEnum):
    """Exit codes, so AppMates is usable as a CI gate.

    Findings and usage errors are deliberately distinct: a broken path should
    not look like a failed validation.
    """

    OK = 0
    FINDINGS = 1
    USAGE = 2


def emit_json(payload: BaseModel | dict[str, Any] | list[Any]) -> None:
    """Print machine-readable output on stdout.

    Uses pydantic's own serialiser so ``--json`` and the future HTTP API return
    byte-identical payloads.
    """
    if isinstance(payload, BaseModel):
        text = payload.model_dump_json(indent=2)
    else:
        text = json.dumps(payload, indent=2, default=str)
    # print() rather than console.print(): rich would wrap and highlight it.
    print(text)


def fail(message: str) -> typer.Exit:
    """Report a usage error on stderr and return the exception to raise."""
    err_console.print(f"[error]✗[/error] {message}")
    return typer.Exit(int(ExitCode.USAGE))
