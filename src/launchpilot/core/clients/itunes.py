"""Public App Store catalogue client.

Apple's iTunes Search endpoint is public, documented and needs no credentials,
which is the whole reason the niche analysis can work for everyone rather than
only for developers who already run Apple Search Ads campaigns.

It is also somebody else's free service, so this client is deliberately polite:
responses are cached on disk, requests are spaced by a minimum interval, and the
default page size is the one that answers the question rather than the maximum
the API allows.

Network access lives here and nowhere else. :mod:`market_analyzer` scores
snapshots it is handed, so the entire scoring path is testable offline.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import time
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import httpx

from launchpilot.core.errors import LaunchPilotError

SEARCH_URL = "https://itunes.apple.com/search"
LOOKUP_URL = "https://itunes.apple.com/lookup"

# Apple does not publish a rate limit for this endpoint; ~20 requests/minute is
# the community-understood ceiling. Stay well under it.
MIN_REQUEST_INTERVAL = 3.0

DEFAULT_CACHE_TTL = dt.timedelta(hours=12)

USER_AGENT = "launchpilot/0.1 (+https://github.com/pP4010/launchpilot)"


class MarketDataError(LaunchPilotError):
    """The catalogue could not be reached or returned something unusable."""


@runtime_checkable
class MarketDataSource(Protocol):
    """Where competitor listings come from.

    Implemented by :class:`ITunesSearchClient` today and by recorded fixtures in
    the tests. Keeping this a Protocol is what lets the analyser be exercised
    without touching the network.
    """

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        """Return ``(result_count, raw_entries)`` for a search term."""
        ...

    def lookup(self, app_id: str, *, country: str) -> dict[str, Any] | None:
        """Return one app's catalogue entry, by numeric track id or bundle id."""
        ...


class ResponseCache:
    """Small on-disk cache keyed by the request parameters.

    Re-running an analysis while tuning weights is the common case, and it should
    not re-hit Apple each time.
    """

    def __init__(self, directory: Path, ttl: dt.timedelta = DEFAULT_CACHE_TTL) -> None:
        self.directory = directory
        self.ttl = ttl

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
        return self.directory / f"{digest}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        path = self._path(key)
        if not path.is_file():
            return None
        age = dt.datetime.now(dt.UTC) - dt.datetime.fromtimestamp(path.stat().st_mtime, dt.UTC)
        if age > self.ttl:
            return None
        try:
            data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data

    def set(self, key: str, payload: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        # A cache that cannot write is a slow cache, not a broken program.
        with contextlib.suppress(OSError):
            self._path(key).write_text(json.dumps(payload), encoding="utf-8")


class ITunesSearchClient:
    """Reads the public App Store catalogue over HTTP."""

    def __init__(
        self,
        *,
        cache: ResponseCache | None = None,
        timeout: float = 15.0,
        min_interval: float = MIN_REQUEST_INTERVAL,
        client: httpx.Client | None = None,
    ) -> None:
        self._cache = cache
        self._timeout = timeout
        self._min_interval = min_interval
        self._client = client
        self._last_request_at: float | None = None

    def _throttle(self) -> None:
        if self._last_request_at is None:
            return
        elapsed = time.monotonic() - self._last_request_at
        remaining = self._min_interval - elapsed
        if remaining > 0:
            time.sleep(remaining)

    def _get(self, url: str, params: dict[str, str], *, subject: str) -> dict[str, Any]:
        """One cached, throttled GET with catalogue errors translated.

        ``subject`` only appears in error messages, so a failure names the term
        or app the user asked about rather than a URL.
        """
        cache_key = json.dumps({"url": url, **params}, sort_keys=True)

        if self._cache is not None:
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached

        self._throttle()
        try:
            if self._client is not None:
                response = self._client.get(url, params=params)
            else:
                headers = {"User-Agent": USER_AGENT}
                response = httpx.get(url, params=params, timeout=self._timeout, headers=headers)
            self._last_request_at = time.monotonic()
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise MarketDataError(
                f"App Store catalogue returned {exc.response.status_code} for {subject!r}. "
                "This endpoint rate-limits; wait a minute and retry."
            ) from exc
        except httpx.HTTPError as exc:
            raise MarketDataError(f"Could not reach the App Store catalogue: {exc}") from exc

        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            # The endpoint answers rate-limited requests with a non-JSON body.
            raise MarketDataError(
                f"App Store catalogue returned a non-JSON response for {subject!r}. "
                "This usually means rate limiting; wait a minute and retry."
            ) from exc

        if self._cache is not None:
            self._cache.set(cache_key, payload)
        return payload

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        payload = self._get(
            SEARCH_URL,
            {
                "term": term,
                "country": country.lower(),
                "entity": "software",
                "limit": str(limit),
            },
            subject=term,
        )
        return int(payload.get("resultCount", 0)), list(payload.get("results", []))

    def lookup(self, app_id: str, *, country: str) -> dict[str, Any] | None:
        """Fetch one app by numeric track id or by bundle id.

        The endpoint takes different parameter names for the two, and returns an
        empty result set rather than a 404 when nothing matches.

        ``country`` is omitted for numeric ids, matching the browser client. A
        track id already identifies one app across every storefront, and the
        parameter only varies pricing fields nothing here reads — but combining
        the two makes Apple drop its CORS headers, which breaks the web build.
        Keeping the request shapes identical keeps the two clients honest.
        """
        params = (
            {"id": app_id} if app_id.isdigit() else {"bundleId": app_id, "country": country.lower()}
        )
        payload = self._get(LOOKUP_URL, params, subject=app_id)
        results = payload.get("results") or []
        return dict(results[0]) if results else None


def default_cache_dir() -> Path:
    return Path.home() / ".cache" / "launchpilot" / "itunes"
