"""Listing health for one published app.

Turns a public catalogue entry into a profile plus a set of readiness checks.
Pure over the entry: fetching lives in the client, as everywhere else.

Three limits shape what is checked, and each is surfaced rather than worked
around:

* Screenshot URLs serve a downscaled image preserving the aspect ratio but not
  the resolution, so device family is inferred and pixel size is never claimed.
* Screenshots are exposed for roughly half of apps; an empty set means the API
  withheld them.
* Subtitles and the keyword field are not public, so neither is checked here.

A check that cannot be answered is marked unanswerable rather than failed, and
excluded from the score. An app whose screenshots the catalogue happened to
withhold should not rank below one whose it happened to return.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from launchpilot.core.models.app_profile import AppHealthReport, AppProfile, HealthCheck
from launchpilot.core.models.report import Finding, Severity, Store
from launchpilot.core.specs.registry import AppHealthSpec, load_app_health_spec

_SIZE_RE = re.compile(r"/(\d+)x(\d+)[a-z]*\.(?:png|jpg|jpeg)$", re.IGNORECASE)


def _parse_date(value: Any) -> dt.date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def screenshot_ratio(url: str) -> float | None:
    """Long side over short side of the served image."""
    match = _SIZE_RE.search(url)
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if not width or not height:
        return None
    return max(width, height) / min(width, height)


def infer_device(urls: list[str], spec: AppHealthSpec) -> str | None:
    """Guess the device family a set of screenshots targets, from their ratio."""
    ratios = [r for u in urls if (r := screenshot_ratio(u)) is not None]
    if not ratios:
        return None
    observed = sum(ratios) / len(ratios)
    for device in spec.device_ratios:
        if abs(observed - device.ratio) <= spec.thresholds.ratio_tolerance:
            return device.name
    return None


def profile_from_entry(entry: dict[str, Any], spec: AppHealthSpec | None = None) -> AppProfile:
    """Build a profile from one catalogue entry."""
    spec = spec or load_app_health_spec()

    iphone = [u for u in entry.get("screenshotUrls") or [] if isinstance(u, str)]
    ipad = [u for u in entry.get("ipadScreenshotUrls") or [] if isinstance(u, str)]

    devices = [d for d in entry.get("supportedDevices", []) if isinstance(d, str)]
    supports_iphone = any("iPhone" in d or "iPod" in d for d in devices) or not devices
    supports_ipad = any("iPad" in d for d in devices)

    return AppProfile(
        track_id=int(entry["trackId"]),
        bundle_id=entry.get("bundleId"),
        name=str(entry.get("trackName") or ""),
        seller=str(entry.get("sellerName") or entry.get("artistName") or "unknown"),
        store_url=entry.get("trackViewUrl"),
        artwork=entry.get("artworkUrl512") or entry.get("artworkUrl100"),
        version=entry.get("version"),
        release_notes=entry.get("releaseNotes"),
        description=str(entry.get("description") or ""),
        released=_parse_date(entry.get("releaseDate")),
        updated=_parse_date(entry.get("currentVersionReleaseDate")),
        rating=float(entry["averageUserRating"]) if entry.get("averageUserRating") else None,
        rating_count=int(entry.get("userRatingCount") or 0),
        price=float(entry.get("price") or 0.0),
        formatted_price=entry.get("formattedPrice"),
        genres=[g for g in entry.get("genres", []) if isinstance(g, str)],
        primary_genre=entry.get("primaryGenreName"),
        content_rating=entry.get("contentAdvisoryRating"),
        minimum_os=entry.get("minimumOsVersion"),
        file_size_bytes=int(entry.get("fileSizeBytes") or 0),
        locales=[c for c in entry.get("languageCodesISO2A", []) if isinstance(c, str)],
        iphone_screenshots=iphone,
        ipad_screenshots=ipad,
        screenshots_exposed=bool(iphone or ipad),
        supports_iphone=supports_iphone,
        supports_ipad=supports_ipad,
        inferred_device=infer_device(iphone or ipad, spec),
    )


class AppHealthChecker:
    """Runs the readiness checks over a profile."""

    def __init__(self, spec: AppHealthSpec | None = None) -> None:
        self.spec = spec or load_app_health_spec()

    def _severity(self, code: str) -> Severity:
        return Severity(self.spec.findings.get(code, "warning"))

    def check(self, profile: AppProfile, *, today: dt.date | None = None) -> AppHealthReport:
        today = today or dt.date.today()
        limits = self.spec.thresholds
        checks: list[HealthCheck] = []

        def add(
            code: str,
            label: str,
            passed: bool,
            detail: str,
            *,
            fix_hint: str | None = None,
            checkable: bool = True,
        ) -> None:
            checks.append(
                HealthCheck(
                    code=code,
                    label=label,
                    passed=passed,
                    detail=detail,
                    severity=self._severity(code),
                    fix_hint=fix_hint,
                    checkable=checkable,
                )
            )

        # --- name -----------------------------------------------------------
        length = len(profile.name)
        add(
            "APP_TITLE_TOO_LONG",
            "App name within 30 characters",
            length <= limits.title_max,
            f"{length} of {limits.title_max} characters used.",
            fix_hint=f"Trim {length - limits.title_max} character(s)."
            if length > limits.title_max
            else None,
        )

        # --- description ----------------------------------------------------
        add(
            "APP_NO_DESCRIPTION",
            "Description present",
            bool(profile.description.strip()),
            f"{len(profile.description)} characters."
            if profile.description
            else "The catalogue returned no description.",
        )

        # --- screenshots ----------------------------------------------------
        if not profile.screenshots_exposed:
            add(
                "APP_SCREENSHOTS_NOT_EXPOSED",
                "Screenshots",
                False,
                "The catalogue did not return screenshot URLs for this app, so they "
                "cannot be checked here. This happens for roughly half of apps and "
                "says nothing about whether yours are correct.",
                fix_hint="Check them directly with `launchpilot validate-screenshots`.",
                checkable=False,
            )
        else:
            count = len(profile.iphone_screenshots)
            # An app that supports iPhone but exposed no iPhone screenshots has
            # almost certainly shipped them and the API withheld them, which is
            # not a defect. Only an app the device list says is iPad-only, or
            # one whose set was actually returned, can be judged here.
            iphone_answerable = count > 0 or not profile.supports_iphone
            add(
                "APP_TOO_FEW_SCREENSHOTS",
                "At least three iPhone screenshots",
                count >= limits.min_screenshots or not profile.supports_iphone,
                f"{count} exposed."
                if count
                else "The catalogue returned iPad screenshots but not iPhone ones, which "
                "it does for about half of apps. Nothing can be concluded from that.",
                fix_hint="Three is the practical floor for a listing that reads as finished."
                if iphone_answerable and count < limits.min_screenshots
                else None,
                checkable=iphone_answerable,
            )
            add(
                "APP_UNUSED_SCREENSHOT_SLOTS",
                "Using the available screenshot slots",
                count >= limits.max_screenshots,
                f"{count} of {limits.max_screenshots} slots used." if count else "Not visible.",
                fix_hint=f"{limits.max_screenshots - count} slot(s) left unused."
                if iphone_answerable and count < limits.max_screenshots
                else None,
                checkable=iphone_answerable,
            )
            add(
                "APP_SCREENSHOT_RATIO_UNKNOWN",
                "Screenshot aspect ratio recognised",
                profile.inferred_device is not None,
                f"Matches {profile.inferred_device}."
                if profile.inferred_device
                else "The aspect ratio matches no current device family.",
                fix_hint="Only the ratio is visible here — the catalogue serves a "
                "downscaled image, so the uploaded resolution cannot be checked.",
            )
            add(
                "APP_NO_IPAD_SCREENSHOTS",
                "iPad screenshots present",
                bool(profile.ipad_screenshots) or not profile.supports_ipad,
                f"{len(profile.ipad_screenshots)} exposed."
                if profile.ipad_screenshots
                else ("Not exposed." if profile.supports_ipad else "The app does not run on iPad."),
                fix_hint="Apple requires them for any app that runs on iPad."
                if profile.supports_ipad and not profile.ipad_screenshots
                else None,
                # Same asymmetry in the other direction.
                checkable=bool(profile.ipad_screenshots) or not profile.supports_ipad,
            )

        # --- freshness ------------------------------------------------------
        days = profile.days_since_update(today)
        if days is None:
            add(
                "APP_STALE",
                "Recently updated",
                False,
                "No update date in the catalogue.",
                checkable=False,
            )
        else:
            add(
                "APP_VERY_STALE" if days >= limits.stale_days_error else "APP_STALE",
                "Recently updated",
                days < limits.stale_days_warning,
                f"Last shipped {days} days ago.",
                fix_hint="Reviewers and users both read a stale date as an abandoned app."
                if days >= limits.stale_days_warning
                else None,
            )

        add(
            "APP_NO_RELEASE_NOTES",
            "Release notes written",
            len((profile.release_notes or "").strip()) >= limits.release_notes_min_length,
            f"{len(profile.release_notes or '')} characters."
            if profile.release_notes
            else "None returned.",
            fix_hint="'Bug fixes and improvements' is a wasted slot on the product page."
            if not profile.release_notes
            else None,
        )

        # --- reach ------------------------------------------------------------
        # `languageCodesISO2A` is the least reliable field the catalogue serves:
        # apps confirmed to have several App Store Connect localizations have
        # been observed reporting only English here, in every storefront and
        # both catalogue endpoints. A low count only ever indicates the field
        # under-reporting, not a real single-language listing, so it is treated
        # as unanswerable rather than scored — the same asymmetry as
        # screenshots above. A count over the threshold is still trustworthy:
        # the catalogue has no reason to fabricate extra languages.
        locale_count = len(profile.locales)
        few_locales = locale_count <= limits.few_locales
        add(
            "APP_FEW_LOCALES",
            "Localised beyond one language",
            not few_locales,
            f"The catalogue reports only {locale_count} language(s)"
            f"{': ' + ', '.join(profile.locales) if profile.locales else ''}, but this "
            "field is known to under-report real localizations, so it cannot be trusted "
            "here."
            if few_locales
            else f"{locale_count} language(s): {', '.join(profile.locales[:8])}",
            fix_hint="Check your actual localizations in App Store Connect, or view the "
            "listing on another storefront directly (e.g. apps.apple.com/fr/app/id...) "
            "— see the Markets tool."
            if few_locales
            else None,
            checkable=not few_locales,
        )

        add(
            "APP_OVER_CELLULAR_LIMIT",
            "Downloadable over cellular",
            0 < profile.file_size_bytes <= limits.cellular_download_bytes,
            f"{profile.size_mb} MB." if profile.file_size_bytes else "No size reported.",
            fix_hint=f"Over {limits.cellular_download_bytes // 1_048_576} MB needs Wi-Fi "
            "unless the user has opted in — friction at the moment they decided to install."
            if profile.file_size_bytes > limits.cellular_download_bytes
            else None,
            checkable=profile.file_size_bytes > 0,
        )

        add(
            "APP_LOW_RATINGS",
            "Enough ratings to look established",
            profile.rating_count >= limits.low_rating_count,
            f"{profile.rating_count:,} rating(s)"
            + (f" at {profile.rating:.1f}★." if profile.rating else "."),
            fix_hint="Below a hundred ratings, the listing reads as unproven."
            if profile.rating_count < limits.low_rating_count
            else None,
        )

        findings = [
            Finding(
                code=c.code,
                severity=c.severity,
                message=f"{c.label}: {c.detail}",
                store=Store.APPLE,
                fix_hint=c.fix_hint,
            )
            for c in checks
            if c.checkable and not c.passed
        ]

        return AppHealthReport(
            profile=profile, checks=checks, findings=findings, evaluated_on=today
        )
