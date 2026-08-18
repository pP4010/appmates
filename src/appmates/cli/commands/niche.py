"""`appmates niche` — is this market worth entering?"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.clients.itunes import (
    ITunesSearchClient,
    MarketDataError,
    ResponseCache,
    default_cache_dir,
)
from appmates.core.models.market import Band, KeywordReport, NicheReport, Verdict
from appmates.core.services.market_analyzer import DEFAULT_FETCH_LIMIT, NicheAnalyzer

BAND_STYLE = {
    Band.FAVOURABLE: "success",
    Band.NEUTRAL: "info",
    Band.HOSTILE: "error",
}

VERDICT_STYLE = {
    Verdict.OPEN: "success",
    Verdict.CONTESTED: "warning",
    Verdict.LOCKED: "error",
}

VERDICT_BLURB = {
    Verdict.OPEN: "a good app can plausibly rank here",
    Verdict.CONTESTED: "winnable, but it will take sustained effort",
    Verdict.LOCKED: "ranking here is a multi-year project",
}


def _meter(score: float, width: int = 22) -> Text:
    filled = round(width * score / 100)
    style = "success" if score >= 65 else "warning" if score >= 35 else "error"
    return Text("█" * filled + "░" * (width - filled), style=style)


def _render_summary(report: NicheReport) -> None:
    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("Keyword", style="bold")
    table.add_column("Winnability", justify="right")
    table.add_column("")
    table.add_column("Verdict")
    table.add_column("Apps", justify="right", style="muted")

    for keyword in report.sorted_by_opportunity():
        verdict = keyword.verdict
        table.add_row(
            keyword.keyword,
            f"{keyword.winnability:.0f}",
            _meter(keyword.winnability),
            Text(verdict.value.upper(), style=VERDICT_STYLE[verdict]),
            f"{keyword.result_count:,}",
        )

    console.print()
    console.print(table)


def _render_detail(keyword: KeywordReport) -> None:
    verdict = keyword.verdict
    header = Text.assemble(
        (keyword.keyword, "bold"),
        (f"  {keyword.winnability:.0f}/100  ", "bold"),
        (verdict.value.upper(), VERDICT_STYLE[verdict]),
        (f" — {VERDICT_BLURB[verdict]}", "muted"),
    )

    table = Table(box=None, pad_edge=False, padding=(0, 2), show_header=False)
    table.add_column("", justify="right", width=6)
    table.add_column("", width=24)
    table.add_column("", justify="right", width=12)
    table.add_column("", overflow="fold")

    for signal in keyword.signals:
        style = BAND_STYLE[signal.band]
        observed = (
            f"{signal.observed:.1f} {signal.unit}"
            if signal.unit in {"stars", "percent"}
            else f"{signal.observed:,.0f} {signal.unit}"
        )
        table.add_row(
            Text(f"{signal.score:.0f}", style=style),
            signal.label,
            Text(observed, style="muted"),
            Text(signal.rationale, style="muted"),
        )

    console.print()
    console.print(Panel(table, title=header, title_align="left", border_style="dim"))

    for note in keyword.notes:
        console.print(f"  [warning]![/warning] [muted]{note}[/muted]")


def _render_leaders(keyword: KeywordReport) -> None:
    if not keyword.top_apps:
        return

    table = Table(
        box=None,
        pad_edge=False,
        padding=(0, 2),
        title=f"Leaders for “{keyword.keyword}”",
        title_style="bold",
        title_justify="left",
    )
    table.add_column("#", justify="right", style="muted")
    table.add_column("App")
    table.add_column("Ratings", justify="right")
    table.add_column("Stars", justify="right")
    table.add_column("Updated", justify="right")
    table.add_column("Targets term", justify="center")

    for index, app in enumerate(keyword.top_apps, start=1):
        age = app.days_since_update()
        table.add_row(
            str(index),
            app.name[:38],
            f"{app.rating_count:,}",
            f"{app.rating:.1f}" if app.rating is not None else "—",
            f"{age}d" if age is not None else "—",
            Text("yes", style="error") if app.has_keyword_in_name else Text("no", style="success"),
        )

    console.print()
    console.print(table)


def niche(
    keywords: Annotated[
        list[str],
        typer.Argument(help="Search terms to assess, e.g. 'habit tracker' 'daily routine'."),
    ],
    country: Annotated[
        str, typer.Option("--country", "-c", help="Storefront to analyse (ISO code).")
    ] = "us",
    limit: Annotated[
        int, typer.Option("--limit", "-l", min=10, max=200, help="Catalogue entries to fetch.")
    ] = DEFAULT_FETCH_LIMIT,
    show_leaders: Annotated[
        bool, typer.Option("--leaders", help="List the competing apps behind the scores.")
    ] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
    no_cache: Annotated[
        bool, typer.Option("--no-cache", help="Bypass the local response cache.")
    ] = False,
    cache_dir: Annotated[
        Path | None, typer.Option("--cache-dir", help="Where to cache catalogue responses.")
    ] = None,
) -> None:
    """Assess whether a keyword's market is worth entering.

    Reads the public App Store catalogue — no account, no API key, no Apple
    Search Ads campaign required — and scores what it finds against the published
    methodology in [bold]core/specs/market.yaml[/bold].

    There is deliberately no "search volume" figure here. Apple does not publish
    per-keyword search counts, and the Search Ads popularity index other tools
    relabel as volume is a relative score that Apple degraded sharply in
    September 2025. Every number below is something that was counted.
    """
    cleaned = [k.strip() for k in keywords if k.strip()]
    if not cleaned:
        raise fail("Give at least one search term.")

    cache = None if no_cache else ResponseCache(cache_dir or default_cache_dir())
    analyzer = NicheAnalyzer(ITunesSearchClient(cache=cache))

    try:
        report = analyzer.analyse(cleaned, country=country, limit=limit)
    except MarketDataError as exc:
        raise fail(str(exc)) from exc

    if as_json:
        emit_json(report)
        raise typer.Exit(int(ExitCode.OK))

    if len(report.keywords) > 1:
        _render_summary(report)

    for keyword in report.sorted_by_opportunity():
        _render_detail(keyword)
        if show_leaders:
            _render_leaders(keyword)

    console.print()
    console.print(
        f"[muted]Methodology v{report.methodology_version} · public catalogue, "
        f"no credentials · scores are observations, not estimates.[/muted]"
    )
    raise typer.Exit(int(ExitCode.OK))
