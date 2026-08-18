"""App Store Connect client tests.

No real requests: httpx is driven through a MockTransport, matching
`test_itunes_client.py`. The private key is a throwaway ES256 keypair
generated per test run — never a value that resembles a real Apple key.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from appmates.core.clients.appstore_connect import (
    AppStoreConnectAuthError,
    AppStoreConnectClient,
    AppStoreConnectError,
    build_token,
)


def transport(handler: Any) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def make_client(handler: Any, asc_key_path: Path, **kwargs: Any) -> AppStoreConnectClient:
    kwargs.setdefault("min_interval", 0.0)
    kwargs.setdefault("client", httpx.Client(transport=transport(handler)))
    return AppStoreConnectClient(
        key_id="TEST123", issuer_id="issuer-id", private_key_path=asc_key_path, **kwargs
    )


# --- token signing ---------------------------------------------------------


def test_build_token_is_a_valid_es256_jwt(asc_key_path: Path) -> None:
    token = build_token(key_id="TEST123", issuer_id="issuer-id", private_key_path=asc_key_path)
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256"
    assert header["kid"] == "TEST123"

    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["iss"] == "issuer-id"
    assert claims["aud"] == "appstoreconnect-v1"
    assert claims["exp"] > claims["iat"]
    assert claims["exp"] - claims["iat"] <= 20 * 60


def test_build_token_missing_key_file_raises(tmp_path: Path) -> None:
    with pytest.raises(AppStoreConnectAuthError, match="Could not read"):
        build_token(key_id="k", issuer_id="i", private_key_path=tmp_path / "missing.p8")


def test_build_token_invalid_key_contents_raises(tmp_path: Path) -> None:
    bad = tmp_path / "bad.p8"
    bad.write_text("not a key", encoding="utf-8")
    with pytest.raises(AppStoreConnectAuthError, match="not a valid"):
        build_token(key_id="k", issuer_id="i", private_key_path=bad)


def test_world_readable_key_warns(tmp_path: Path) -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    path = tmp_path / "open.p8"
    path.write_bytes(pem)
    path.chmod(0o644)  # world-readable

    with pytest.warns(UserWarning, match="readable by users other than you"):
        build_token(key_id="k", issuer_id="i", private_key_path=path)


def test_token_is_reused_until_near_expiry(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, json={"data": []}), asc_key_path)
    first = client._bearer_token()
    second = client._bearer_token()
    assert first == second


# --- requests ----------------------------------------------------------


def test_find_app_sends_bundle_id_filter(asc_key_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"type": "apps", "id": "42"}]})

    client = make_client(handler, asc_key_path)
    app = client.find_app("com.example.app")

    assert app == {"type": "apps", "id": "42"}
    assert "filter%5BbundleId%5D=com.example.app" in captured["url"]
    assert captured["auth"].startswith("Bearer ")


def test_find_app_returns_none_when_empty(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, json={"data": []}), asc_key_path)
    assert client.find_app("com.nothing.here") is None


def test_401_raises_auth_error(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(401, json={"errors": []}), asc_key_path)
    with pytest.raises(AppStoreConnectAuthError):
        client.find_app("com.example.app")


def test_403_raises_auth_error(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(403, json={"errors": []}), asc_key_path)
    with pytest.raises(AppStoreConnectAuthError):
        client.find_app("com.example.app")


def test_429_raises_rate_limit_error(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(429, json={}), asc_key_path)
    with pytest.raises(AppStoreConnectError, match="rate-limiting"):
        client.find_app("com.example.app")


def test_other_4xx_includes_apple_error_detail(asc_key_path: Path) -> None:
    body = {"errors": [{"title": "Bad Request", "detail": "Invalid filter"}]}
    client = make_client(lambda r: httpx.Response(400, json=body), asc_key_path)
    with pytest.raises(AppStoreConnectError, match="Invalid filter"):
        client.find_app("com.example.app")


def test_network_error_is_translated(asc_key_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = make_client(handler, asc_key_path)
    with pytest.raises(AppStoreConnectError, match="Could not reach"):
        client.find_app("com.example.app")


def test_get_app_unwraps_data(asc_key_path: Path) -> None:
    client = make_client(
        lambda r: httpx.Response(
            200, json={"data": {"id": "42", "attributes": {"name": "Kaizen"}}}
        ),
        asc_key_path,
    )
    assert client.get_app("42")["attributes"]["name"] == "Kaizen"


# --- localizations -------------------------------------------------------


def test_list_app_info_localizations_prefers_editable_info(asc_key_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/appInfos"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "live", "attributes": {"appStoreState": "READY_FOR_SALE"}},
                        {
                            "id": "editable",
                            "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"},
                        },
                    ]
                },
            )
        assert "/appInfos/editable/appInfoLocalizations" in path
        return httpx.Response(
            200,
            json={"data": [{"id": "loc1", "attributes": {"locale": "en-US", "name": "Kaizen"}}]},
        )

    client = make_client(handler, asc_key_path)
    locs = client.list_app_info_localizations("42")
    assert locs[0]["attributes"]["name"] == "Kaizen"


def test_get_editable_version_skips_live_states(asc_key_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "v1", "attributes": {"appStoreState": "READY_FOR_SALE"}},
                    {"id": "v2", "attributes": {"appStoreState": "PREPARE_FOR_SUBMISSION"}},
                ]
            },
        )

    client = make_client(handler, asc_key_path)
    version = client.get_editable_version("42")
    assert version is not None
    assert version["id"] == "v2"


def test_get_editable_version_returns_none_when_all_live(asc_key_path: Path) -> None:
    client = make_client(
        lambda r: httpx.Response(
            200, json={"data": [{"id": "v1", "attributes": {"appStoreState": "READY_FOR_SALE"}}]}
        ),
        asc_key_path,
    )
    assert client.get_editable_version("42") is None


def test_get_latest_version_returns_a_live_version_when_thats_all_there_is(
    asc_key_path: Path,
) -> None:
    client = make_client(
        lambda r: httpx.Response(
            200, json={"data": [{"id": "v1", "attributes": {"appStoreState": "READY_FOR_SALE"}}]}
        ),
        asc_key_path,
    )
    version = client.get_latest_version("42")
    assert version is not None
    assert version["id"] == "v1"


def test_get_latest_version_returns_none_when_no_versions_exist(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, json={"data": []}), asc_key_path)
    assert client.get_latest_version("42") is None


def test_update_version_localization_sends_patch(asc_key_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["body"] = request.read()
        return httpx.Response(200, json={"data": {}})

    client = make_client(handler, asc_key_path)
    client.update_version_localization("loc1", description="New description")

    assert captured["method"] == "PATCH"
    assert b"New description" in captured["body"]
    assert b"appStoreVersionLocalizations" in captured["body"]


# --- pricing ---------------------------------------------------------------


def test_get_current_prices_resolves_included_resources(asc_key_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/appPriceSchedule"):
            return httpx.Response(200, json={"data": {"id": "sched1"}})
        assert "/appPriceSchedules/sched1/manualPrices" in path
        return httpx.Response(
            200,
            json={
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
                    {
                        "type": "appPricePoints",
                        "id": "pp1",
                        "attributes": {"customerPrice": "4.99"},
                    },
                ],
            },
        )

    client = make_client(handler, asc_key_path)
    prices = client.get_current_prices("42")
    assert prices == [{"territory": "USA", "price": "4.99"}]


def test_get_current_prices_returns_empty_when_no_schedule(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, json={"data": None}), asc_key_path)
    assert client.get_current_prices("42") == []


# --- edge cases ------------------------------------------------------------


def test_list_app_info_localizations_returns_empty_when_no_infos(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, json={"data": []}), asc_key_path)
    assert client.list_app_info_localizations("42") == []


def test_list_version_localizations(asc_key_path: Path) -> None:
    client = make_client(
        lambda r: httpx.Response(
            200, json={"data": [{"id": "loc1", "attributes": {"locale": "fr-FR"}}]}
        ),
        asc_key_path,
    )
    locs = client.list_version_localizations("v2")
    assert locs[0]["attributes"]["locale"] == "fr-FR"


def test_update_app_info_localization_sends_patch(asc_key_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["body"] = request.read()
        return httpx.Response(200, json={"data": {}})

    client = make_client(handler, asc_key_path)
    client.update_app_info_localization("loc1", subtitle="Build daily routines")

    assert captured["method"] == "PATCH"
    assert b"Build daily routines" in captured["body"]
    assert b"appInfoLocalizations" in captured["body"]


def test_204_response_returns_empty_dict(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(204), asc_key_path)
    assert client._get("/apps/42") == {}


def test_unreadable_json_body_raises(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(200, text="not json"), asc_key_path)
    with pytest.raises(AppStoreConnectError, match="unreadable response"):
        client._get("/apps/42")


def test_error_detail_falls_back_to_raw_text_on_non_json_body(asc_key_path: Path) -> None:
    client = make_client(lambda r: httpx.Response(400, text="plain text error"), asc_key_path)
    with pytest.raises(AppStoreConnectError, match="plain text error"):
        client.find_app("com.example.app")
