"""Cross-storefront scanning: where a niche is actually winnable.

A term can be locked in the United States and wide open in France, Brazil or
Poland, and every existing tool asks "how hard is this keyword?" as though there
were one answer. There are 175 storefronts and the answer differs in each.

This matters most before launch, which is exactly when nobody asks it. Choosing
the storefront to lead with — which locale to write first, which language to
localise screenshots into — is a launch decision, and it is decidable from
public data.

The scan reuses the niche scoring unchanged: one keyword, many countries, the
same six signals. What is new is only the sweep and the ordering.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Sequence
from typing import Any

from pydantic import BaseModel, Field, computed_field

from launchpilot.core.models.market import KeywordReport, Verdict
from launchpilot.core.services.market_analyzer import DEFAULT_FETCH_LIMIT, analyse_keyword
from launchpilot.core.specs.registry import MarketSpec, load_market_spec

# The storefronts worth checking first. Chosen for App Store revenue and for
# spread across languages, since a term's difficulty tracks the language it is
# searched in more than the country's size. Override with --countries.
DEFAULT_STOREFRONTS: tuple[str, ...] = (
    "us",  # English, largest
    "gb",
    "ca",
    "au",
    "de",  # German
    "fr",  # French
    "es",  # Spanish
    "it",  # Italian
    "nl",  # Dutch
    "br",  # Portuguese
    "mx",  # Spanish, Latin America
    "jp",  # Japanese
    "kr",  # Korean
    "pl",  # Polish
)

COUNTRY_NAMES: dict[str, str] = {
    "us": "United States",
    "gb": "United Kingdom",
    "ca": "Canada",
    "au": "Australia",
    "de": "Germany",
    "fr": "France",
    "es": "Spain",
    "it": "Italy",
    "nl": "Netherlands",
    "br": "Brazil",
    "mx": "Mexico",
    "jp": "Japan",
    "kr": "South Korea",
    "pl": "Poland",
    "se": "Sweden",
    "in": "India",
    "id": "Indonesia",
    "tr": "Turkey",
    "ru": "Russia",
    "cn": "China",
}


class MarketResult(BaseModel):
    """One storefront's verdict for the keyword."""

    country: str
    country_name: str
    report: KeywordReport | None = None
    error: str | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def winnability(self) -> float:
        return self.report.winnability if self.report else 0.0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def verdict(self) -> str:
        return self.report.verdict.value if self.report else "unknown"

    @property
    def ok(self) -> bool:
        return self.report is not None


class MarketScanReport(BaseModel):
    keyword: str
    scanned_at: dt.datetime
    results: list[MarketResult] = Field(default_factory=list)
    methodology_version: str = ""

    def ranked(self) -> list[MarketResult]:
        """Best opportunity first; storefronts that failed sink to the bottom."""
        return sorted(self.results, key=lambda r: (not r.ok, -r.winnability))

    @computed_field  # type: ignore[prop-decorator]
    @property
    def best_country(self) -> str | None:
        usable = [r for r in self.results if r.ok]
        return max(usable, key=lambda r: r.winnability).country if usable else None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def spread(self) -> float:
        """Gap between the most and least winnable storefront.

        The number that justifies the whole command: a wide spread means the
        choice of launch storefront is worth more than most metadata work.
        """
        scores = [r.winnability for r in self.results if r.ok]
        return round(max(scores) - min(scores), 1) if len(scores) > 1 else 0.0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def open_countries(self) -> list[str]:
        return [r.country for r in self.ranked() if r.report and r.report.verdict is Verdict.OPEN]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def verdicts_differ(self) -> bool:
        """Whether the storefronts disagree about whether the term is winnable.

        This, rather than the numeric spread, is the decision-relevant fact. A
        nineteen-point gap that moves a term from LOCKED to CONTESTED changes
        what a developer should do; a thirty-point gap entirely inside CONTESTED
        does not. Summarising on the spread alone reported "about as hard
        everywhere" for a term that was locked in the United States and
        contested in France.
        """
        verdicts = {r.report.verdict for r in self.results if r.report}
        return len(verdicts) > 1

    @computed_field  # type: ignore[prop-decorator]
    @property
    def failed_countries(self) -> list[str]:
        return [r.country for r in self.results if not r.ok]


class MarketScanner:
    """Scores one keyword across many storefronts."""

    def __init__(self, source: Any, spec: MarketSpec | None = None) -> None:
        self.source = source
        self.spec = spec or load_market_spec()

    def scan(
        self,
        keyword: str,
        countries: Sequence[str] = DEFAULT_STOREFRONTS,
        *,
        limit: int = DEFAULT_FETCH_LIMIT,
        today: dt.date | None = None,
        now: dt.datetime | None = None,
        on_progress: Callable[[str, int, int], None] | None = None,
    ) -> MarketScanReport:
        """Score ``keyword`` in each storefront.

        A storefront that fails is recorded and skipped rather than aborting the
        sweep: this runs for a minute or more across a rate-limited endpoint,
        and losing thirteen good results to one bad one would be a poor trade.
        """
        results: list[MarketResult] = []
        total = len(countries)

        for index, country in enumerate(countries, start=1):
            code = country.lower()
            if on_progress:
                on_progress(code, index, total)

            name = COUNTRY_NAMES.get(code, code.upper())
            try:
                result_count, entries = self.source.search(keyword, country=code, limit=limit)
            except Exception as exc:
                results.append(MarketResult(country=code, country_name=name, error=str(exc)))
                continue

            report = analyse_keyword(
                keyword,
                country=code,
                result_count=result_count,
                entries=entries,
                spec=self.spec,
                today=today,
            )
            results.append(MarketResult(country=code, country_name=name, report=report))

        return MarketScanReport(
            keyword=keyword,
            scanned_at=now or dt.datetime.now(dt.UTC),
            results=results,
            methodology_version=self.spec.version,
        )


def resolve_countries(raw: str | None) -> list[str]:
    """Parse a comma-separated country list, or fall back to the default set."""
    if not raw:
        return list(DEFAULT_STOREFRONTS)
    codes = [c.strip().lower() for c in raw.split(",") if c.strip()]
    return codes or list(DEFAULT_STOREFRONTS)
