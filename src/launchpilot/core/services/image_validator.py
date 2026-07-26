"""Screenshot validation against the store specification catalogue."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from launchpilot.core.errors import DirectoryNotFoundError
from launchpilot.core.models.report import (
    AssetReport,
    Finding,
    ImageFacts,
    Severity,
    Store,
    ValidationReport,
)
from launchpilot.core.specs.registry import SizeSpec, StoreSpec, load_spec

IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg"})

# Pillow modes that carry per-pixel transparency.
_ALPHA_MODES = frozenset({"RGBA", "LA", "PA", "RGBa", "La"})

# Pillow's `mode` conflated with a colour space. Only these are RGB-compatible.
_RGB_MODES = frozenset({"RGB", "RGBA", "L", "LA", "P", "PA", "1"})


def discover_images(directory: Path) -> list[Path]:
    """Every PNG/JPEG directly inside ``directory``, sorted, hidden files skipped."""
    if not directory.is_dir():
        raise DirectoryNotFoundError(directory)
    return sorted(
        p
        for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES and not p.name.startswith(".")
    )


def read_facts(path: Path) -> ImageFacts:
    """Read image properties without decoding pixel data.

    ``Image.open`` is lazy, so this stays fast on directories of large PNGs.
    """
    with Image.open(path) as img:
        has_alpha = img.mode in _ALPHA_MODES or "transparency" in img.info
        return ImageFacts(
            width=img.width,
            height=img.height,
            image_format=img.format,
            mode=img.mode,
            has_alpha=has_alpha,
            size_bytes=path.stat().st_size,
        )


class ScreenshotValidator:
    """Validates screenshots against one or more store specifications.

    Per-file rules run in :meth:`validate_file`; rules about the collection as a
    whole (counts, size consistency) run in :meth:`validate_set`. Both are needed
    — a directory of individually valid screenshots can still be rejected for
    having eleven of them, or for mixing two device classes.
    """

    def __init__(self, stores: Sequence[Store] | None = None) -> None:
        self.stores: list[Store] = list(stores) if stores else [Store.APPLE, Store.GOOGLE]
        self._specs: dict[Store, StoreSpec] = {s: load_spec(s) for s in self.stores}

    # -- per file ----------------------------------------------------------

    def validate_file(self, path: Path) -> AssetReport:
        try:
            facts = read_facts(path)
        except (UnidentifiedImageError, OSError) as exc:
            return AssetReport(
                path=path,
                findings=[
                    Finding(
                        code="UNREADABLE_IMAGE",
                        severity=Severity.ERROR,
                        message=f"Cannot read image: {exc}",
                        fix_hint="Re-export the file; it may be truncated or not an image.",
                    )
                ],
            )

        return self.validate_facts(facts, path=path)

    def validate_facts(self, facts: ImageFacts, *, path: Path | None = None) -> AssetReport:
        """Apply every rule to already-extracted facts.

        Split out from :meth:`validate_file` so rules can run without touching
        the filesystem: the conformance harness feeds synthetic facts to compare
        this engine against the browser implementation, and an upload endpoint
        will want the same entry point.
        """
        report = AssetReport(path=path or Path("<in-memory>"), facts=facts)
        matched: SizeSpec | None = None

        for store in self.stores:
            spec = self._specs[store]
            report.findings.extend(self._check_format(facts, spec, store))
            if store is Store.APPLE:
                hit, findings = self._check_apple_size(facts, spec)
                matched = matched or hit
                report.findings.extend(findings)
            else:
                report.findings.extend(self._check_google_size(facts, spec))
                report.findings.extend(self._check_google_weight(facts, spec))

        if matched is not None:
            report.matched_spec_id = matched.id
            report.device_class = matched.device_class
        return report

    def _check_format(self, facts: ImageFacts, spec: StoreSpec, store: Store) -> Iterable[Finding]:
        prefix = store.value.upper()
        rules = spec.rules

        fmt = (facts.image_format or "").upper()
        if fmt and fmt not in {f.upper() for f in rules.formats}:
            yield Finding(
                code=f"{prefix}_FORMAT",
                severity=Severity.ERROR,
                store=store,
                message=f"Format {fmt} is not accepted (allowed: {', '.join(rules.formats)}).",
                fix_hint="Re-export as PNG or JPEG.",
                fixable=True,
            )

        if facts.has_alpha and not rules.allow_alpha:
            yield Finding(
                code=f"{prefix}_ALPHA_CHANNEL",
                severity=Severity.ERROR,
                store=store,
                message=(
                    f"Image has an alpha channel (mode {facts.mode}). Transparency is not allowed."
                ),
                fix_hint="Flatten onto an opaque background: `launchpilot fix-screenshots`.",
                fixable=True,
            )

        if rules.required_color_spaces and facts.mode not in _RGB_MODES:
            yield Finding(
                code=f"{prefix}_COLOR_SPACE",
                severity=Severity.ERROR,
                store=store,
                message=f"Colour mode {facts.mode} is not RGB-compatible.",
                fix_hint="Convert to sRGB: `launchpilot fix-screenshots`.",
                fixable=True,
            )

    def _check_apple_size(
        self, facts: ImageFacts, spec: StoreSpec
    ) -> tuple[SizeSpec | None, list[Finding]]:
        """Apple publishes an exact size table and applies zero tolerance."""
        findings: list[Finding] = []
        hit = spec.find_exact(facts.width, facts.height)

        if hit is None:
            nearest = spec.nearest(facts.width, facts.height)
            hint = (
                f"Closest accepted size is {nearest.label}."
                if nearest
                else "See `launchpilot specs`."
            )
            findings.append(
                Finding(
                    code="APPLE_SIZE_UNKNOWN",
                    severity=Severity.ERROR,
                    store=Store.APPLE,
                    message=(f"{facts.width}x{facts.height} matches no accepted App Store size."),
                    fix_hint=hint,
                    fixable=True,
                )
            )
            return None, findings

        if hit.is_deprecated:
            findings.append(
                Finding(
                    code="APPLE_SIZE_DEPRECATED",
                    severity=Severity.ERROR,
                    store=Store.APPLE,
                    message=f"{hit.label} is no longer accepted by App Store Connect.",
                    fix_hint="Re-export at a current size; see `launchpilot specs --store apple`.",
                    fixable=True,
                )
            )
        elif hit.is_legacy:
            # Prefer the documented successor over a raw pixel-distance guess:
            # 1242x2688 is conceptually a 6.5" screenshot even though 6.3" is
            # numerically closer.
            successor = spec.get(hit.supersedes) if hit.supersedes else None
            successor = successor or spec.nearest(facts.width, facts.height)
            findings.append(
                Finding(
                    code="APPLE_LEGACY_SIZE",
                    severity=Severity.WARNING,
                    store=Store.APPLE,
                    message=(
                        f"{facts.width}x{facts.height} is a legacy size, absent from Apple's "
                        "current specification table."
                    ),
                    fix_hint=(f"Current equivalent is {successor.label}." if successor else None),
                    fixable=True,
                )
            )
        return hit, findings

    def _check_google_size(self, facts: ImageFacts, spec: StoreSpec) -> Iterable[Finding]:
        """Play publishes constraints rather than a size table."""
        rules = spec.rules
        short, long = sorted((facts.width, facts.height))

        if rules.min_side is not None and short < rules.min_side:
            yield Finding(
                code="PLAY_SIDE_TOO_SMALL",
                severity=Severity.ERROR,
                store=Store.GOOGLE,
                message=f"Shortest side {short}px is below the {rules.min_side}px minimum.",
                fix_hint="Re-export at 1080x1920 or larger.",
                fixable=True,
            )

        if rules.max_side is not None and long > rules.max_side:
            yield Finding(
                code="PLAY_SIDE_TOO_LARGE",
                severity=Severity.ERROR,
                store=Store.GOOGLE,
                message=f"Longest side {long}px exceeds the {rules.max_side}px maximum.",
                fix_hint="Downscale the screenshot.",
                fixable=True,
            )

        # The rule that quietly rejects tall modern phone screenshots.
        if rules.max_side_ratio is not None and short and long > short * rules.max_side_ratio:
            yield Finding(
                code="PLAY_MAX_TWICE_MIN",
                severity=Severity.ERROR,
                store=Store.GOOGLE,
                message=(
                    f"Longest side ({long}px) is more than {rules.max_side_ratio:g}x the "
                    f"shortest ({short}px). Play rejects this even at a valid resolution."
                ),
                fix_hint=(
                    f"Crop or letterbox to at most {short}x{int(short * rules.max_side_ratio)}."
                ),
                fixable=True,
            )

        if rules.preferred_aspect_ratio is not None:
            delta = abs(facts.aspect_ratio - rules.preferred_aspect_ratio)
            if delta > rules.aspect_ratio_tolerance:
                yield Finding(
                    code="PLAY_ASPECT_RATIO",
                    severity=Severity.WARNING,
                    store=Store.GOOGLE,
                    message=(
                        f"Aspect ratio {facts.aspect_ratio:g}:1 differs from the documented "
                        "16:9 / 9:16."
                    ),
                    fix_hint="Play tolerates this in practice, but 1080x1920 is safest.",
                    fixable=True,
                )

        rec_w, rec_h = rules.recommended_min_width, rules.recommended_min_height
        if rec_w and rec_h and (short < rec_w or long < rec_h):
            yield Finding(
                code="PLAY_BELOW_RECOMMENDED",
                severity=Severity.WARNING,
                store=Store.GOOGLE,
                message=(
                    f"{facts.width}x{facts.height} is below the {rec_w}x{rec_h} recommended "
                    "minimum for promotional eligibility."
                ),
                fix_hint=f"Export at {rec_w}x{rec_h} or larger.",
            )

    def _check_google_weight(self, facts: ImageFacts, spec: StoreSpec) -> Iterable[Finding]:
        limit = spec.rules.max_bytes
        if limit is not None and facts.size_bytes > limit:
            yield Finding(
                code="PLAY_FILE_TOO_LARGE",
                severity=Severity.ERROR,
                store=Store.GOOGLE,
                message=(
                    f"File is {facts.size_bytes / 1_048_576:.1f} MB, over the "
                    f"{limit / 1_048_576:.0f} MB limit."
                ),
                fix_hint="Re-encode as JPEG or compress the PNG.",
                fixable=True,
            )

    # -- per directory -----------------------------------------------------

    def validate_set(self, directory: Path) -> ValidationReport:
        paths = discover_images(directory)
        report = ValidationReport(
            directory=directory,
            stores=self.stores,
            assets=[self.validate_file(p) for p in paths],
        )
        report.set_findings.extend(self.check_set(report.assets))
        return report

    def check_set(self, assets: list[AssetReport]) -> Iterable[Finding]:
        count = len(assets)

        if count == 0:
            yield Finding(
                code="SET_EMPTY",
                severity=Severity.ERROR,
                message="No PNG or JPEG screenshots found in this directory.",
                fix_hint="Check the path, or export your screenshots first.",
            )
            return

        for store in self.stores:
            rules = self._specs[store].rules
            prefix = store.value.upper()

            if rules.min_count is not None and count < rules.min_count:
                yield Finding(
                    code=f"{prefix}_TOO_FEW",
                    severity=Severity.ERROR,
                    store=store,
                    message=f"{count} screenshot(s) found; at least {rules.min_count} required.",
                )
            if rules.max_count is not None and count > rules.max_count:
                yield Finding(
                    code=f"{prefix}_TOO_MANY",
                    severity=Severity.ERROR,
                    store=store,
                    message=f"{count} screenshots found; at most {rules.max_count} allowed.",
                    fix_hint=f"Remove {count - rules.max_count} file(s).",
                )

        # Apple counts per display class, not per directory.
        if Store.APPLE in self.stores:
            yield from self._check_apple_class_counts(assets)

    def _check_apple_class_counts(self, assets: list[AssetReport]) -> Iterable[Finding]:
        rules = self._specs[Store.APPLE].rules
        by_class: defaultdict[str, int] = defaultdict(int)
        for asset in assets:
            if asset.device_class:
                by_class[asset.device_class] += 1

        for device_class, n in sorted(by_class.items()):
            if rules.max_count_per_class is not None and n > rules.max_count_per_class:
                yield Finding(
                    code="APPLE_TOO_MANY_PER_CLASS",
                    severity=Severity.ERROR,
                    store=Store.APPLE,
                    message=(
                        f"{n} screenshots for {device_class}; App Store Connect accepts at "
                        f"most {rules.max_count_per_class} per display size."
                    ),
                    fix_hint=f"Remove {n - rules.max_count_per_class} file(s) for this size.",
                )

        # Apple requires consistent sizes across a localisation. A directory
        # mixing two device classes is almost always an export mistake.
        sizes = Counter((a.facts.width, a.facts.height) for a in assets if a.facts is not None)
        if len(sizes) > 1:
            listed = ", ".join(f"{w}x{h} ({n})" for (w, h), n in sizes.most_common())
            yield Finding(
                code="SET_MIXED_SIZES",
                severity=Severity.WARNING,
                message=f"Directory mixes {len(sizes)} different sizes: {listed}.",
                fix_hint="Keep one display size per directory, one directory per locale.",
            )


def suppress_findings(report: ValidationReport, codes: Iterable[str]) -> ValidationReport:
    """Drop findings whose code is in ``codes``.

    Lets a project opt out of a rule it has consciously accepted without
    disabling validation wholesale.
    """
    ignored = set(codes)
    if not ignored:
        return report
    report.set_findings = [f for f in report.set_findings if f.code not in ignored]
    for asset in report.assets:
        asset.findings = [f for f in asset.findings if f.code not in ignored]
    return report


def detect_target_store(directory: Path) -> Store:
    """Guess which store a directory of screenshots was exported for.

    App Store and Play screenshots are genuinely different assets: Apple's sizes
    (e.g. 1320x2868) all violate Play's "long side <= 2x short side" rule, and
    Play's 1080x1920 matches no Apple size. Validating one directory against
    both therefore always reports errors, which is noise rather than signal.
    So we pick whichever store the files fit better and report against that.
    """
    paths = discover_images(directory)
    if not paths:
        return Store.APPLE

    scores: dict[Store, int] = {}
    for store in (Store.APPLE, Store.GOOGLE):
        validator = ScreenshotValidator([store])
        scores[store] = sum(len(validator.validate_file(p).errors) for p in paths)

    # Ties favour Apple: its exact-size table is the stricter signal.
    return min(scores, key=lambda s: (scores[s], s is not Store.APPLE))
