"""iTunes catalogue client tests.

No real requests: httpx is driven through a MockTransport, so the caching,
throttling and error-translation logic is exercised deterministically and the
suite never depends on Apple being reachable.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from launchpilot.core.clients.itunes import (
    SEARCH_URL,
    ITunesSearchClient,
    MarketDataError,
    ResponseCache,
    default_cache_dir,
)

PAYLOAD = {
    "resultCount": 2,
    "results": [
        {"trackId": 1, "trackName": "One"},
        {"trackId": 2, "trackName": "Two"},
    ],
}


def transport(
    handler: Any = None, *, status: int = 200, body: Any = PAYLOAD, text: str | None = None
) -> httpx.MockTransport:
    def default(request: httpx.Request) -> httpx.Response:
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler or default)


def client(**kwargs: Any) -> ITunesSearchClient:
    kwargs.setdefault("min_interval", 0.0)
    kwargs.setdefault("client", httpx.Client(transport=transport()))
    return ITunesSearchClient(**kwargs)


# --- requests ------------------------------------------------------------


def test_search_returns_count_and_entries() -> None:
    count, entries = client().search("habit tracker", country="us", limit=50)
    assert count == 2
    assert [e["trackName"] for e in entries] == ["One", "Two"]


def test_search_sends_the_expected_query() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        seen["url"] = str(request.url).split("?")[0]
        return httpx.Response(200, json=PAYLOAD)

    ITunesSearchClient(client=httpx.Client(transport=transport(handler)), min_interval=0.0).search(
        "habit tracker", country="FR", limit=25
    )

    assert seen["url"] == SEARCH_URL
    assert seen["term"] == "habit tracker"
    assert seen["country"] == "fr"  # lowercased for the API
    assert seen["entity"] == "software"
    assert seen["limit"] == "25"


# --- error translation ---------------------------------------------------


def test_an_http_error_becomes_a_domain_error_mentioning_rate_limits() -> None:
    c = ITunesSearchClient(client=httpx.Client(transport=transport(status=403)), min_interval=0.0)
    with pytest.raises(MarketDataError, match="rate-limit"):
        c.search("x", country="us", limit=10)


def test_a_transport_failure_becomes_a_domain_error() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    c = ITunesSearchClient(client=httpx.Client(transport=transport(boom)), min_interval=0.0)
    with pytest.raises(MarketDataError, match="Could not reach"):
        c.search("x", country="us", limit=10)


def test_a_non_json_body_is_reported_as_rate_limiting() -> None:
    """The endpoint answers throttled requests with an HTML body and a 200."""
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text="<html>Too many requests</html>")),
        min_interval=0.0,
    )
    with pytest.raises(MarketDataError, match="rate limiting"):
        c.search("x", country="us", limit=10)


# --- caching -------------------------------------------------------------


def test_a_cached_response_is_reused_without_a_second_request(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=PAYLOAD)

    cache = ResponseCache(tmp_path)
    for _ in range(3):
        ITunesSearchClient(
            cache=cache, client=httpx.Client(transport=transport(handler)), min_interval=0.0
        ).search("x", country="us", limit=10)

    assert calls == 1


def test_different_parameters_are_cached_separately(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=PAYLOAD)

    cache = ResponseCache(tmp_path)
    c = ITunesSearchClient(
        cache=cache, client=httpx.Client(transport=transport(handler)), min_interval=0.0
    )
    c.search("x", country="us", limit=10)
    c.search("x", country="fr", limit=10)
    c.search("y", country="us", limit=10)

    assert calls == 3


def test_an_expired_entry_is_refetched(tmp_path: Path) -> None:
    cache = ResponseCache(tmp_path, ttl=dt.timedelta(seconds=0))
    cache.set("key", PAYLOAD)
    assert cache.get("key") is None


def test_a_missing_entry_returns_none(tmp_path: Path) -> None:
    assert ResponseCache(tmp_path).get("never written") is None


def test_a_corrupt_cache_entry_is_ignored_rather_than_raising(tmp_path: Path) -> None:
    cache = ResponseCache(tmp_path)
    cache.set("key", PAYLOAD)
    next(tmp_path.glob("*.json")).write_text("{ not json", encoding="utf-8")
    assert cache.get("key") is None


def test_an_unwritable_cache_degrades_to_no_cache(tmp_path: Path) -> None:
    """A cache that cannot write is a slow cache, not a broken program."""
    directory = tmp_path / "readonly"
    directory.mkdir()
    cache = ResponseCache(directory)
    directory.chmod(0o500)
    try:
        cache.set("key", PAYLOAD)  # must not raise
        assert cache.get("key") is None
    finally:
        directory.chmod(0o700)


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_search_still_works_when_the_cache_cannot_be_written(tmp_path: Path) -> None:
    directory = tmp_path / "ro"
    directory.mkdir()
    directory.chmod(0o500)
    try:
        count, _ = ITunesSearchClient(
            cache=ResponseCache(directory),
            client=httpx.Client(transport=transport()),
            min_interval=0.0,
        ).search("x", country="us", limit=10)
        assert count == 2
    finally:
        directory.chmod(0o700)


def test_cache_round_trips_a_payload(tmp_path: Path) -> None:
    cache = ResponseCache(tmp_path)
    cache.set("key", PAYLOAD)
    assert cache.get("key") == PAYLOAD


# --- throttling ----------------------------------------------------------


def test_consecutive_requests_are_spaced_apart() -> None:
    """Apple gives this endpoint away for free; do not hammer it."""
    c = ITunesSearchClient(client=httpx.Client(transport=transport()), min_interval=0.25)
    started = time.monotonic()
    c.search("a", country="us", limit=10)
    c.search("b", country="us", limit=10)
    assert time.monotonic() - started >= 0.25


def test_the_first_request_is_not_delayed() -> None:
    c = ITunesSearchClient(client=httpx.Client(transport=transport()), min_interval=5.0)
    started = time.monotonic()
    c.search("a", country="us", limit=10)
    assert time.monotonic() - started < 1.0


# --- misc ----------------------------------------------------------------


def test_default_cache_dir_is_under_the_user_cache_home() -> None:
    path = default_cache_dir()
    assert path.is_absolute()
    assert "launchpilot" in path.parts


def test_a_response_without_the_expected_keys_yields_empty_results() -> None:
    c = ITunesSearchClient(client=httpx.Client(transport=transport(body={})), min_interval=0.0)
    assert c.search("x", country="us", limit=10) == (0, [])


def test_cache_keys_are_stable_across_processes(tmp_path: Path) -> None:
    """The key is derived from the params, not from dict ordering."""
    cache = ResponseCache(tmp_path)
    cache.set(json.dumps({"a": 1, "b": 2}, sort_keys=True), PAYLOAD)
    assert cache.get(json.dumps({"b": 2, "a": 1}, sort_keys=True)) == PAYLOAD


# --- page-screenshot fallback ---------------------------------------------

_SERVER_DATA = {
    "data": [
        {
            "data": {
                "shelfMapping": {
                    "product_media_phone_": {
                        "items": [
                            {
                                "screenshot": {
                                    "template": "https://is1-ssl.mzstatic.com/x/Page1.jpg/{w}x{h}{c}.{f}",
                                    "width": 1242,
                                    "height": 2688,
                                }
                            },
                            {
                                "screenshot": {
                                    "template": "https://is1-ssl.mzstatic.com/x/Page2.jpg/{w}x{h}{c}.{f}",
                                    "width": 1242,
                                    "height": 2688,
                                }
                            },
                        ]
                    },
                    "product_media_pad_": {
                        "items": [
                            {
                                "screenshot": {
                                    "template": "https://is1-ssl.mzstatic.com/x/Pad1.jpg/{w}x{h}{c}.{f}",
                                    "width": 2048,
                                    "height": 2732,
                                }
                            }
                        ]
                    },
                }
            }
        }
    ]
}


def _page_html(server_data: dict[str, Any] | None) -> str:
    blob = json.dumps(server_data) if server_data is not None else "not json"
    script = f'<script type="application/json" id="serialized-server-data">{blob}</script>'
    return f"<html><head>{script}</head><body></body></html>"


def test_page_screenshots_are_extracted_from_the_embedded_blob() -> None:
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text=_page_html(_SERVER_DATA))), min_interval=0.0
    )
    result = c.fetch_page_screenshots(123, country="us")
    assert result == {
        "iphone": [
            "https://is1-ssl.mzstatic.com/x/Page1.jpg/1242x2688bb.jpg",
            "https://is1-ssl.mzstatic.com/x/Page2.jpg/1242x2688bb.jpg",
        ],
        "ipad": ["https://is1-ssl.mzstatic.com/x/Pad1.jpg/2048x2732bb.jpg"],
    }


def test_page_screenshots_are_none_when_the_blob_is_missing() -> None:
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text="<html><body>nope</body></html>")),
        min_interval=0.0,
    )
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_are_none_when_the_blob_is_not_json() -> None:
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text=_page_html(None))), min_interval=0.0
    )
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_are_none_on_an_unexpected_shape() -> None:
    """Apple's internal structure is free to change; a mismatch degrades to
    "nothing found" rather than raising."""
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text=_page_html({"data": []}))), min_interval=0.0
    )
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_are_none_on_a_request_failure() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    c = ITunesSearchClient(client=httpx.Client(transport=transport(boom)), min_interval=0.0)
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_are_none_on_an_http_error_status() -> None:
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(status=404, text="not found")), min_interval=0.0
    )
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_are_cached(tmp_path: Path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, text=_page_html(_SERVER_DATA))

    cache = ResponseCache(tmp_path)
    for _ in range(3):
        ITunesSearchClient(
            cache=cache, client=httpx.Client(transport=transport(handler)), min_interval=0.0
        ).fetch_page_screenshots(123, country="us")

    assert calls == 1


def test_page_screenshots_are_none_when_both_shelves_are_empty() -> None:
    empty = {
        "data": [
            {
                "data": {
                    "shelfMapping": {
                        "product_media_phone_": {"items": []},
                        "product_media_pad_": {"items": []},
                    }
                }
            }
        ]
    }
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text=_page_html(empty))), min_interval=0.0
    )
    assert c.fetch_page_screenshots(123, country="us") is None


def test_page_screenshots_skip_items_missing_dimensions() -> None:
    partial = {
        "data": [
            {
                "data": {
                    "shelfMapping": {
                        "product_media_phone_": {
                            "items": [
                                {"screenshot": {"template": "https://x/{w}x{h}{c}.{f}"}},
                                {
                                    "screenshot": {
                                        "template": "https://x/Page.jpg/{w}x{h}{c}.{f}",
                                        "width": 1242,
                                        "height": 2688,
                                    }
                                },
                            ]
                        },
                        "product_media_pad_": {"items": []},
                    }
                }
            }
        ]
    }
    c = ITunesSearchClient(
        client=httpx.Client(transport=transport(text=_page_html(partial))), min_interval=0.0
    )
    result = c.fetch_page_screenshots(123, country="us")
    assert result == {"iphone": ["https://x/Page.jpg/1242x2688bb.jpg"], "ipad": []}


def test_page_screenshots_follow_the_redirect_to_the_slugged_url() -> None:
    """Apple 301s the bare `/app/id{id}` URL to a slugged canonical one.

    A client that does not follow it gets a redirect body instead of the
    page — the real bug this guards against.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == "https://apps.apple.com/us/app/id123":
            return httpx.Response(
                301, headers={"location": "https://apps.apple.com/us/app/kaizen/id123"}
            )
        return httpx.Response(200, text=_page_html(_SERVER_DATA))

    c = ITunesSearchClient(client=httpx.Client(transport=transport(handler)), min_interval=0.0)
    assert c.fetch_page_screenshots(123, country="us") is not None


def test_page_screenshots_use_the_app_page_url() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, text=_page_html(_SERVER_DATA))

    ITunesSearchClient(
        client=httpx.Client(transport=transport(handler)), min_interval=0.0
    ).fetch_page_screenshots(6768688178, country="FR")

    assert seen["url"] == "https://apps.apple.com/fr/app/id6768688178"
