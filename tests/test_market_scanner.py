"""Cross-storefront scan tests. Offline: the scanner takes a source, not a URL."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from launchpilot.core.services.market_scanner import (
    COUNTRY_NAMES,
    DEFAULT_STOREFRONTS,
    MarketScanner,
    resolve_countries,
)

NOW = dt.datetime(2026, 7, 26, tzinfo=dt.UTC)
TODAY = dt.date(2026, 7, 26)


def apps(n: int, *, ratings: int, stars: float = 4.5) -> list[dict[str, Any]]:
    return [
        {
            "trackId": i,
            "trackName": f"App {i}",
            "sellerName": f"Dev {i}",
            "userRatingCount": ratings,
            "averageUserRating": stars,
            "price": 0.0,
            "currentVersionReleaseDate": "2026-07-01T00:00:00Z",
        }
        for i in range(n)
    ]


class ByCountry:
    """Returns a different field per storefront, which is the whole point."""

    def __init__(self, mapping: dict[str, list[dict[str, Any]]]) -> None:
        self.mapping = mapping
        self.calls: list[str] = []

    def search(self, term: str, *, country: str, limit: int) -> tuple[int, list[dict[str, Any]]]:
        self.calls.append(country)
        if country not in self.mapping:
            raise RuntimeError(f"storefront {country} unavailable")
        entries = self.mapping[country]
        return len(entries), entries


def test_every_requested_storefront_is_queried() -> None:
    source = ByCountry({c: apps(3, ratings=10) for c in ("us", "fr", "de")})
    report = MarketScanner(source).scan("x", ["us", "fr", "de"], now=NOW, today=TODAY)

    assert source.calls == ["us", "fr", "de"]
    assert len(report.results) == 3
    assert all(r.ok for r in report.results)


def test_results_are_ranked_by_opportunity() -> None:
    source = ByCountry(
        {
            "us": apps(60, ratings=200_000),  # entrenched
            "fr": apps(3, ratings=20),  # open
        }
    )
    report = MarketScanner(source).scan("x", ["us", "fr"], now=NOW, today=TODAY)

    assert [r.country for r in report.ranked()] == ["fr", "us"]
    assert report.best_country == "fr"
    assert report.spread > 0


def test_a_failing_storefront_does_not_abort_the_sweep() -> None:
    """Losing thirteen good results to one bad one would be a poor trade."""
    source = ByCountry({"us": apps(3, ratings=10), "fr": apps(3, ratings=10)})
    report = MarketScanner(source).scan("x", ["us", "xx", "fr"], now=NOW, today=TODAY)

    assert len(report.results) == 3
    assert report.failed_countries == ["xx"]
    assert sum(1 for r in report.results if r.ok) == 2


def test_failed_storefronts_sink_below_real_results() -> None:
    source = ByCountry({"fr": apps(3, ratings=10)})
    report = MarketScanner(source).scan("x", ["xx", "fr"], now=NOW, today=TODAY)
    assert report.ranked()[0].country == "fr"
    assert report.ranked()[-1].ok is False


def test_verdicts_differ_is_the_decision_relevant_signal() -> None:
    """A gap that flips LOCKED to CONTESTED matters; one inside a band does not."""
    mixed = ByCountry({"us": apps(60, ratings=200_000), "fr": apps(2, ratings=5)})
    assert MarketScanner(mixed).scan("x", ["us", "fr"], now=NOW, today=TODAY).verdicts_differ

    same = ByCountry({"us": apps(3, ratings=10), "fr": apps(3, ratings=10)})
    assert not MarketScanner(same).scan("x", ["us", "fr"], now=NOW, today=TODAY).verdicts_differ


def test_spread_is_zero_for_a_single_storefront() -> None:
    source = ByCountry({"us": apps(3, ratings=10)})
    assert MarketScanner(source).scan("x", ["us"], now=NOW, today=TODAY).spread == 0.0


def test_a_scan_where_everything_fails_reports_no_best_country() -> None:
    report = MarketScanner(ByCountry({})).scan("x", ["us", "fr"], now=NOW, today=TODAY)
    assert report.best_country is None
    assert report.spread == 0.0
    assert report.verdicts_differ is False


def test_progress_is_reported_per_storefront() -> None:
    seen: list[tuple[str, int, int]] = []
    source = ByCountry({c: apps(2, ratings=10) for c in ("us", "fr")})
    MarketScanner(source).scan(
        "x", ["us", "fr"], now=NOW, today=TODAY, on_progress=lambda c, i, t: seen.append((c, i, t))
    )
    assert seen == [("us", 1, 2), ("fr", 2, 2)]


def test_country_codes_are_normalised() -> None:
    source = ByCountry({"fr": apps(2, ratings=10)})
    report = MarketScanner(source).scan("x", ["FR"], now=NOW, today=TODAY)
    assert source.calls == ["fr"]
    assert report.results[0].country == "fr"


def test_known_countries_get_a_readable_name() -> None:
    source = ByCountry({"fr": apps(2, ratings=10)})
    assert MarketScanner(source).scan("x", ["fr"], now=NOW).results[0].country_name == "France"


def test_an_unknown_country_falls_back_to_its_code() -> None:
    source = ByCountry({"zz": apps(2, ratings=10)})
    assert MarketScanner(source).scan("x", ["zz"], now=NOW).results[0].country_name == "ZZ"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("us,fr,de", ["us", "fr", "de"]),
        (" US , FR ", ["us", "fr"]),
        ("", list(DEFAULT_STOREFRONTS)),
        (None, list(DEFAULT_STOREFRONTS)),
        (",,,", list(DEFAULT_STOREFRONTS)),
    ],
)
def test_resolve_countries(raw: str | None, expected: list[str]) -> None:
    assert resolve_countries(raw) == expected


def test_the_default_set_is_multilingual() -> None:
    """Difficulty tracks the language a term is searched in, so an all-English
    default would hide most of the opportunity the command exists to find."""
    assert len(DEFAULT_STOREFRONTS) >= 10
    assert {"us", "fr", "de", "jp", "br"} <= set(DEFAULT_STOREFRONTS)
    assert all(c in COUNTRY_NAMES for c in DEFAULT_STOREFRONTS)
