"""Tests for the App Store Connect pull/push bridge.

Drives `AppStoreConnectClient` through the same `httpx.MockTransport` pattern
as `test_appstore_connect_client.py`, at the level `pull_listing`/`plan_push`
actually call it — so these prove the two are wired together correctly, not
just that each works in isolation.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from appmates.core.clients.appstore_connect import AppStoreConnectClient
from appmates.core.models.app_metadata import AppListing, AppMetadata
from appmates.core.services.asc_sync import (
    AppNotFoundError,
    NoEditableVersionError,
    NoVersionError,
    apply_push,
    plan_push,
    pull_listing,
)


def routed_client(routes: dict[str, Any], asc_key_path: Path) -> AppStoreConnectClient:
    """`routes` maps a URL-path suffix to the JSON body served for it — enough
    for these fixture-shaped flows without a full router."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        for suffix, body in routes.items():
            if path.endswith(suffix):
                return httpx.Response(200, json=body)
        raise AssertionError(f"unrouted request: {request.method} {path}")

    return AppStoreConnectClient(
        key_id="k",
        issuer_id="i",
        private_key_path=asc_key_path,
        min_interval=0.0,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


APP = {"data": [{"id": "42", "type": "apps"}]}
EDITABLE_VERSION = {
    "data": [{"id": "v1", "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"}}]
}
NO_EDITABLE_VERSION = {"data": [{"id": "v1", "attributes": {"appStoreState": "READY_FOR_SALE"}}]}
APP_INFOS = {"data": [{"id": "info1", "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"}}]}
INFO_LOCS = {
    "data": [
        {
            "id": "iloc-en",
            "attributes": {"locale": "en-US", "name": "Kaizen", "subtitle": "Build habits"},
        }
    ]
}
VERSION_LOCS = {
    "data": [
        {
            "id": "vloc-en",
            "attributes": {
                "locale": "en-US",
                "description": "Kaizen helps you build habits.",
                "promotionalText": "Start today.",
                "keywords": "habit,streak",
            },
        }
    ]
}
NO_PRICE_SCHEDULE = {"data": None}


def base_routes(**overrides: Any) -> dict[str, Any]:
    routes = {
        "/apps": APP,
        "/appInfos": APP_INFOS,
        "/appInfoLocalizations": INFO_LOCS,
        "/appStoreVersions": EDITABLE_VERSION,
        "/appStoreVersionLocalizations": VERSION_LOCS,
        "/appPriceSchedule": NO_PRICE_SCHEDULE,
    }
    routes.update(overrides)
    return routes


# --- pull --------------------------------------------------------------


def test_pull_listing_maps_asc_resources_to_app_metadata(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    pulled = pull_listing(client, "com.example.app")

    assert pulled.listing.bundle_id == "com.example.app"
    assert len(pulled.listing.locales) == 1
    meta = pulled.listing.locales[0]
    assert meta.locale == "en-US"
    assert meta.title == "Kaizen"
    assert meta.subtitle == "Build habits"
    assert meta.description == "Kaizen helps you build habits."
    assert meta.promotional_text == "Start today."
    assert meta.keywords == "habit,streak"


def test_pull_listing_raises_when_app_not_found(asc_key_path: Path) -> None:
    client = routed_client(base_routes(**{"/apps": {"data": []}}), asc_key_path)
    with pytest.raises(AppNotFoundError):
        pull_listing(client, "com.missing.app")


def test_pull_listing_falls_back_to_the_live_version(asc_key_path: Path) -> None:
    """No draft exists — pulling should still work, reading the published
    listing instead of failing outright: reading it is safe regardless."""
    client = routed_client(base_routes(**{"/appStoreVersions": NO_EDITABLE_VERSION}), asc_key_path)
    pulled = pull_listing(client, "com.example.app")

    assert pulled.is_live is True
    assert pulled.listing.locales[0].title == "Kaizen"


def test_pull_listing_is_live_false_when_a_draft_exists(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    pulled = pull_listing(client, "com.example.app")
    assert pulled.is_live is False


def test_pull_listing_raises_when_the_app_has_no_version_at_all(asc_key_path: Path) -> None:
    client = routed_client(base_routes(**{"/appStoreVersions": {"data": []}}), asc_key_path)
    with pytest.raises(NoVersionError):
        pull_listing(client, "com.example.app")


def test_pull_listing_includes_current_prices(asc_key_path: Path) -> None:
    schedule = {"data": {"id": "sched1"}}
    prices = {
        "data": [
            {
                "id": "mp1",
                "relationships": {
                    "territory": {"data": {"type": "territories", "id": "USA"}},
                    "appPricePoint": {"data": {"type": "appPricePoints", "id": "pp1"}},
                },
            }
        ],
        "included": [
            {"type": "territories", "id": "USA", "attributes": {}},
            {"type": "appPricePoints", "id": "pp1", "attributes": {"customerPrice": "4.99"}},
        ],
    }
    client = routed_client(
        base_routes(**{"/appPriceSchedule": schedule, "/manualPrices": prices}), asc_key_path
    )
    pulled = pull_listing(client, "com.example.app")
    assert pulled.current_prices == [{"territory": "USA", "price": "4.99"}]


# --- push planning -------------------------------------------------------


LOCAL_LISTING = AppListing(
    bundle_id="com.example.app",
    locales=[
        AppMetadata(
            locale="en-US",
            title="Kaizen: Habits",  # changed from "Kaizen"
            subtitle="Build habits",  # unchanged
            description="Kaizen helps you build habits.",  # unchanged
            promotional_text="Start today.",
            keywords="habit,streak,focus",  # changed
        )
    ],
)


def test_plan_push_diffs_only_changed_fields(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    plan = plan_push(client, "com.example.app", LOCAL_LISTING)

    fields_changed = {c.field for c in plan.changes}
    assert fields_changed == {"title", "keywords"}
    title_change = next(c for c in plan.changes if c.field == "title")
    assert title_change.old == "Kaizen"
    assert title_change.new == "Kaizen: Habits"


def test_plan_push_is_empty_when_nothing_changed(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    unchanged = AppListing(
        bundle_id="com.example.app",
        locales=[
            AppMetadata(
                locale="en-US",
                title="Kaizen",
                subtitle="Build habits",
                description="Kaizen helps you build habits.",
                promotional_text="Start today.",
                keywords="habit,streak",
            )
        ],
    )
    plan = plan_push(client, "com.example.app", unchanged)
    assert plan.is_empty
    assert not plan.blocked


def test_plan_push_blocks_on_error_level_findings(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    broken = AppListing(
        bundle_id="com.example.app",
        locales=[AppMetadata(locale="en-US", title="K" * 40)],  # over Apple's 30-char limit
    )
    plan = plan_push(client, "com.example.app", broken)
    assert plan.blocked
    assert plan.validation.error_count > 0


def test_plan_push_force_bypasses_the_block(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    broken = AppListing(
        bundle_id="com.example.app",
        locales=[AppMetadata(locale="en-US", title="K" * 40)],
    )
    plan = plan_push(client, "com.example.app", broken, force=True)
    assert not plan.blocked
    assert plan.changes  # still has the diff to send


def test_plan_push_raises_when_app_not_found(asc_key_path: Path) -> None:
    client = routed_client(base_routes(**{"/apps": {"data": []}}), asc_key_path)
    with pytest.raises(AppNotFoundError):
        plan_push(client, "com.missing.app", LOCAL_LISTING)


def test_plan_push_raises_when_no_editable_version(asc_key_path: Path) -> None:
    client = routed_client(base_routes(**{"/appStoreVersions": NO_EDITABLE_VERSION}), asc_key_path)
    with pytest.raises(NoEditableVersionError):
        plan_push(client, "com.example.app", LOCAL_LISTING)


def test_plan_push_skips_locales_asc_does_not_have(asc_key_path: Path) -> None:
    """A locale in the local file that isn't live yet has nothing to diff
    against — plan_push should not invent a change out of nothing."""
    client = routed_client(base_routes(), asc_key_path)
    listing = AppListing(
        bundle_id="com.example.app",
        locales=[AppMetadata(locale="de-DE", title="Kaizen", description="d" * 20)],
    )
    plan = plan_push(client, "com.example.app", listing)
    assert plan.changes == []


# --- push applying ---------------------------------------------------------


def test_apply_push_sends_only_changed_fields(asc_key_path: Path) -> None:
    sent: list[tuple[str, str, dict[str, Any]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        for suffix, body in base_routes().items():
            if path.endswith(suffix):
                return httpx.Response(200, json=body)
        if request.method == "PATCH":
            import json as _json

            payload = _json.loads(request.read())
            sent.append((path, payload["data"]["type"], payload["data"]["attributes"]))
            return httpx.Response(200, json={"data": {}})
        raise AssertionError(f"unrouted request: {request.method} {path}")

    client = AppStoreConnectClient(
        key_id="k",
        issuer_id="i",
        private_key_path=asc_key_path,
        min_interval=0.0,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    plan = plan_push(client, "com.example.app", LOCAL_LISTING)
    sent_count = apply_push(client, plan)

    assert sent_count == 2  # title (info) + keywords (version)
    kinds = {kind for _, kind, _ in sent}
    assert kinds == {"appInfoLocalizations", "appStoreVersionLocalizations"}
    info_attrs = next(attrs for _, kind, attrs in sent if kind == "appInfoLocalizations")
    assert info_attrs == {"name": "Kaizen: Habits"}
    version_attrs = next(attrs for _, kind, attrs in sent if kind == "appStoreVersionLocalizations")
    assert version_attrs == {"keywords": "habit,streak,focus"}


def test_apply_push_with_no_changes_sends_nothing(asc_key_path: Path) -> None:
    client = routed_client(base_routes(), asc_key_path)
    unchanged = AppListing(
        bundle_id="com.example.app",
        locales=[
            AppMetadata(
                locale="en-US",
                title="Kaizen",
                subtitle="Build habits",
                description="Kaizen helps you build habits.",
                promotional_text="Start today.",
                keywords="habit,streak",
            )
        ],
    )
    plan = plan_push(client, "com.example.app", unchanged)
    assert apply_push(client, plan) == 0
