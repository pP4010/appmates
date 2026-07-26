"""App Store keyword field models.

The keyword field is never shown to a user, so nothing about it is
self-correcting: a listing with 40 wasted characters looks exactly like a
perfect one. These models make the waste countable.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, computed_field

from launchpilot.core.models.report import Finding


class TargetCoverage(BaseModel):
    """Whether a phrase the developer wants to rank for is actually indexed.

    Apple combines words across the app name, subtitle and keyword field, so a
    phrase is reachable when *every* one of its words appears somewhere in that
    pool — not when the phrase itself appears anywhere.
    """

    phrase: str
    covered: bool
    missing_words: list[str] = Field(default_factory=list)
    covered_by: dict[str, list[str]] = Field(default_factory=dict)
    """Which field supplies each word, so a fix is obvious."""


class KeywordFieldReport(BaseModel):
    """An audited (or freshly built) keyword field."""

    field_value: str
    max_length: int = 100

    title: str | None = None
    subtitle: str | None = None

    indexed_words: list[str] = Field(default_factory=list)
    """The full pool Apple searches: title + subtitle + keyword field."""

    findings: list[Finding] = Field(default_factory=list)
    coverage: list[TargetCoverage] = Field(default_factory=list)
    suggested_field: str | None = None
    """A rebuilt field when the audit found reclaimable characters."""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def length(self) -> int:
        return len(self.field_value)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def remaining(self) -> int:
        return self.max_length - self.length

    @computed_field  # type: ignore[prop-decorator]
    @property
    def wasted_characters(self) -> int:
        """Characters spent on terms that buy nothing.

        Costs are deduplicated per word, taking the largest attributed to each.
        One word commonly trips several rules at once — 'habit' can be both a
        duplicate within the field *and* already present in the title — but
        deleting it reclaims its characters once, not once per rule. Summing the
        findings would inflate the total by exactly the kind of double-counting
        this tool exists to call out.
        """
        per_word: dict[str, int] = {}
        loose = 0
        for finding in self.findings:
            cost = int(finding.metadata.get("cost", 0))
            if not cost:
                continue
            word = finding.metadata.get("word")
            if isinstance(word, str):
                per_word[word] = max(per_word.get(word, 0), cost)
            else:
                loose += cost
        return sum(per_word.values()) + loose

    @computed_field  # type: ignore[prop-decorator]
    @property
    def uncovered_targets(self) -> list[str]:
        return [c.phrase for c in self.coverage if not c.covered]
