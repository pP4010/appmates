"""`appmates pricing` — suggested per-territory prices from one base price."""

from __future__ import annotations

from typing import Annotated

import typer

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.services.pricing_calculator import suggest_prices
from appmates.core.services.reporting import render_pricing


def pricing(
    base_price: Annotated[
        float, typer.Argument(help="Your price in the base storefront, e.g. 4.99.")
    ],
    base_country: Annotated[
        str, typer.Option("--base-country", help="Storefront the base price is set in.")
    ] = "us",
    model: Annotated[
        str, typer.Option("--model", "-m", help="Pricing model: uniform or ppp_tier.")
    ] = "ppp_tier",
    countries: Annotated[
        str | None,
        typer.Option(
            "--countries", help="Comma-separated storefronts. Defaults to the built-in list."
        ),
    ] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Suggest a starting price per storefront from one base price.

    A read-only sanity check, not a push to any store: copy the numbers you
    want into App Store Connect or Play Console yourself.

    [bold]--model uniform[/bold] reprints the same price everywhere, for
    comparison. [bold]--model ppp_tier[/bold] (the default) scales it down in
    lower-income storefronts using coarse World Bank income-group bands —
    an approximation, not exact purchasing-power data.
    """
    codes = [c.strip().lower() for c in countries.split(",") if c.strip()] if countries else None

    try:
        plan = suggest_prices(base_price, base_country=base_country, model=model, countries=codes)
    except ValueError as exc:
        raise fail(str(exc)) from exc

    if as_json:
        emit_json(plan)
    else:
        console.print(render_pricing(plan))

    raise typer.Exit(int(ExitCode.OK))
