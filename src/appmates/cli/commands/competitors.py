"""`appmates competitors` and `appmates rank`."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import httpx
import typer
from rich.table import Table
from rich.text import Text

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.clients.itunes import (
    USER_AGENT,
    ITunesSearchClient,
    MarketDataError,
    ResponseCache,
    default_cache_dir,
)
from appmates.core.models.competitors import CompetitorReport, Device, RankReport
from appmates.core.services.competitor_analyzer import (
    DEFAULT_TOP_N,
    CompetitorAnalyzer,
    RankHistory,
    count_by,
    download_screenshots,
    extract_terms,
)


def _client(no_cache: bool, cache_dir: Path | None) -> ITunesSearchClient:
    cache = None if no_cache else ResponseCache(cache_dir or default_cache_dir())
    return ITunesSearchClient(cache=cache)


def _render_competitors(report: CompetitorReport) -> None:
    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("#", justify="right", style="muted")
    table.add_column("App")
    table.add_column("Publisher", style="muted")
    table.add_column("Ratings", justify="right")
    table.add_column("Stars", justify="right")
    table.add_column("Updated", justify="right")
    table.add_column("iPhone", justify="right")
    table.add_column("iPad", justify="right")

    for app in report.apps:
        age = app.days_since_update()
        if app.screenshots_exposed:
            phone = Text(str(app.iphone_count) or "—", style="" if app.iphone_count else "muted")
            pad = Text(str(app.ipad_count), style="" if app.ipad_count else "muted")
        else:
            phone = pad = Text("n/a", style="muted")

        table.add_row(
            str(app.position),
            app.name[:34],
            app.seller[:22],
            f"{app.rating_count:,}",
            f"{app.rating:.1f}" if app.rating is not None else "—",
            f"{age}d" if age is not None else "—",
            phone,
            pad,
        )

    console.print()
    console.print(table)


def _render_strategy(report: CompetitorReport) -> None:
    strategy = report.strategy
    if strategy is None or not strategy.apps_sampled:
        return

    rows = [
        ("Median iPhone screenshots", f"{strategy.median_count:g}"),
        (
            "Count distribution",
            " · ".join(f"{k}×{v}" for k, v in count_by(strategy.counts).items()),
        ),
        ("Mostly portrait", f"{strategy.portrait_apps} of {strategy.apps_sampled}"),
        ("Ship iPad screenshots", f"{strategy.ipad_apps} of {strategy.apps_sampled}"),
        ("Using all 10 slots", str(strategy.uses_max_slots)),
    ]

    table = Table(box=None, pad_edge=False, padding=(0, 2), show_header=False)
    table.add_column("", style="muted", width=26)
    table.add_column("")
    for label, value in rows:
        table.add_row(label, value)

    console.print()
    console.print("[bold]What this field does with screenshots[/bold]")
    console.print(table)
    console.print(
        f"[muted]Computed from the {strategy.apps_sampled} app(s) whose screenshots the "
        f"catalogue exposed ({strategy.coverage_percent:g}% of those checked).[/muted]"
    )


def _render_terms(report: CompetitorReport) -> None:
    if not report.terms:
        return

    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("Term", style="bold")
    table.add_column("Consensus", justify="right")
    table.add_column("In app names", justify="right")
    table.add_column("In descriptions", justify="right")
    table.add_column("Yours", justify="center")

    for term in report.terms:
        table.add_row(
            term.term,
            f"{term.score:.0f}",
            f"{term.apps_in_name}/{term.apps_total}",
            f"{term.apps_in_description}/{term.apps_total}",
            Text("yes", style="success") if term.in_your_listing else Text("—", style="muted"),
        )

    console.print()
    console.print("[bold]What this field targets[/bold]")
    console.print(table)
    console.print(
        "[muted]App names weigh four times descriptions: a word in a 30-character "
        "name is a decision, the same word in paragraph four may be prose.[/muted]"
    )
    console.print(
        "[muted]Only names and descriptions are public — subtitles and keyword "
        "fields are not, so this is a floor on what rivals target, not the whole.[/muted]"
    )

    missing = [t.term for t in report.missing_terms][:10]
    if missing:
        console.print()
        console.print(f"  Not in your listing: [warning]{', '.join(missing)}[/warning]")
        console.print(
            f"  [muted]appmates keywords --title '…' "
            f"{' '.join(f'-t {t!r}' for t in missing[:3])}[/muted]"
        )


def _render_screenshot_urls(report: CompetitorReport) -> None:
    console.print()
    console.print("[bold]Screenshots[/bold]")
    for app in report.apps:
        if not app.screenshots:
            continue
        console.print(f"\n  [bold]#{app.position} {app.name}[/bold]")
        for shot in app.screenshots:
            dims = f"{shot.width}×{shot.height}" if shot.width else "size unknown"
            console.print(f"    [muted]{shot.device.value:<7}{dims:>12}[/muted]  {shot.url}")


def competitors(
    keyword: Annotated[str, typer.Argument(help="Search term to inspect.")],
    country: Annotated[str, typer.Option("--country", "-c", help="Storefront (ISO code).")] = "us",
    top: Annotated[
        int, typer.Option("--top", "-n", min=1, max=50, help="How many competitors to show.")
    ] = DEFAULT_TOP_N,
    show_terms: Annotated[
        bool,
        typer.Option("--terms", help="Show the vocabulary this field agrees on."),
    ] = False,
    your_listing: Annotated[
        str | None,
        typer.Option("--mine", help="Your own title/subtitle, to mark terms you already have."),
    ] = None,
    show_screenshots: Annotated[
        bool, typer.Option("--screenshots", help="List every screenshot URL.")
    ] = False,
    download: Annotated[
        Path | None,
        typer.Option("--download", help="Save competitor screenshots to this directory."),
    ] = None,
    thumb_width: Annotated[
        int,
        typer.Option("--width", help="Request a specific width when downloading (0 = as served)."),
    ] = 0,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
    no_cache: Annotated[bool, typer.Option("--no-cache", help="Bypass the local cache.")] = False,
    cache_dir: Annotated[Path | None, typer.Option("--cache-dir", help="Cache location.")] = None,
) -> None:
    """Show who you are up against for a search term, and how they present.

    Competitors are listed in the order the public catalogue returns them,
    which is its own relevance ordering — see [bold]appmates rank[/bold] for
    what that does and does not mean.

    Screenshot availability is partial: across a 55-app sample the catalogue
    exposed iPhone screenshots for 47% of apps. Apps it withheld are marked
    [bold]n/a[/bold] rather than shown as having none, and the niche summary
    says which sample it was computed from.
    """
    analyzer = CompetitorAnalyzer(_client(no_cache, cache_dir))

    try:
        report = analyzer.competitors(keyword, country=country, top_n=top)
    except MarketDataError as exc:
        raise fail(str(exc)) from exc

    if show_terms or as_json:
        report.terms = extract_terms(report.apps, your_text=your_listing or "")

    if as_json:
        emit_json(report)
        raise typer.Exit(int(ExitCode.OK))

    console.print()
    console.print(
        f"[bold]{report.keyword}[/bold] · {report.country} · "
        f"[muted]{report.result_count} results[/muted]"
    )
    _render_competitors(report)
    _render_strategy(report)

    if show_terms:
        _render_terms(report)

    for note in report.notes:
        console.print(f"\n  [warning]![/warning] [muted]{note}[/muted]")

    if show_screenshots:
        _render_screenshot_urls(report)

    if download is not None:
        _download_all(report, download, thumb_width)

    console.print()
    raise typer.Exit(int(ExitCode.OK))


def _download_all(report: CompetitorReport, directory: Path, width: int) -> None:
    failures: list[str] = []

    with httpx.Client(timeout=20.0, headers={"User-Agent": USER_AGENT}) as client:

        def fetch(url: str) -> bytes:
            try:
                response = client.get(url)
                response.raise_for_status()
                return response.content
            except httpx.HTTPStatusError as exc:
                failures.append(f"HTTP {exc.response.status_code}")
                return b""
            except httpx.HTTPError as exc:
                failures.append(type(exc).__name__)
                return b""

        attempted = 0
        total = 0
        for app in report.apps:
            phone_shots = [s for s in app.screenshots if s.device is Device.IPHONE]
            if not phone_shots:
                continue
            attempted += len(phone_shots)
            total += len(download_screenshots(app, directory, fetch=fetch, width=width))

    console.print()
    if total:
        console.print(f"  Saved [bold]{total}[/bold] screenshot(s) to {directory}")
        console.print(
            "  [muted]These are other developers' copyrighted assets, saved for "
            "reference. Use them to study conventions, not to reproduce.[/muted]"
        )

    # A download that fetches nothing must say so. Reporting "Saved 0" and
    # stopping leaves the user staring at an empty directory with no idea
    # whether the competitors had no screenshots or every request failed.
    if failures:
        reasons = ", ".join(sorted(set(failures)))
        console.print(
            f"  [error]✗[/error] {len(failures)} of {attempted} download(s) failed ({reasons})."
        )
    elif not attempted:
        console.print(
            "  [warning]![/warning] [muted]None of these competitors had iPhone "
            "screenshots exposed, so there was nothing to download.[/muted]"
        )


def _render_rank(report: RankReport) -> None:
    table = Table(box=None, pad_edge=False, padding=(0, 2))
    table.add_column("Keyword", style="bold")
    table.add_column("Position", justify="right")
    table.add_column("Movement", justify="right")
    table.add_column("Since", style="muted")

    for position in report.positions:
        # Narrow on the field rather than the `found` property: the property is
        # computed, so a type checker cannot see that it implies non-None here.
        place = (
            Text(f"#{position.position}", style="success" if position.position <= 10 else "")
            if position.position is not None
            else Text(f"not in top {position.searched_depth}", style="error")
        )

        movement = position.movement
        if movement is None:
            moved = Text("—", style="muted")
        elif movement > 0:
            moved = Text(f"▲ {movement}", style="success")
        elif movement < 0:
            moved = Text(f"▼ {abs(movement)}", style="error")
        else:
            moved = Text("=", style="muted")

        table.add_row(
            position.keyword,
            place,
            moved,
            position.previous_date.isoformat() if position.previous_date else "",
        )

    console.print()
    console.print(table)


def rank(
    app_id: Annotated[
        str, typer.Argument(help="App Store numeric id, or a bundle id like com.example.app.")
    ],
    keywords: Annotated[list[str], typer.Argument(help="Search terms to check.")],
    country: Annotated[str, typer.Option("--country", "-c", help="Storefront (ISO code).")] = "us",
    depth: Annotated[
        int, typer.Option("--depth", min=10, max=200, help="How far down the results to look.")
    ] = 200,
    history_file: Annotated[
        Path | None,
        typer.Option("--history", help="Record this run and compare against previous ones."),
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
    no_cache: Annotated[bool, typer.Option("--no-cache", help="Bypass the local cache.")] = False,
    cache_dir: Annotated[Path | None, typer.Option("--cache-dir", help="Cache location.")] = None,
) -> None:
    """Find where an app sits in the public catalogue's results for each term.

    [bold]What this measures.[/bold] The public catalogue endpoint returns
    results in its own relevance order, and this reports your app's place in
    that order. It is a real, repeatable signal and it moves when your metadata
    moves.

    [bold]What it is not.[/bold] The App Store app serves search through a
    different path, with personalisation and paid placements, so the two can
    disagree. Treat this as a directional measure of how your listing is
    indexed, not as the number a user would see.

    Pass [bold]--history[/bold] to append each run to a local file and see
    movement between runs — there is no server, so the file is the record.
    """
    cleaned = [k.strip() for k in keywords if k.strip()]
    if not cleaned:
        raise fail("Give at least one search term.")

    analyzer = CompetitorAnalyzer(_client(no_cache, cache_dir))
    history = RankHistory(history_file) if history_file else None

    try:
        report = analyzer.rank(app_id, cleaned, country=country, depth=depth, history=history)
    except MarketDataError as exc:
        raise fail(str(exc)) from exc
    except LookupError as exc:
        raise fail(str(exc)) from exc

    if history is not None:
        history.append(report)

    if as_json:
        emit_json(report)
        raise typer.Exit(int(ExitCode.OK))

    console.print()
    console.print(
        f"[bold]{report.app_name}[/bold] · {report.country} · "
        f"[muted]ranked for {report.ranked_for}/{len(report.positions)} term(s)[/muted]"
    )
    _render_rank(report)

    console.print()
    console.print(
        "[muted]Position in the public catalogue's relevance order, not the "
        "App Store app's ranking. See --help.[/muted]"
    )
    if history is not None:
        console.print(f"[muted]Recorded in {history.path}[/muted]")

    console.print()
    raise typer.Exit(int(ExitCode.OK))
