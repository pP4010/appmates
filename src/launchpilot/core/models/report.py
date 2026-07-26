"""Validation result models.

These models are the contract between the core and every consumer: the CLI
renderer, the ``--json`` output, and the future FastAPI layer all serialise
exactly these types. Nothing downstream should invent its own result shape.
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, computed_field


class Severity(StrEnum):
    """How badly a finding hurts."""

    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class Store(StrEnum):
    APPLE = "apple"
    GOOGLE = "google"


class Status(StrEnum):
    """Overall outcome of a validation run."""

    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"


class Finding(BaseModel):
    """A single rule violation.

    ``code`` is a stable machine identifier. It is deliberately part of the
    public contract: CI annotations, rule suppression and the ``fix`` command
    all key off it, so codes must not be renamed casually.
    """

    code: str
    severity: Severity
    message: str
    store: Store | None = None
    fix_hint: str | None = None
    fixable: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)
    """Structured detail a consumer may act on, e.g. the character cost of a
    wasted keyword. Additive and optional: rules that have nothing to attach
    leave it empty rather than inventing keys."""

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


class ImageFacts(BaseModel):
    """What we actually observed on disk, independent of any rule."""

    width: int
    height: int
    image_format: str | None = None
    mode: str = ""
    has_alpha: bool = False
    size_bytes: int = 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def megapixels(self) -> float:
        return round(self.width * self.height / 1_000_000, 2)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def aspect_ratio(self) -> float:
        """Long side divided by short side. Orientation-independent."""
        if not self.width or not self.height:
            return 0.0
        lo, hi = sorted((self.width, self.height))
        return round(hi / lo, 4)


class AssetReport(BaseModel):
    """Result for one file."""

    path: Path
    facts: ImageFacts | None = None
    matched_spec_id: str | None = None
    device_class: str | None = None
    findings: list[Finding] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> Status:
        return status_of(self.findings)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity is Severity.ERROR]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity is Severity.WARNING]


class ValidationReport(BaseModel):
    """Result for a whole directory, for one or more stores."""

    directory: Path
    stores: list[Store] = Field(default_factory=list)
    assets: list[AssetReport] = Field(default_factory=list)
    set_findings: list[Finding] = Field(default_factory=list)
    """Findings about the collection as a whole (counts, size consistency)."""

    @property
    def all_findings(self) -> list[Finding]:
        out = list(self.set_findings)
        for asset in self.assets:
            out.extend(asset.findings)
        return out

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> Status:
        return status_of(self.all_findings)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def error_count(self) -> int:
        return sum(1 for f in self.all_findings if f.severity is Severity.ERROR)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def warning_count(self) -> int:
        return sum(1 for f in self.all_findings if f.severity is Severity.WARNING)

    def is_ok(self, *, strict: bool = False) -> bool:
        """Whether the run should be considered a pass.

        With ``strict``, warnings are promoted to failures — the mode you want
        in CI once a project is already clean.
        """
        if self.error_count:
            return False
        return not (strict and self.warning_count)


def status_of(findings: list[Finding]) -> Status:
    if any(f.severity is Severity.ERROR for f in findings):
        return Status.FAIL
    if any(f.severity is Severity.WARNING for f in findings):
        return Status.WARN
    return Status.PASS
