"""Competitor listings and search positions.

Two things this module is careful about, both of which would be easy to get
quietly wrong:

**Screenshot availability is partial.** The public catalogue returned iPhone
screenshots for 47% of a 55-app sample. An app with no gallery here has not
necessarily shipped none — the API withheld them. Every count and median is
reported against the sample it came from, and apps that were withheld are
counted separately rather than folded in as zeros, which would drag every
niche-level statistic towards nothing.

**A search position is not an App Store ranking.** The public endpoint returns
results in its own relevance order. That is a real signal and it is what gets
reported, but the App Store app serves search through a different path with
personalisation and paid placements, so the two can disagree.

As with the rest of the core, fetching lives in the client. Everything here is
a pure function over already-fetched entries.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import statistics
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from launchpilot.core.models.competitors import (
    CompetitorApp,
    CompetitorReport,
    Device,
    RankPosition,
    RankReport,
    Screenshot,
    ScreenshotStrategy,
)

DEFAULT_TOP_N = 10

# The catalogue's resize directive, e.g. ".../Screen_1.png/392x696bb.png".
_SIZE_RE = re.compile(r"/(\d+)x(\d+)[a-z]*\.(?:png|jpg|jpeg)$", re.IGNORECASE)


def parse_screenshot(url: str, device: Device) -> Screenshot:
    """Describe a screenshot from its URL alone.

    The last path segment encodes the served size, so orientation and
    dimensions come free — no download, no bandwidth, nothing fetched from
    another company's CDN just to count pixels.
    """
    match = _SIZE_RE.search(url)
    width = int(match.group(1)) if match else None
    height = int(match.group(2)) if match else None
    return Screenshot(url=url, device=device, width=width, height=height)


def _parse_date(value: Any) -> dt.date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def competitor_from_entry(entry: dict[str, Any], position: int) -> CompetitorApp | None:
    """Convert one catalogue entry, or ``None`` if it is unusable."""
    track_id = entry.get("trackId")
    name = entry.get("trackName")
    if not isinstance(track_id, int) or not isinstance(name, str):
        return None

    iphone = [u for u in entry.get("screenshotUrls") or [] if isinstance(u, str)]
    ipad = [u for u in entry.get("ipadScreenshotUrls") or [] if isinstance(u, str)]
    shots = [parse_screenshot(u, Device.IPHONE) for u in iphone]
    shots += [parse_screenshot(u, Device.IPAD) for u in ipad]

    return CompetitorApp(
        position=position,
        track_id=track_id,
        name=name,
        seller=str(entry.get("sellerName") or entry.get("artistName") or "unknown"),
        rating_count=int(entry.get("userRatingCount") or 0),
        rating=float(entry["averageUserRating"]) if entry.get("averageUserRating") else None,
        price=float(entry.get("price") or 0.0),
        updated=_parse_date(entry.get("currentVersionReleaseDate")),
        genres=[g for g in entry.get("genres", []) if isinstance(g, str)],
        screenshots=shots,
        screenshots_exposed=bool(iphone or ipad),
    )


def build_strategy(apps: Sequence[CompetitorApp]) -> ScreenshotStrategy:
    """Summarise what the field does with its screenshots.

    Only apps whose screenshots the catalogue exposed contribute to the counts.
    Treating a withheld gallery as zero screenshots would halve every median in
    a niche for a reason that has nothing to do with the competitors.
    """
    exposed = [a for a in apps if a.screenshots_exposed]
    missing = [a for a in apps if not a.screenshots_exposed]

    counts = [len([s for s in a.screenshots if s.device is Device.IPHONE]) for a in exposed]
    counts = [c for c in counts if c]

    portrait = 0
    landscape = 0
    for app in exposed:
        phone_shots = [s for s in app.screenshots if s.device is Device.IPHONE]
        orientations = [s.is_portrait for s in phone_shots if s.is_portrait is not None]
        if not orientations:
            continue
        # An app is "portrait" when most of its screenshots are.
        if sum(orientations) * 2 >= len(orientations):
            portrait += 1
        else:
            landscape += 1

    return ScreenshotStrategy(
        apps_sampled=len(exposed),
        apps_missing=len(missing),
        counts=counts,
        portrait_apps=portrait,
        landscape_apps=landscape,
        ipad_apps=sum(1 for a in exposed if any(s.device is Device.IPAD for s in a.screenshots)),
    )


def analyse_competitors(
    keyword: str,
    *,
    country: str,
    result_count: int,
    entries: Sequence[dict[str, Any]],
    top_n: int = DEFAULT_TOP_N,
) -> CompetitorReport:
    """Rank, describe and summarise the competitors for one search term."""
    apps = []
    for index, entry in enumerate(entries, start=1):
        app = competitor_from_entry(entry, index)
        if app is not None:
            apps.append(app)
        if len(apps) >= top_n:
            break

    strategy = build_strategy(apps) if apps else None

    notes: list[str] = []
    if not apps:
        notes.append(f"No apps returned for {keyword!r}.")
    elif strategy and strategy.apps_missing:
        notes.append(
            f"The catalogue withheld screenshots for {strategy.apps_missing} of "
            f"{len(apps)} apps; the figures below come from the other "
            f"{strategy.apps_sampled}."
        )

    return CompetitorReport(
        keyword=keyword,
        country=country.upper(),
        result_count=result_count,
        apps=apps,
        strategy=strategy,
        notes=notes,
    )


def find_position(track_id: int, entries: Sequence[dict[str, Any]]) -> int | None:
    """1-based position of an app in a result list, or ``None`` if absent."""
    for index, entry in enumerate(entries, start=1):
        if entry.get("trackId") == track_id:
            return index
    return None


class RankHistory:
    """Append-only local record of past positions.

    There is no server, so movement is measured against a file the developer
    keeps. Stored as JSON Lines: appending never rewrites earlier records, so a
    crashed run cannot corrupt the history it was reading.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def read(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        records = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # One malformed line should not discard a month of history.
                continue
        return records

    def latest(self, track_id: int, keyword: str, country: str) -> dict[str, Any] | None:
        matches = [
            r
            for r in self.read()
            if r.get("track_id") == track_id
            and r.get("keyword") == keyword
            and r.get("country") == country
        ]
        return max(matches, key=lambda r: str(r.get("date", ""))) if matches else None

    def append(self, report: RankReport) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            json.dumps(
                {
                    "date": report.checked_at.date().isoformat(),
                    "track_id": report.track_id,
                    "country": report.country,
                    "keyword": position.keyword,
                    "position": position.position,
                    "searched_depth": position.searched_depth,
                }
            )
            for position in report.positions
        ]
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")


class CompetitorAnalyzer:
    """Fetches and analyses competitors and search positions."""

    def __init__(self, source: Any) -> None:
        self.source = source

    def competitors(
        self,
        keyword: str,
        *,
        country: str = "us",
        top_n: int = DEFAULT_TOP_N,
        limit: int = 200,
    ) -> CompetitorReport:
        result_count, entries = self.source.search(keyword, country=country, limit=limit)
        return analyse_competitors(
            keyword,
            country=country,
            result_count=result_count,
            entries=entries,
            top_n=top_n,
        )

    def rank(
        self,
        app_id: str,
        keywords: Sequence[str],
        *,
        country: str = "us",
        depth: int = 200,
        history: RankHistory | None = None,
        now: dt.datetime | None = None,
    ) -> RankReport:
        """Find an app's position for each keyword, with movement if known."""
        entry = self.source.lookup(app_id, country=country)
        if entry is None:
            raise LookupError(
                f"No app found for {app_id!r} in the {country.upper()} storefront. "
                "Pass a numeric App Store id or a bundle id."
            )

        track_id = int(entry["trackId"])
        positions = []
        for keyword in keywords:
            result_count, entries = self.source.search(keyword, country=country, limit=depth)
            position = find_position(track_id, entries)

            previous = history.latest(track_id, keyword, country.upper()) if history else None
            positions.append(
                RankPosition(
                    keyword=keyword,
                    position=position,
                    searched_depth=len(entries),
                    result_count=result_count,
                    previous_position=previous.get("position") if previous else None,
                    previous_date=_parse_date(previous.get("date")) if previous else None,
                )
            )

        return RankReport(
            app_name=str(entry.get("trackName") or app_id),
            track_id=track_id,
            country=country.upper(),
            checked_at=now or dt.datetime.now(dt.UTC),
            positions=positions,
        )


def download_screenshots(
    app: CompetitorApp,
    directory: Path,
    *,
    fetch: Any,
    width: int = 0,
    limit: int = 10,
) -> list[Path]:
    """Save one competitor's screenshots for offline reference.

    Filenames are prefixed with the app's position so a directory of several
    competitors stays readable, and ``fetch`` is injected so the download path
    is testable without hitting a CDN.
    """
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    shots = [s for s in app.screenshots if s.device is Device.IPHONE][:limit]
    for index, shot in enumerate(shots, start=1):
        url = shot.at_size(width) if width else shot.url
        data = fetch(url)
        if not data:
            continue
        # App names are third-party data. Dots are excluded along with
        # separators so a name like "../../etc/passwd" cannot produce a
        # traversal sequence, even though the write is already confined to
        # `directory` — the extension is appended here, not taken from input.
        safe = re.sub(r"[^A-Za-z0-9_-]+", "-", app.name)[:40].strip("-") or "app"
        path = directory / f"{app.position:02d}-{safe}-{index:02d}.png"
        path.write_bytes(data)
        written.append(path)
    return written


def count_by(values: Iterable[int]) -> dict[int, int]:
    """Frequency table, used to show the niche's screenshot-count distribution."""
    out: dict[int, int] = {}
    for value in values:
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items()))


def median_or_zero(values: Sequence[float]) -> float:
    return round(statistics.median(values), 1) if values else 0.0
