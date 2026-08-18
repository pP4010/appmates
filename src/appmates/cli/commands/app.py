"""`appmates app` — the state of one published listing."""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Annotated

import typer
from rich.table import Table
from rich.text import Text

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.clients.itunes import (
    ITunesSearchClient,
    MarketDataError,
    ResponseCache,
    default_cache_dir,
)
from appmates.core.models.app_profile import AppHealthReport
from appmates.core.models.report import Severity
from appmates.core.services.app_profile import AppHealthChecker, profile_from_entry

MARK = {True: ("✓", "success"), False: ("✗", "error")}


def _render_identity(report: AppHealthReport) -> None:
    p = report.profile
    rows: list[tuple[str, str]] = [
        ("Publisher", p.seller),
        ("Version", f"{p.version or '—'} · shipped {p.updated or 'unknown'}"),
        ("First released", str(p.released or "—")),
        ("Rating", f"{p.rating:.2f}★ from {p.rating_count:,}" if p.rating else "none yet"),
        ("Price", p.formatted_price or ("Free" if p.is_free else f"{p.price}")),
        ("Category", " · ".join(p.genres) or "—"),
        ("Size", f"{p.size_mb} MB" if p.file_size_bytes else "—"),
        ("Minimum iOS", p.minimum_os or "—"),
        ("Age rating", p.content_rating or "—"),
        ("Languages", f"{len(p.locales)} — {', '.join(p.locales[:10])}" if p.locales else "—"),
        (
            "Runs on",
            " and ".join(
                [d for d, ok in (("iPhone", p.supports_iphone), ("iPad", p.supports_ipad)) if ok]
            )
            or "—",
        ),
    ]

    table = Table(box=None, pad_edge=False, padding=(0, 2), show_header=False)
    table.add_column("", style="muted", width=15)
    table.add_column("")
    for label, value in rows:
        table.add_row(label, value)

    console.print()
    console.print(table)


def _render_checks(report: AppHealthReport) -> None:
    table = Table(box=None, pad_edge=False, padding=(0, 2), show_header=False)
    table.add_column("", width=2)
    table.add_column("", width=36)
    table.add_column("", overflow="fold")

    for check in report.checks:
        if not check.checkable:
            mark, style = "?", "muted"
        else:
            mark, style = MARK[check.passed]
        table.add_row(
            Text(mark, style=style),
            Text(check.label, style="" if check.checkable else "muted"),
            Text.assemble(
                (check.detail, "muted"),
                (f"\n→ {check.fix_hint}", "warning") if check.fix_hint else ("", ""),
            ),
        )

    console.print()
    console.print("[bold]Listing health[/bold]")
    console.print(table)


def app_overview(
    app_id: Annotated[
        str, typer.Argument(help="App Store numeric id, or a bundle id like com.example.app.")
    ],
    country: Annotated[str, typer.Option("--country", "-c", help="Storefront (ISO code).")] = "us",
    as_json: Annotated[bool, typer.Option("--json", help="Emit the report as JSON.")] = False,
    no_cache: Annotated[bool, typer.Option("--no-cache", help="Bypass the local cache.")] = False,
    cache_dir: Annotated[Path | None, typer.Option("--cache-dir", help="Cache location.")] = None,
) -> None:
    """Show one published listing and what is left to fix on it.

    Three things bound what can be checked, and each is reported rather than
    worked around. Screenshot URLs serve a downscaled image that preserves the
    aspect ratio but not the resolution, so the device family is inferred and
    the uploaded pixel size is never claimed. The catalogue exposes iPhone
    screenshots for roughly half of apps; when it withholds them, this command
    falls back to the real product page, which embeds them at full resolution.
    That fallback uses an undocumented Apple structure, so it can silently stop
    working — an empty set still means "not exposed", not "none shipped".
    Subtitles and the keyword field are not public at all.

    Checks that cannot be answered are marked [bold]?[/bold] and excluded from
    the score — an app whose screenshots the catalogue happened to withhold
    should not rank below one whose it happened to return.
    """
    cache = None if no_cache else ResponseCache(cache_dir or default_cache_dir())
    client = ITunesSearchClient(cache=cache)

    try:
        entry = client.lookup(app_id, country=country)
    except MarketDataError as exc:
        raise fail(str(exc)) from exc

    if entry is None:
        raise fail(
            f"No app found for {app_id!r} in the {country.upper()} storefront. "
            "Use a numeric App Store id or a bundle id."
        )

    # Triggered on iPhone specifically, not "both empty": the catalogue often
    # returns iPad shots without iPhone ones (roughly half of apps), and that
    # partial answer must not stop the one device iPhone-first developers
    # actually came here to check from being recovered.
    recovered_screenshots = False
    if not entry.get("screenshotUrls"):
        with contextlib.suppress(MarketDataError):
            page_shots = client.fetch_page_screenshots(int(entry["trackId"]), country=country)
            if page_shots and page_shots["iphone"]:
                entry = {**entry, "screenshotUrls": page_shots["iphone"]}
                if not entry.get("ipadScreenshotUrls"):
                    entry["ipadScreenshotUrls"] = page_shots["ipad"]
                recovered_screenshots = True

    report = AppHealthChecker().check(profile_from_entry(entry))

    if as_json:
        payload = report.model_dump()
        if recovered_screenshots:
            payload["screenshots_recovered_from_page"] = True
        emit_json(payload)
        raise typer.Exit(int(ExitCode.OK))

    p = report.profile
    console.print()
    console.print(f"[bold]{p.name}[/bold]  [muted]{p.store_url or ''}[/muted]")
    if recovered_screenshots:
        console.print(
            "[muted]Screenshots recovered from the App Store product page — the "
            "catalogue API did not return them. This uses an undocumented Apple "
            "structure and may stop working without notice.[/muted]"
        )
    _render_identity(report)
    _render_checks(report)

    console.print()
    tone = "success" if report.score >= 80 else "warning" if report.score >= 50 else "error"
    console.print(
        f"  [{tone}]{report.score:.0f}/100[/{tone}] — "
        f"{report.passed_count} of {report.checked_count} answerable checks passed"
        + (f", {report.unknown_count} could not be answered" if report.unknown_count else "")
    )

    if report.failing:
        console.print()
        console.print("[bold]What to fix first[/bold]")
        for check in report.failing[:5]:
            style = "error" if check.severity is Severity.ERROR else "warning"
            console.print(f"  [{style}]•[/{style}] {check.label} — [muted]{check.detail}[/muted]")

    console.print()
    raise typer.Exit(int(ExitCode.FINDINGS if report.status.value == "fail" else ExitCode.OK))
