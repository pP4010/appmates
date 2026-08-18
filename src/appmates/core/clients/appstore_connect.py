"""App Store Connect API client.

Talks straight to ``api.appstoreconnect.apple.com`` over HTTPS from wherever
this process runs — your machine, your CI runner. Nothing in AppMates' web
dashboard or its Cloudflare backend is in this path, ever, and this module
makes no network call to anything AppMates operates.

**Your private key never leaves this process.** It is read from disk once,
held in memory only long enough to sign a short-lived JSON Web Token (RFC
7519, ES256 per Apple's own spec:
https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests),
and is never itself transmitted, logged, cached to disk, or included in any
``--json`` output. Only the *signature* — the token — goes over the wire, as
a normal Bearer credential, exactly as it would from Apple's own `asc` CLI or
Fastlane. The token is regenerated fresh per process and kept in memory only;
nothing here ever writes a token to disk either.

Credentials come from :class:`appmates.core.config.Settings`
(``LAUNCHPILOT_APP_STORE_KEY_ID`` / ``_ISSUER_ID`` / ``_PRIVATE_KEY_PATH``,
an env var or a local, gitignored ``.env``) — never a CLI flag, so the key
path and ids never sit in shell history or a process list.
"""

from __future__ import annotations

import stat
import time
import warnings
from pathlib import Path
from typing import Any

import httpx
import jwt

from appmates.core.errors import AppMatesError

API_BASE = "https://api.appstoreconnect.apple.com/v1"
AUDIENCE = "appstoreconnect-v1"

# Apple rejects a token with a lifetime over 20 minutes; 15 leaves margin for
# clock skew between this machine and Apple's without needing a mid-run
# refresh for anything this client does in one invocation.
TOKEN_LIFETIME_SECONDS = 15 * 60

# Apple does not publish a rate limit for this API; existing integrations
# report throttling under sustained heavy use. A conservative floor between
# requests costs nothing on the small, one-shot pulls/pushes this client
# makes and avoids ever being the reason a developer's key gets flagged.
MIN_REQUEST_INTERVAL = 0.5

USER_AGENT = "appmates/0.1 (+https://github.com/pP4010/launchpilot)"


class AppStoreConnectError(AppMatesError):
    """The API could not be reached, rejected the request, or answered oddly."""


class AppStoreConnectAuthError(AppStoreConnectError):
    """The key, issuer id, or signed token was rejected — a credentials problem,
    not a transient failure. Never carries the private key itself."""


def _check_key_file_permissions(path: Path) -> None:
    """Defence in depth: warn if a `.p8` file is readable by anyone but its
    owner. Not enforced — this runs on developer laptops with all kinds of
    umask setups — but a private key sitting world-readable next to a repo
    is exactly the kind of thing worth one loud warning for."""
    try:
        mode = path.stat().st_mode
    except OSError:
        return
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        warnings.warn(
            f"{path} is readable by users other than you (mode {stat.S_IMODE(mode):o}). "
            f"This is your App Store Connect private key — consider `chmod 600 {path}`.",
            stacklevel=3,
        )


def build_token(*, key_id: str, issuer_id: str, private_key_path: Path) -> str:
    """Sign a fresh App Store Connect API bearer token.

    Reads the `.p8` file exactly once. The returned string is a signature,
    not the key — safe to hold as a normal Bearer credential for the token's
    short lifetime.
    """
    _check_key_file_permissions(private_key_path)
    try:
        private_key = private_key_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise AppStoreConnectAuthError(
            f"Could not read the App Store Connect private key at {private_key_path}: {exc}"
        ) from exc

    now = int(time.time())
    try:
        return jwt.encode(
            {"iss": issuer_id, "iat": now, "exp": now + TOKEN_LIFETIME_SECONDS, "aud": AUDIENCE},
            private_key,
            algorithm="ES256",
            headers={"kid": key_id, "typ": "JWT"},
        )
    except (ValueError, jwt.InvalidKeyError) as exc:
        raise AppStoreConnectAuthError(
            f"The private key at {private_key_path} is not a valid ES256 (.p8) key: {exc}"
        ) from exc


class AppStoreConnectClient:
    """Thin, typed wrapper over the JSON:API resources AppMates' local tools
    read from and write to. Returns parsed JSON:API bodies (`dict`) rather
    than a bespoke model layer here — `core/services/asc_sync.py` is what
    turns these into AppMates' own `AppListing`/`AppMetadata`, the same
    separation `clients/itunes.py` keeps from `market_analyzer`."""

    def __init__(
        self,
        *,
        key_id: str,
        issuer_id: str,
        private_key_path: Path,
        timeout: float = 30.0,
        min_interval: float = MIN_REQUEST_INTERVAL,
        client: httpx.Client | None = None,
    ) -> None:
        self._key_id = key_id
        self._issuer_id = issuer_id
        self._private_key_path = private_key_path
        self._timeout = timeout
        self._min_interval = min_interval
        self._client = client
        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._last_request_at: float | None = None

    def _bearer_token(self) -> str:
        # Regenerated once per process and reused until near expiry, rather
        # than per-request: a fresh signature per call buys nothing (Apple
        # only cares that the token is currently valid) and would mean
        # re-reading the key file every time.
        if self._token is None or time.time() > self._token_expires_at - 60:
            self._token = build_token(
                key_id=self._key_id,
                issuer_id=self._issuer_id,
                private_key_path=self._private_key_path,
            )
            self._token_expires_at = time.time() + TOKEN_LIFETIME_SECONDS
        return self._token

    def _throttle(self) -> None:
        if self._last_request_at is None:
            return
        remaining = self._min_interval - (time.monotonic() - self._last_request_at)
        if remaining > 0:
            time.sleep(remaining)

    def _request(
        self, method: str, path: str, *, params: dict[str, str] | None = None, json: Any = None
    ) -> dict[str, Any]:
        self._throttle()
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        headers = {
            "Authorization": f"Bearer {self._bearer_token()}",
            "User-Agent": USER_AGENT,
        }
        if json is not None:
            headers["Content-Type"] = "application/json"

        try:
            if self._client is not None:
                response = self._client.request(
                    method, url, params=params, json=json, headers=headers
                )
            else:
                response = httpx.request(
                    method,
                    url,
                    params=params,
                    json=json,
                    headers=headers,
                    timeout=self._timeout,
                )
            self._last_request_at = time.monotonic()
        except httpx.HTTPError as exc:
            raise AppStoreConnectError(f"Could not reach App Store Connect: {exc}") from exc

        if response.status_code in (401, 403):
            raise AppStoreConnectAuthError(
                f"App Store Connect rejected the request ({response.status_code}). "
                "Check the key id, issuer id and that the key has not been revoked "
                "in App Store Connect → Users and Access → Integrations."
            )
        if response.status_code == 429:
            raise AppStoreConnectError(
                "App Store Connect is rate-limiting this key. Wait a few minutes and retry."
            )
        if response.status_code >= 400:
            detail = _error_detail(response)
            raise AppStoreConnectError(
                f"App Store Connect returned {response.status_code} for {method} {path}: {detail}"
            )

        if response.status_code == 204 or not response.content:
            return {}
        try:
            result: dict[str, Any] = response.json()
        except ValueError as exc:
            raise AppStoreConnectError(
                f"App Store Connect returned an unreadable response for {method} {path}"
            ) from exc
        return result

    def _get(self, path: str, *, params: dict[str, str] | None = None) -> dict[str, Any]:
        return self._request("GET", path, params=params)

    # --- apps ---------------------------------------------------------

    def find_app(self, bundle_id: str) -> dict[str, Any] | None:
        payload = self._get("/apps", params={"filter[bundleId]": bundle_id})
        data = payload.get("data") or []
        return dict(data[0]) if data else None

    def get_app(self, app_id: str) -> dict[str, Any]:
        payload = self._get(f"/apps/{app_id}")
        return dict(payload["data"])

    # --- app info (name, subtitle) -------------------------------------

    def list_app_info_localizations(self, app_id: str) -> list[dict[str, Any]]:
        infos = self._get(f"/apps/{app_id}/appInfos").get("data") or []
        if not infos:
            return []
        # The editable ("prepare for submission") app info, when there is
        # one, is what a pull/push cares about; falling back to the first
        # entry keeps this usable for an app with only a live version.
        editable = next(
            (i for i in infos if i.get("attributes", {}).get("appStoreState") not in _LIVE_STATES),
            infos[0],
        )
        locs = self._get(f"/appInfos/{editable['id']}/appInfoLocalizations").get("data") or []
        return [dict(loc) for loc in locs]

    def update_app_info_localization(self, localization_id: str, **attributes: Any) -> None:
        self._request(
            "PATCH",
            f"/appInfoLocalizations/{localization_id}",
            json={
                "data": {
                    "type": "appInfoLocalizations",
                    "id": localization_id,
                    "attributes": attributes,
                }
            },
        )

    # --- app store version (description, keywords, promo text) --------

    def list_versions(self, app_id: str) -> list[dict[str, Any]]:
        versions = (
            self._get(f"/apps/{app_id}/appStoreVersions", params={"limit": "50"}).get("data") or []
        )
        return [dict(v) for v in versions]

    def get_editable_version(self, app_id: str) -> dict[str, Any] | None:
        """The version a write should target — anything not yet live. `None`
        when every version is already published or in Apple's hands, which
        `plan_push` treats as "nothing safe to write to"."""
        editable = next(
            (v for v in self.list_versions(app_id) if not is_live_version(v)),
            None,
        )
        return editable

    def get_latest_version(self, app_id: str) -> dict[str, Any] | None:
        """The most recent version regardless of state — including a live
        one. Only ever used for reading: App Store Connect returns versions
        most-recent-first, so the first entry is what a pull should show
        when there is nothing in draft to prefer over it."""
        versions = self.list_versions(app_id)
        return versions[0] if versions else None

    def list_version_localizations(self, version_id: str) -> list[dict[str, Any]]:
        locs = (
            self._get(f"/appStoreVersions/{version_id}/appStoreVersionLocalizations").get("data")
            or []
        )
        return [dict(loc) for loc in locs]

    def update_version_localization(self, localization_id: str, **attributes: Any) -> None:
        self._request(
            "PATCH",
            f"/appStoreVersionLocalizations/{localization_id}",
            json={
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": localization_id,
                    "attributes": attributes,
                }
            },
        )

    # --- pricing (read-only; see core/services/asc_sync.py for why) ----

    def get_current_prices(self, app_id: str) -> list[dict[str, Any]]:
        """Current per-territory prices, `[{"territory": "USA", "price": "4.99"}, ...]`.

        Read-only on purpose: writing a price schedule risks putting a real,
        live price in front of real customers on a mistake, and the API for
        it (price *schedules* referencing specific `appPricePoint` ids, not
        a plain number) has real room to get subtly wrong. `appmates
        pricing` already computes what to set; this shows what is live today
        so the two can be compared and the change made by hand in App Store
        Connect, at least until this path has been proven against more
        accounts than the one it was written against.
        """
        schedule = self._get(f"/apps/{app_id}/appPriceSchedule").get("data")
        if not schedule:
            return []
        prices = self._get(
            f"/appPriceSchedules/{schedule['id']}/manualPrices",
            params={"include": "appPricePoint,territory", "limit": "200"},
        )
        included = {(i["type"], i["id"]): i for i in prices.get("included") or []}
        out: list[dict[str, Any]] = []
        for row in prices.get("data") or []:
            rels = row.get("relationships", {})
            territory_ref = (rels.get("territory") or {}).get("data") or {}
            point_ref = (rels.get("appPricePoint") or {}).get("data") or {}
            territory = included.get(("territories", territory_ref.get("id")), {})
            point = included.get(("appPricePoints", point_ref.get("id")), {})
            out.append(
                {
                    "territory": territory.get("id"),
                    "price": (point.get("attributes") or {}).get("customerPrice"),
                }
            )
        return out


# App Store Connect's editable states, i.e. "not yet live" — anything else
# (READY_FOR_SALE, PENDING_APPLE_RELEASE, ...) is a version already
# published or in Apple's hands, which text/pricing edits here should not
# silently target.
_LIVE_STATES = frozenset({"READY_FOR_SALE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE"})


def is_live_version(version: dict[str, Any]) -> bool:
    return version.get("attributes", {}).get("appStoreState") in _LIVE_STATES


def _error_detail(response: httpx.Response) -> str:
    try:
        errors = response.json().get("errors") or []
        return (
            "; ".join(f"{e.get('title')}: {e.get('detail')}" for e in errors) or response.text[:300]
        )
    except ValueError:
        return response.text[:300]
