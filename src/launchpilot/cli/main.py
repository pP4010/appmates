"""LaunchPilot command-line entry point.

This module only wires commands together. Every command delegates immediately
to a core service that returns Pydantic models, so the same logic backs the
CLI, the ``--json`` output and the planned HTTP API.
"""

from __future__ import annotations

from typing import Annotated

import typer

from launchpilot import __version__
from launchpilot.cli.commands.competitors import competitors, rank
from launchpilot.cli.commands.keywords import keywords
from launchpilot.cli.commands.metadata import validate_metadata
from launchpilot.cli.commands.niche import niche
from launchpilot.cli.commands.screenshots import fix_screenshots, validate_screenshots
from launchpilot.cli.commands.specs import specs
from launchpilot.cli.commands.tester import check_testers
from launchpilot.cli.console import console

app = typer.Typer(
    name="launchpilot",
    help=(
        "Pre-flight checks for App Store and Google Play releases.\n\n"
        "Catch the rejections before the stores do."
    ),
    no_args_is_help=True,
    add_completion=True,
    rich_markup_mode="rich",
)

app.command("validate-screenshots")(validate_screenshots)
app.command("fix-screenshots")(fix_screenshots)
app.command("validate-metadata")(validate_metadata)
app.command("check-testers")(check_testers)
app.command("niche")(niche)
app.command("keywords")(keywords)
app.command("competitors")(competitors)
app.command("rank")(rank)
app.command("specs")(specs)


def _version_callback(value: bool) -> None:
    if value:
        # highlight=False matters: rich's number highlighter would otherwise
        # split "0.1.0" into separately-styled runs, so `--version | grep 0.1.0`
        # fails whenever colour is enabled.
        console.print(f"launchpilot [bold]{__version__}[/bold]", highlight=False)
        raise typer.Exit


@app.callback()
def main(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            callback=_version_callback,
            is_eager=True,
            help="Show the version and exit.",
        ),
    ] = False,
) -> None:
    """LaunchPilot."""


if __name__ == "__main__":  # pragma: no cover
    app()
