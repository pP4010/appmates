"""Store listing text validation.

Length limits differ per store, so the same listing can pass one and fail the
other. Apple additionally counts keywords as a single comma-separated field,
which is where most keyword overruns come from.
"""

from __future__ import annotations

import json
import tomllib
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from launchpilot.core.errors import MetadataParseError
from launchpilot.core.models.app_metadata import LIMITS, AppListing, AppMetadata
from launchpilot.core.models.report import Finding, Severity, Status, Store, status_of


class LocaleReport(BaseModel):
    locale: str
    findings: list[Finding] = Field(default_factory=list)

    @property
    def status(self) -> Status:
        return status_of(self.findings)


class MetadataReport(BaseModel):
    source: Path | None = None
    stores: list[Store] = Field(default_factory=list)
    locales: list[LocaleReport] = Field(default_factory=list)

    @property
    def all_findings(self) -> list[Finding]:
        return [f for locale in self.locales for f in locale.findings]

    @property
    def error_count(self) -> int:
        return sum(1 for f in self.all_findings if f.severity is Severity.ERROR)

    @property
    def warning_count(self) -> int:
        return sum(1 for f in self.all_findings if f.severity is Severity.WARNING)

    @property
    def status(self) -> Status:
        return status_of(self.all_findings)

    def is_ok(self, *, strict: bool = False) -> bool:
        if self.error_count:
            return False
        return not (strict and self.warning_count)


class MetadataValidator:
    """Checks listing text against each store's field limits."""

    # Warn once a field passes this share of its limit: translations routinely
    # run 20-30% longer than English, so a field at 95% will overflow on
    # localisation even though it fits today.
    NEAR_LIMIT_RATIO = 0.9

    def __init__(self, stores: Iterable[Store] | None = None) -> None:
        self.stores = list(stores) if stores else [Store.APPLE, Store.GOOGLE]

    def validate_listing(self, listing: AppListing) -> MetadataReport:
        return MetadataReport(
            stores=self.stores,
            locales=[self.validate_locale(loc) for loc in listing.locales],
        )

    def validate_locale(self, meta: AppMetadata) -> LocaleReport:
        report = LocaleReport(locale=meta.locale)
        for store in self.stores:
            report.findings.extend(self._check_store(meta, store))
        return report

    def _check_store(self, meta: AppMetadata, store: Store) -> Iterable[Finding]:
        prefix = store.value.upper()

        for key, limit in LIMITS[store].items():
            value = meta.field_value(key)

            if value is None or not value.strip():
                if limit.required:
                    yield Finding(
                        code=f"{prefix}_MISSING_{key.upper()}",
                        severity=Severity.ERROR,
                        store=store,
                        message=f"{limit.name} is required but empty ({meta.locale}).",
                    )
                continue

            length = len(value)
            if length > limit.max_length:
                yield Finding(
                    code=f"{prefix}_{key.upper()}_TOO_LONG",
                    severity=Severity.ERROR,
                    store=store,
                    message=(
                        f"{limit.name} is {length} characters, {length - limit.max_length} "
                        f"over the {limit.max_length} limit ({meta.locale})."
                    ),
                    fix_hint=f"Trim to {limit.max_length} characters.",
                )
            elif length > limit.max_length * self.NEAR_LIMIT_RATIO:
                yield Finding(
                    code=f"{prefix}_{key.upper()}_NEAR_LIMIT",
                    severity=Severity.WARNING,
                    store=store,
                    message=(
                        f"{limit.name} uses {length}/{limit.max_length} characters "
                        f"({meta.locale}). Translations usually run longer."
                    ),
                )

        if store is Store.APPLE and meta.keywords:
            yield from self._check_apple_keywords(meta)

    def _check_apple_keywords(self, meta: AppMetadata) -> Iterable[Finding]:
        raw = meta.keywords or ""
        # Apple counts the separators too, so spaces after commas are wasted
        # characters out of a 100-character budget.
        if ", " in raw:
            wasted = raw.count(", ")
            yield Finding(
                code="APPLE_KEYWORDS_SPACING",
                severity=Severity.WARNING,
                store=Store.APPLE,
                message=(
                    f"Keywords contain {wasted} space(s) after commas, wasting {wasted} of "
                    "the 100-character budget."
                ),
                fix_hint="Separate keywords with commas only: 'fitness,habit,tracker'.",
            )

        terms = [t.strip().lower() for t in raw.split(",") if t.strip()]
        duplicates = {t for t in terms if terms.count(t) > 1}
        if duplicates:
            yield Finding(
                code="APPLE_KEYWORDS_DUPLICATE",
                severity=Severity.WARNING,
                store=Store.APPLE,
                message=f"Duplicate keywords: {', '.join(sorted(duplicates))}.",
                fix_hint="Remove duplicates; Apple indexes each term once.",
            )

        title_words = {w.lower().strip(",.!?") for w in (meta.title or "").split()}
        overlap = title_words & set(terms)
        if overlap:
            yield Finding(
                code="APPLE_KEYWORDS_REDUNDANT",
                severity=Severity.INFO,
                store=Store.APPLE,
                message=(
                    f"Keywords repeat words already in the title: {', '.join(sorted(overlap))}."
                ),
                fix_hint="The title is already indexed; reuse the space for other terms.",
            )


def load_listing(path: Path) -> AppListing:
    """Read a listing from TOML or JSON.

    Accepts either a full ``{locales: [...]}`` document or a bare single-locale
    mapping, so a quick one-off check does not require ceremony.
    """
    if not path.is_file():
        raise MetadataParseError(f"Metadata file not found: {path}")

    text = path.read_text(encoding="utf-8")
    try:
        if path.suffix.lower() == ".json":
            data = json.loads(text)
        elif path.suffix.lower() == ".toml":
            data = tomllib.loads(text)
        else:
            raise MetadataParseError(
                f"Unsupported metadata format: {path.suffix} (use .toml or .json)"
            )
    except (json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
        raise MetadataParseError(f"Could not parse {path}: {exc}") from exc

    if not isinstance(data, dict):
        raise MetadataParseError(f"{path} must contain a mapping at the top level.")

    try:
        if "locales" in data:
            return AppListing.model_validate(data)
        return AppListing(locales=[AppMetadata.model_validate(data)])
    except ValidationError as exc:
        raise MetadataParseError(f"Invalid metadata in {path}: {exc}") from exc
