"""Automatic repair of store screenshots.

Handles the three problems that account for nearly every rejected upload:
a stray alpha channel, a non-RGB colour space, and an off-spec resolution.

Safety: the fixer never writes over its input. Callers supply a separate output
directory, and :class:`FixPlan` lets the CLI show exactly what would change
before anything is written.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from PIL import Image, ImageColor
from pydantic import BaseModel, Field

from launchpilot.core.errors import (
    OutputExistsError,
    SourceIsDestinationError,
    UnreadableImageError,
)
from launchpilot.core.models.report import Store
from launchpilot.core.services.image_validator import (
    discover_images,
    read_facts,
)
from launchpilot.core.specs.registry import SizeSpec, load_spec

DEFAULT_BACKGROUND = "#FFFFFF"

# JPEG qualities tried in order when a file must be shrunk under a byte limit.
_JPEG_QUALITY_LADDER = (95, 90, 85, 80, 75, 70)


class FixAction(BaseModel):
    """One transformation applied to one file."""

    code: str
    detail: str


class FixPlan(BaseModel):
    """What the fixer intends to do to a single file."""

    source: Path
    destination: Path
    actions: list[FixAction] = Field(default_factory=list)
    target_size: tuple[int, int] | None = None
    error: str | None = None

    @property
    def changed(self) -> bool:
        return bool(self.actions)


class FixResult(BaseModel):
    plans: list[FixPlan] = Field(default_factory=list)
    output_dir: Path
    dry_run: bool = True

    @property
    def changed_count(self) -> int:
        return sum(1 for p in self.plans if p.changed and not p.error)

    @property
    def failed(self) -> list[FixPlan]:
        return [p for p in self.plans if p.error]


class ScreenshotFixer:
    """Rewrites screenshots so they satisfy a store's specification.

    Resizing letterboxes rather than stretches: distorting a UI screenshot to
    hit a target aspect ratio looks broken to reviewers and users, whereas
    padding onto the background colour is visually neutral.
    """

    def __init__(
        self,
        store: Store = Store.APPLE,
        *,
        background: str = DEFAULT_BACKGROUND,
        target_spec_id: str | None = None,
    ) -> None:
        self.store = store
        self.spec = load_spec(store)
        self.background = background
        self.target_spec_id = target_spec_id
        # Fail fast on a bad colour rather than mid-way through a batch.
        self._bg_rgb: tuple[int, int, int] = ImageColor.getrgb(background)[:3]

    # -- planning ----------------------------------------------------------

    def plan_file(self, path: Path, destination: Path) -> FixPlan:
        plan = FixPlan(source=path, destination=destination)
        try:
            facts = read_facts(path)
        except OSError as exc:
            plan.error = str(exc)
            return plan

        if facts.has_alpha:
            plan.actions.append(
                FixAction(
                    code="FLATTEN_ALPHA",
                    detail=f"flatten {facts.mode} onto {self.background}",
                )
            )
        if facts.mode not in {"RGB", "L"}:
            plan.actions.append(
                FixAction(code="CONVERT_RGB", detail=f"convert {facts.mode} to RGB")
            )

        target = self._resolve_target(facts.width, facts.height)
        if target is not None and (facts.width, facts.height) != self._oriented(
            target, facts.width, facts.height
        ):
            w, h = self._oriented(target, facts.width, facts.height)
            plan.target_size = (w, h)
            plan.actions.append(
                FixAction(
                    code="RESIZE",
                    detail=f"{facts.width}x{facts.height} -> {w}x{h} ({target.device_class})",
                )
            )

        limit = self.spec.rules.max_bytes
        if limit is not None and facts.size_bytes > limit:
            plan.actions.append(
                FixAction(
                    code="RECOMPRESS",
                    detail=f"{facts.size_bytes / 1_048_576:.1f} MB -> under "
                    f"{limit / 1_048_576:.0f} MB",
                )
            )
        return plan

    def _resolve_target(self, width: int, height: int) -> SizeSpec | None:
        """Which spec size this image should become."""
        if self.target_spec_id:
            return self.spec.get(self.target_spec_id)

        hit = self.spec.find_exact(width, height)
        if hit is not None and hit.status in {"required", "accepted"}:
            return None  # already a good size
        if hit is not None and hit.supersedes:
            return self.spec.get(hit.supersedes)
        return self.spec.nearest(width, height)

    @staticmethod
    def _oriented(spec: SizeSpec, width: int, height: int) -> tuple[int, int]:
        """Match the source orientation so landscape input stays landscape."""
        short, long = spec.portrait
        return (long, short) if width > height else (short, long)

    # -- execution ---------------------------------------------------------

    def fix_directory(
        self,
        directory: Path,
        output_dir: Path,
        *,
        dry_run: bool = False,
        force: bool = False,
    ) -> FixResult:
        paths = discover_images(directory)

        # Only guard the destination when we are actually going to write. A dry
        # run legitimately passes the source directory as a placeholder.
        if not dry_run:
            if output_dir.resolve() == directory.resolve():
                raise SourceIsDestinationError(output_dir)
            if output_dir.exists() and any(output_dir.iterdir()) and not force:
                raise OutputExistsError(output_dir)

        result = FixResult(output_dir=output_dir, dry_run=dry_run, plans=[])
        for path in paths:
            plan = self.plan_file(path, output_dir / path.name)
            if not dry_run and plan.changed and not plan.error:
                try:
                    self._apply(plan)
                except (OSError, ValueError) as exc:
                    plan.error = str(exc)
            result.plans.append(plan)
        return result

    def _apply(self, plan: FixPlan) -> None:
        plan.destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            with Image.open(plan.source) as img:
                img.load()
                out = self._flatten(img)
                if plan.target_size:
                    out = self._letterbox(out, plan.target_size)
                self._save(out, plan.destination)
        except OSError as exc:
            raise UnreadableImageError(plan.source, str(exc)) from exc

    def _flatten(self, img: Image.Image) -> Image.Image:
        """Composite any transparency onto an opaque background, then force RGB."""
        if img.mode == "P" and "transparency" in img.info:
            img = img.convert("RGBA")
        if img.mode in {"RGBA", "LA", "PA"} or "transparency" in img.info:
            rgba = img.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, self._bg_rgb)
            canvas.paste(rgba, mask=rgba.split()[-1])
            return canvas
        return img.convert("RGB")

    def _letterbox(self, img: Image.Image, target: tuple[int, int]) -> Image.Image:
        """Scale to fit inside ``target``, then pad. Never distorts."""
        tw, th = target
        scale = min(tw / img.width, th / img.height)
        new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        resized = img.resize(new_size, Image.Resampling.LANCZOS)

        canvas = Image.new("RGB", target, self._bg_rgb)
        canvas.paste(resized, ((tw - new_size[0]) // 2, (th - new_size[1]) // 2))
        return canvas

    def _save(self, img: Image.Image, destination: Path) -> None:
        limit = self.spec.rules.max_bytes
        suffix = destination.suffix.lower()

        if suffix in {".jpg", ".jpeg"}:
            self._save_jpeg(img, destination, limit)
            return

        img.save(destination, format="PNG", optimize=True)
        if limit is not None and destination.stat().st_size > limit:
            # PNG cannot be compressed further without quality loss; JPEG can.
            destination.unlink()
            self._save_jpeg(img, destination.with_suffix(".jpg"), limit)

    def _save_jpeg(self, img: Image.Image, destination: Path, limit: int | None) -> None:
        for quality in _JPEG_QUALITY_LADDER:
            img.save(destination, format="JPEG", quality=quality, optimize=True, subsampling=0)
            if limit is None or destination.stat().st_size <= limit:
                return


def targets_for(store: Store) -> Sequence[SizeSpec]:
    """Spec sizes a user may pass to ``--target``."""
    return [s for s in load_spec(store).sizes if s.status in {"required", "accepted"}]
