"""`launchpilot keywords` — audit and rebuild the App Store keyword field."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table
from rich.text import Text

from launchpilot.cli.console import ExitCode, console, emit_json, fail
from launchpilot.core.errors import LaunchPilotError
from launchpilot.core.models.keywords import KeywordFieldReport
from launchpilot.core.models.report import Severity
from launchpilot.core.services.keyword_builder import KeywordBuilder
from launchpilot.core.services.metadata_validator import load_listing

SEVERITY_MARK = {
    Severity.ERROR: ("✗", "error"),
    Severity.WARNING: ("!", "warning"),
    Severity.INFO: ("·", "info"),
}


def _render_budget(report: KeywordFieldReport) -> None:
    used = report.length
    limit = report.max_length
    filled = round(30 * min(used, limit) / limit)
    over = used > limit

    bar = Text("█" * filled + "░" * (30 - filled), style="error" if over else "success")
    console.print()
    console.print(
        Text.assemble(
            ("  Budget  ", "bold"),
            bar,
            (f"  {used}/{limit}", "error" if over else ""),
            (f"  · {report.wasted_characters} wasted", "warning")
            if report.wasted_characters
            else ("", ""),
        )
    )


def _render_findings(report: KeywordFieldReport) -> None:
    if not report.findings:
        console.print("\n  [success]✓[/success] Nothing wasted.")
        return

    table = Table(box=None, pad_edge=False, padding=(0, 2), show_header=False)
    table.add_column("", width=2)
    table.add_column("", width=24)
    table.add_column("", justify="right", width=6)
    table.add_column("", overflow="fold")

    for finding in report.findings:
        mark, style = SEVERITY_MARK[finding.severity]
        cost = finding.metadata.get("cost")
        table.add_row(
            Text(mark, style=style),
            Text(finding.code, style=style),
            Text(f"-{cost}c", style="muted") if cost else "",
            Text.assemble(
                (finding.message, ""),
                (f"\n{finding.fix_hint}", "muted") if finding.fix_hint else ("", ""),
            ),
        )

    console.print()
    console.print(table)


def _render_coverage(report: KeywordFieldReport) -> None:
    if not report.coverage:
        return

    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("Target phrase", style="bold")
    table.add_column("Reachable")
    table.add_column("Indexed from", overflow="fold")

    for item in report.coverage:
        if item.covered:
            sources = ", ".join(f"{k} ({', '.join(v)})" for k, v in item.covered_by.items())
            table.add_row(item.phrase, Text("yes", style="success"), Text(sources, style="muted"))
        else:
            table.add_row(
                item.phrase,
                Text("no", style="error"),
                Text(f"missing: {', '.join(item.missing_words)}", style="error"),
            )

    console.print()
    console.print(table)


def keywords(
    metadata_file: Annotated[
        Path | None,
        typer.Argument(help="Listing file (TOML/JSON) to read title, subtitle and keywords from."),
    ] = None,
    title: Annotated[str | None, typer.Option("--title", help="App name.")] = None,
    subtitle: Annotated[str | None, typer.Option("--subtitle", help="Subtitle.")] = None,
    field: Annotated[
        str | None, typer.Option("--field", "-f", help="Existing keyword field to audit.")
    ] = None,
    targets: Annotated[
        list[str] | None,
        typer.Option("--target", "-t", help="A phrase you want to rank for. Repeatable."),
    ] = None,
    locale: Annotated[
        str, typer.Option("--locale", help="Which locale to read from a listing file.")
    ] = "en-US",
    apply_suggestion: Annotated[
        bool, typer.Option("--build", help="Print only the rebuilt field, for piping.")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
) -> None:
    """Audit the 100-character App Store keyword field, or build one.

    Apple indexes the app name, the subtitle and the keyword field as a single
    pool of words and combines them to form matches. Three things follow, and
    together they are most of what goes wrong:

    A phrase is reachable when every one of its [bold]words[/bold] is somewhere
    in the pool — storing the phrase itself buys nothing. A word already in the
    title is already indexed, so repeating it spends characters for no reach.
    And since Apple does the combining, every space in the field is overhead.

    The field is never shown to a user, so none of this is self-correcting: a
    listing with a third of its budget wasted looks exactly like a perfect one.
    """
    wanted = [t.strip() for t in (targets or []) if t.strip()]

    if metadata_file is not None:
        try:
            listing = load_listing(metadata_file)
        except (LaunchPilotError, OSError, ValueError) as exc:
            raise fail(str(exc)) from exc

        entry = next((m for m in listing.locales if m.locale == locale), None)
        if entry is None:
            available = ", ".join(m.locale for m in listing.locales) or "none"
            raise fail(f"Locale {locale!r} not found in {metadata_file}. Available: {available}.")
        title = title or entry.title
        subtitle = subtitle or entry.subtitle
        field = field if field is not None else entry.keywords

    if field is None and not wanted:
        raise fail("Give a keyword field with --field, a listing file, or targets with --target.")

    builder = KeywordBuilder()

    if field is None:
        built = builder.build(wanted, title=title, subtitle=subtitle)
        report = builder.audit(built, title=title, subtitle=subtitle, targets=wanted)
    else:
        report = builder.audit(field, title=title, subtitle=subtitle, targets=wanted)

    if apply_suggestion:
        # Bare stdout so the field can be piped straight into another tool.
        print(report.suggested_field or report.field_value)
        raise typer.Exit(int(ExitCode.OK))

    if as_json:
        emit_json(report)
        raise typer.Exit(int(ExitCode.FINDINGS if _has_errors(report) else ExitCode.OK))

    console.print()
    console.print(f"  [muted]field[/muted]  {report.field_value or '(empty)'}")
    _render_budget(report)
    _render_findings(report)
    _render_coverage(report)

    if report.suggested_field and report.suggested_field != report.field_value:
        saved = report.length - len(report.suggested_field)
        console.print()
        console.print(f"  [bold]suggested[/bold]  {report.suggested_field}")
        console.print(
            f"  [muted]{len(report.suggested_field)}/{report.max_length} characters"
            + (f", {saved} reclaimed" if saved > 0 else "")
            + "[/muted]"
        )

    console.print()
    raise typer.Exit(int(ExitCode.FINDINGS if _has_errors(report) else ExitCode.OK))


def _has_errors(report: KeywordFieldReport) -> bool:
    return any(f.severity is Severity.ERROR for f in report.findings)
