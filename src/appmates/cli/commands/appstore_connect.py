"""`appmates asc` — a local, key-never-leaves-your-machine bridge to the
real App Store Connect API, for the exact listing shape `validate-metadata`
and `submission-check` already model.

Every command here reads credentials from `Settings` (env vars / a local
`.env`, never a CLI flag) and talks straight to
`api.appstoreconnect.apple.com`. AppMates' web dashboard and Cloudflare
backend are never in this path — see `core/clients/appstore_connect.py` for
exactly what that guarantee covers.
"""

from __future__ import annotations

import json as json_module
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

import typer

from appmates.cli.console import ExitCode, console, emit_json, fail
from appmates.core.clients.appstore_connect import AppStoreConnectClient, AppStoreConnectError
from appmates.core.config import Settings, get_settings
from appmates.core.errors import AppMatesError
from appmates.core.services.asc_sync import apply_push, plan_push, pull_listing
from appmates.core.services.metadata_validator import load_listing
from appmates.core.services.reporting import (
    render_asc_pull,
    render_asc_push_plan,
    render_metadata,
)

asc_app = typer.Typer(
    name="asc",
    help=(
        "A local bridge to the real App Store Connect API. Your private key is read "
        "from disk, used to sign a short-lived request token, and never leaves this "
        "process — AppMates' web dashboard and servers are never in the path."
    ),
    no_args_is_help=True,
)


def _client(settings: Settings) -> AppStoreConnectClient:
    if not settings.has_apple_credentials:
        raise fail(
            "No App Store Connect credentials configured. Set "
            "LAUNCHPILOT_APP_STORE_KEY_ID, LAUNCHPILOT_APP_STORE_ISSUER_ID and "
            "LAUNCHPILOT_APP_STORE_PRIVATE_KEY_PATH (a local .env file works) — generate "
            "a key at https://appstoreconnect.apple.com/access/integrations/api. "
            "Run `appmates asc status` to check."
        )
    assert settings.app_store_key_id and settings.app_store_issuer_id
    assert settings.app_store_private_key_path
    return AppStoreConnectClient(
        key_id=settings.app_store_key_id,
        issuer_id=settings.app_store_issuer_id,
        private_key_path=settings.app_store_private_key_path,
    )


@asc_app.command("status")
def status(as_json: Annotated[bool, typer.Option("--json")] = False) -> None:
    """Check whether App Store Connect credentials are configured and accepted.

    Makes exactly one authenticated, read-only request to confirm the key
    actually works — nothing else, and never anything that writes.
    """
    settings = get_settings()
    if not settings.has_apple_credentials:
        if as_json:
            emit_json({"configured": False, "valid": None})
            raise typer.Exit(int(ExitCode.OK))
        console.print("[warning]![/warning] No App Store Connect credentials configured.")
        console.print(
            "  Set LAUNCHPILOT_APP_STORE_KEY_ID, LAUNCHPILOT_APP_STORE_ISSUER_ID and "
            "LAUNCHPILOT_APP_STORE_PRIVATE_KEY_PATH — a local .env file works."
        )
        console.print("  Generate a key: https://appstoreconnect.apple.com/access/integrations/api")
        raise typer.Exit(int(ExitCode.USAGE))

    client = _client(settings)
    try:
        # Any bundle id proves the point: a 200 (even with zero matches) means
        # the token was accepted, which is all this checks.
        client.find_app("com.appmates.credentials-check")
        valid, message = True, None
    except AppStoreConnectError as exc:
        valid, message = False, str(exc)

    if as_json:
        emit_json({"configured": True, "valid": valid, "error": message})
    elif valid:
        console.print(
            "[success]✓[/success] Credentials are configured and accepted by App Store Connect."
        )
    else:
        console.print(f"[error]✗[/error] {message}")

    raise typer.Exit(int(ExitCode.OK if valid else ExitCode.FINDINGS))


@asc_app.command("pull")
def pull(
    bundle_id: Annotated[str, typer.Argument(help="Your app's bundle id, e.g. com.example.app.")],
    out: Annotated[
        Path | None,
        typer.Option("--out", "-o", help="Write the listing JSON here instead of printing it."),
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print as JSON instead of a table.")
    ] = False,
) -> None:
    """Pull your real listing text and current prices from App Store Connect.

    Writes the same `{"locales": [...]}` shape `validate-metadata` and
    `submission-check` read from a file — and the web dashboard's
    multi-locale checker accepts pasted directly. Read-only: never writes
    anything back to App Store Connect.
    """
    settings = get_settings()
    client = _client(settings)
    try:
        pulled = pull_listing(client, bundle_id)
    except AppMatesError as exc:
        raise fail(str(exc)) from exc

    payload = {
        **pulled.listing.model_dump(mode="json"),
        "current_prices": pulled.current_prices,
        "is_live": pulled.is_live,
    }

    if out is not None:
        out.write_text(json_module.dumps(payload, indent=2), encoding="utf-8")
        note = " (live, published version — read-only)" if pulled.is_live else ""
        console.print(
            f"[success]✓[/success] Wrote {len(pulled.listing.locales)} locale(s) to {out}{note}"
        )
        raise typer.Exit(int(ExitCode.OK))

    if as_json:
        print(json_module.dumps(payload, indent=2))
    else:
        console.print(render_asc_pull(pulled))
    raise typer.Exit(int(ExitCode.OK))


@asc_app.command("push-metadata")
def push_metadata(
    bundle_id: Annotated[str, typer.Argument(help="Your app's bundle id.")],
    metadata_file: Annotated[
        Path,
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help="Local listing file — same shape validate-metadata reads.",
        ),
    ],
    yes: Annotated[
        bool,
        typer.Option(
            "--yes", help="Actually send the changes. Without this, only the diff is shown."
        ),
    ] = False,
    force: Annotated[
        bool,
        typer.Option(
            "--force", help="Push even if validate-metadata found an error. Use with care."
        ),
    ] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Push local listing text to App Store Connect. Dry run by default.

    Validates the file with the same checks `validate-metadata` runs, and
    refuses to send anything with an error-level finding unless --force is
    also given. Without --yes, only ever prints the diff — nothing is sent.
    """
    settings = get_settings()
    client = _client(settings)
    try:
        listing = load_listing(metadata_file)
        plan = plan_push(client, bundle_id, listing, force=force)
    except AppMatesError as exc:
        raise fail(str(exc)) from exc

    if plan.blocked:
        if as_json:
            emit_json(
                {
                    "blocked": True,
                    "changes": [],
                    "validation": plan.validation.model_dump(mode="json"),
                }
            )
        else:
            console.print(
                "[error]✗[/error] Refusing to push: validate-metadata found error-level issues."
            )
            console.print(render_metadata(plan.validation))
            console.print("  Fix them, or pass --force to push anyway.")
        raise typer.Exit(int(ExitCode.FINDINGS))

    if plan.is_empty:
        if as_json:
            emit_json({"blocked": False, "changes": []})
        else:
            console.print(
                "[success]✓[/success] Nothing to push — the file matches what's already live."
            )
        raise typer.Exit(int(ExitCode.OK))

    if not yes:
        if as_json:
            emit_json({"would_push": True, "changes": [asdict(c) for c in plan.changes]})
        else:
            console.print(render_asc_push_plan(plan))
            console.print(
                f"\n  [muted]{len(plan.changes)} field(s) would change. "
                "Re-run with --yes to send them.[/muted]"
            )
        raise typer.Exit(int(ExitCode.OK))

    sent = apply_push(client, plan)
    if as_json:
        emit_json({"pushed": True, "fields_sent": sent})
    else:
        console.print(f"[success]✓[/success] Pushed {sent} field(s) to App Store Connect.")
    raise typer.Exit(int(ExitCode.OK))
