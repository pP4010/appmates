"""One go/no-go answer, composed from the checks AppMates already runs separately.

Nothing here is a new rule. A submission gets rejected for a screenshot
problem, a metadata problem or a wasted keyword field just as often as any
one of those alone, and checking each in its own command means reading three
reports and doing the "is this actually ready" arithmetic by hand. This runs
whichever of the three you give inputs for and combines them into one.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from appmates.core.models.keywords import KeywordFieldReport
from appmates.core.models.report import (
    Finding,
    Severity,
    Status,
    Store,
    ValidationReport,
    status_of,
)
from appmates.core.services.image_validator import ScreenshotValidator, detect_target_store
from appmates.core.services.keyword_builder import KeywordBuilder
from appmates.core.services.metadata_validator import (
    MetadataReport,
    MetadataValidator,
    load_listing,
)


class SubmissionReadinessReport(BaseModel):
    """Whichever checks ran, combined. A field left ``None`` means that check
    was not given anything to check — never that it passed."""

    screenshots: ValidationReport | None = None
    metadata: MetadataReport | None = None
    keywords: KeywordFieldReport | None = None

    @property
    def ran(self) -> list[str]:
        return [
            name
            for name, report in (
                ("screenshots", self.screenshots),
                ("metadata", self.metadata),
                ("keywords", self.keywords),
            )
            if report is not None
        ]

    @property
    def all_findings(self) -> list[Finding]:
        out: list[Finding] = []
        if self.screenshots is not None:
            out.extend(self.screenshots.all_findings)
        if self.metadata is not None:
            out.extend(self.metadata.all_findings)
        if self.keywords is not None:
            out.extend(self.keywords.findings)
        return out

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


def check_submission(
    *,
    screenshots_dir: Path | None = None,
    screenshot_store: Store | None = None,
    metadata_file: Path | None = None,
    metadata_locale: str = "en-US",
    metadata_stores: list[Store] | None = None,
    keyword_field: str | None = None,
    keyword_title: str | None = None,
    keyword_subtitle: str | None = None,
    keyword_targets: list[str] | None = None,
) -> SubmissionReadinessReport:
    """Run each check whose input was given, and combine the results.

    When ``metadata_file`` is given and ``keyword_field``/``keyword_title``/
    ``keyword_subtitle`` are not, the keyword audit reads them from
    ``metadata_locale`` in that listing — the same title, subtitle and
    keyword field a submission would actually ship with, not a second copy
    typed in separately.
    """
    screenshots = None
    if screenshots_dir is not None:
        stores = [screenshot_store] if screenshot_store else [detect_target_store(screenshots_dir)]
        screenshots = ScreenshotValidator(stores).validate_set(screenshots_dir)

    metadata = None
    listing_entry = None
    if metadata_file is not None:
        listing = load_listing(metadata_file)
        metadata = MetadataValidator(metadata_stores).validate_listing(listing)
        metadata.source = metadata_file
        listing_entry = next((m for m in listing.locales if m.locale == metadata_locale), None)

    keywords = None
    field = (
        keyword_field
        if keyword_field is not None
        else (listing_entry.keywords if listing_entry else None)
    )
    title = keyword_title or (listing_entry.title if listing_entry else None)
    subtitle = keyword_subtitle or (listing_entry.subtitle if listing_entry else None)
    if field is not None:
        keywords = KeywordBuilder().audit(
            field, title=title, subtitle=subtitle, targets=keyword_targets or []
        )

    return SubmissionReadinessReport(screenshots=screenshots, metadata=metadata, keywords=keywords)
