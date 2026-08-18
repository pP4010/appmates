"""Bridges real App Store Connect data to AppMates' own models.

**Pull** turns the API's resources into an `AppListing` — the exact shape
`validate-metadata` and `submission-check` already read from a local file,
and the exact shape the web dashboard's multi-locale checker already accepts
pasted as JSON. Nothing new to learn on either side: real data flows
straight into tools that already exist.

**Push** is the reverse, and is deliberately more careful than pull: it
diffs the local listing against what is live in App Store Connect right
now, refuses to send anything `MetadataValidator` would flag as an error
(unless explicitly forced), and only ever writes fields that actually
changed. A caller always gets the diff before anything is sent — nothing
here sends without the caller having seen `PushPlan.changes` first.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from appmates.core.clients.appstore_connect import AppStoreConnectClient, is_live_version
from appmates.core.errors import AppMatesError
from appmates.core.models.app_metadata import AppListing, AppMetadata
from appmates.core.models.report import Store
from appmates.core.services.metadata_validator import MetadataReport, MetadataValidator


class AppNotFoundError(AppMatesError):
    def __init__(self, bundle_id: str) -> None:
        super().__init__(f"No app found in App Store Connect for bundle id {bundle_id!r}.")


class NoEditableVersionError(AppMatesError):
    """Raised only when *writing*: every version is already live or in
    Apple's hands, and pushing text to one of those is not something this
    tool will do. Reading (`pull_listing`) falls back to the live version
    instead of raising this — see `NoVersionError` for pull's own "nothing
    exists at all" case."""

    def __init__(self, app_id: str) -> None:
        super().__init__(
            f"App {app_id} has no editable version — every version is already live or in "
            "Apple's hands. Create a new version in App Store Connect first."
        )


class NoVersionError(AppMatesError):
    """The app has no version at all yet — nothing published, nothing in
    draft. Rare: only a brand-new app with its first version not yet
    created hits this."""

    def __init__(self, app_id: str) -> None:
        super().__init__(
            f"App {app_id} has no version at all yet. Create its first version in App Store "
            "Connect before pulling."
        )


@dataclass
class PulledListing:
    """What `asc pull` recovers. `current_prices` is shown alongside, never
    merged into `listing` — price is not listing text, and `appmates
    pricing` already has its own place for it."""

    listing: AppListing
    current_prices: list[dict[str, Any]] = field(default_factory=list)
    is_live: bool = False
    """True when there was no draft version to read, so this is the
    published, live listing instead — read-only in practice: `plan_push`
    refuses to write to a live version regardless of what a caller does
    with this listing afterward."""


def pull_listing(client: AppStoreConnectClient, bundle_id: str) -> PulledListing:
    """Pull the listing to check or edit.

    Prefers a draft (not-yet-live) version, since that is what a push would
    target. When an app has no draft — the common case for an app that is
    simply live with nothing new in progress — this falls back to the
    published version instead of failing outright: reading it is completely
    safe, only *writing* to it is not, and `plan_push` enforces that
    separately regardless of where this listing came from.
    """
    app = client.find_app(bundle_id)
    if app is None:
        raise AppNotFoundError(bundle_id)
    app_id = str(app["id"])

    version = client.get_editable_version(app_id)
    is_live = False
    if version is None:
        version = client.get_latest_version(app_id)
        if version is None:
            raise NoVersionError(app_id)
        is_live = is_live_version(version)

    info_locs = {
        loc["attributes"]["locale"]: loc["attributes"]
        for loc in client.list_app_info_localizations(app_id)
    }
    version_locs = client.list_version_localizations(str(version["id"]))

    locales: list[AppMetadata] = []
    for loc in version_locs:
        code = loc["attributes"]["locale"]
        info = info_locs.get(code, {})
        v = loc["attributes"]
        locales.append(
            AppMetadata(
                locale=code,
                title=info.get("name"),
                subtitle=info.get("subtitle"),
                description=v.get("description"),
                promotional_text=v.get("promotionalText"),
                keywords=v.get("keywords"),
            )
        )

    return PulledListing(
        listing=AppListing(bundle_id=bundle_id, locales=locales),
        current_prices=client.get_current_prices(app_id),
        is_live=is_live,
    )


@dataclass
class FieldChange:
    locale: str
    field: str
    old: str | None
    new: str | None


@dataclass
class PushPlan:
    """What `asc push-metadata` would do. Applying it never re-derives this
    plan — `apply_push` takes exactly this object, so what gets sent is
    provably what was shown."""

    app_id: str
    version_id: str
    changes: list[FieldChange]
    validation: MetadataReport
    blocked: bool
    """True when the listing has an error-level finding and the caller did
    not pass `force=True` — nothing in `changes` should be sent."""
    _info_localization_ids: dict[str, str] = field(default_factory=dict, repr=False)
    _version_localization_ids: dict[str, str] = field(default_factory=dict, repr=False)

    @property
    def is_empty(self) -> bool:
        return not self.changes


_INFO_FIELDS = {"title": "name", "subtitle": "subtitle"}
_VERSION_FIELDS = {
    "description": "description",
    "promotional_text": "promotionalText",
    "keywords": "keywords",
}


def plan_push(
    client: AppStoreConnectClient, bundle_id: str, listing: AppListing, *, force: bool = False
) -> PushPlan:
    app = client.find_app(bundle_id)
    if app is None:
        raise AppNotFoundError(bundle_id)
    app_id = str(app["id"])

    version = client.get_editable_version(app_id)
    if version is None:
        raise NoEditableVersionError(app_id)
    version_id = str(version["id"])

    info_locs = {
        loc["attributes"]["locale"]: loc for loc in client.list_app_info_localizations(app_id)
    }
    version_locs = {
        loc["attributes"]["locale"]: loc for loc in client.list_version_localizations(version_id)
    }

    # Apple's limits only: this is a push to App Store Connect specifically,
    # and Google's fields (short_description among them) do not exist there
    # — validating against them would block a push over a field this
    # command was never going to touch.
    validation = MetadataValidator([Store.APPLE]).validate_listing(listing)
    blocked = validation.error_count > 0 and not force

    changes: list[FieldChange] = []
    info_ids: dict[str, str] = {}
    version_ids: dict[str, str] = {}

    for meta in listing.locales:
        info = info_locs.get(meta.locale)
        if info is not None:
            info_ids[meta.locale] = str(info["id"])
            for local_field, remote_field in _INFO_FIELDS.items():
                _diff_field(changes, meta, local_field, info["attributes"].get(remote_field))

        vloc = version_locs.get(meta.locale)
        if vloc is not None:
            version_ids[meta.locale] = str(vloc["id"])
            for local_field, remote_field in _VERSION_FIELDS.items():
                _diff_field(changes, meta, local_field, vloc["attributes"].get(remote_field))

    return PushPlan(
        app_id=app_id,
        version_id=version_id,
        changes=changes,
        validation=validation,
        blocked=blocked,
        _info_localization_ids=info_ids,
        _version_localization_ids=version_ids,
    )


def _diff_field(
    changes: list[FieldChange], meta: AppMetadata, local_field: str, remote_value: str | None
) -> None:
    local_value = meta.field_value(local_field)
    if local_value is not None and local_value != (remote_value or None):
        changes.append(
            FieldChange(locale=meta.locale, field=local_field, old=remote_value, new=local_value)
        )


def apply_push(client: AppStoreConnectClient, plan: PushPlan) -> int:
    """Send exactly the changes in `plan`. Returns how many field writes
    were made. Callers must check `plan.blocked` themselves first — this
    function sends regardless, so a caller that wants the safety gate
    enforces it before calling, the same shape `fix-screenshots --force`
    already uses for "you asked for this explicitly"."""
    by_locale: dict[str, dict[str, dict[str, Any]]] = {}
    for change in plan.changes:
        bucket = by_locale.setdefault(change.locale, {"info": {}, "version": {}})
        if change.field in _INFO_FIELDS:
            bucket["info"][_INFO_FIELDS[change.field]] = change.new
        else:
            bucket["version"][_VERSION_FIELDS[change.field]] = change.new

    sent = 0
    for locale, fields_by_kind in by_locale.items():
        if fields_by_kind["info"]:
            localization_id = plan._info_localization_ids.get(locale)
            if localization_id:
                client.update_app_info_localization(localization_id, **fields_by_kind["info"])
                sent += len(fields_by_kind["info"])
        if fields_by_kind["version"]:
            localization_id = plan._version_localization_ids.get(locale)
            if localization_id:
                client.update_version_localization(localization_id, **fields_by_kind["version"])
                sent += len(fields_by_kind["version"])
    return sent
