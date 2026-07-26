"""`launchpilot markets` — which storefront to launch into."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table
from rich.text import Text

from launchpilot.cli.console import ExitCode, console, emit_json, fail
from launchpilot.core.clients.itunes import (
    ITunesSearchClient,
    MarketDataError,
    ResponseCache,
    default_cache_dir,
)
from launchpilot.core.models.market import Verdict
from launchpilot.core.services.market_scanner import (
    DEFAULT_STOREFRONTS,
    MarketScanner,
    MarketScanReport,
    resolve_countries,
)

VERDICT_STYLE = {
    Verdict.OPEN.value: "success",
    Verdict.CONTESTED.value: "warning",
    Verdict.LOCKED.value: "error",
    "unknown": "muted",
}


def _meter(score: float, width: int = 12) -> Text:
    filled = round(width * score / 100)
    style = "success" if score >= 60 else "warning" if score >= 35 else "error"
    return Text("█" * filled + "░" * (width - filled), style=style)


def _render(report: MarketScanReport) -> None:
    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("Storefront", style="bold")
    table.add_column("", justify="right", style="muted")
    table.add_column("Score", justify="right")
    table.add_column("")
    table.add_column("Verdict")
    table.add_column("Credible rivals", justify="right", style="muted")

    for result in report.ranked():
        if not result.ok:
            table.add_row(
                result.country_name,
                result.country.upper(),
                "—",
                Text("unavailable", style="muted"),
                Text("error", style="muted"),
                "",
            )
            continue

        assert result.report is not None
        depth = next(
            (s.observed for s in result.report.signals if s.code == "COMPETITIVE_DEPTH"),
            0.0,
        )
        table.add_row(
            result.country_name,
            result.country.upper(),
            f"{result.winnability:.0f}",
            _meter(result.winnability),
            Text(result.verdict.upper(), style=VERDICT_STYLE[result.verdict]),
            f"{depth:.0f}",
        )

    console.print()
    console.print(table)


def markets(
    keyword: Annotated[str, typer.Argument(help="The search term to scan.")],
    countries: Annotated[
        str | None,
        typer.Option(
            "--countries",
            help="Comma-separated storefronts, e.g. 'us,fr,de,jp'. Defaults to 14 majors.",
        ),
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
    no_cache: Annotated[bool, typer.Option("--no-cache", help="Bypass the local cache.")] = False,
    cache_dir: Annotated[Path | None, typer.Option("--cache-dir", help="Cache location.")] = None,
) -> None:
    """Score one keyword across many storefronts and rank them.

    Every ASO tool asks "how hard is this keyword?" as though there were one
    answer. There are 175 storefronts and the answer differs in each — a term
    locked in the United States is routinely open in France, Brazil or Poland,
    because difficulty tracks the language it is searched in more than the size
    of the country.

    That makes it a launch decision: which locale to write first, which language
    to localise screenshots into. It is decidable from public data, and almost
    nobody asks it before shipping.

    This is deliberately slow. It makes one request per storefront against a
    free endpoint that rate-limits, spaced politely apart, so a fourteen-country
    sweep takes roughly a minute the first time and is cached afterwards.
    """
    codes = resolve_countries(countries)
    client = ITunesSearchClient(
        cache=None if no_cache else ResponseCache(cache_dir or default_cache_dir())
    )
    scanner = MarketScanner(client)

    def progress(code: str, index: int, total: int) -> None:
        if not as_json:
            console.print(f"  [muted]({index}/{total}) {code.upper()}…[/muted]", end="\r")

    try:
        report = scanner.scan(keyword, codes, on_progress=progress)
    except MarketDataError as exc:
        raise fail(str(exc)) from exc

    if not as_json:
        console.print(" " * 40, end="\r")  # clear the progress line

    if as_json:
        emit_json(report)
        raise typer.Exit(int(ExitCode.OK))

    console.print()
    console.print(f"[bold]{report.keyword}[/bold] across {len(report.results)} storefront(s)")
    _render(report)

    console.print()
    usable = [r for r in report.ranked() if r.ok]
    if report.verdicts_differ and usable:
        best, worst = usable[0], usable[-1]
        console.print(
            f"  This term is [{VERDICT_STYLE[best.verdict]}]{best.verdict.upper()}"
            f"[/{VERDICT_STYLE[best.verdict]}] in {best.country_name} and "
            f"[{VERDICT_STYLE[worst.verdict]}]{worst.verdict.upper()}"
            f"[/{VERDICT_STYLE[worst.verdict]}] in {worst.country_name}."
        )
        console.print(
            "  [muted]Which storefront you lead with is a bigger lever here than "
            "anything you can do to the listing itself.[/muted]"
        )
    elif report.spread >= 25 and usable:
        best, worst = usable[0], usable[-1]
        console.print(
            f"  [bold]{report.spread:.0f} points[/bold] separate {best.country_name} "
            f"from {worst.country_name}, though the verdict holds throughout."
        )
    elif usable:
        console.print(
            f"  [muted]Every storefront lands on {usable[0].verdict.upper()} "
            f"within {report.spread:.0f} points — this term is about as hard "
            "everywhere.[/muted]"
        )

    if report.open_countries:
        console.print(
            f"  Open in: [success]{', '.join(c.upper() for c in report.open_countries)}[/success]"
        )

    if report.failed_countries:
        console.print(
            f"  [warning]![/warning] [muted]No data for "
            f"{', '.join(c.upper() for c in report.failed_countries)}.[/muted]"
        )

    console.print()
    console.print(
        f"[muted]Methodology v{report.methodology_version} · same six signals as "
        f"`launchpilot niche`, one storefront at a time.[/muted]"
    )
    raise typer.Exit(int(ExitCode.OK))


__all__ = ["DEFAULT_STOREFRONTS", "markets"]
