"""App Store keyword field auditing and construction.

Every rule here follows from one documented Apple behaviour: the app name, the
subtitle and the 100-character keyword field are indexed as a single pool of
*words*, and search matches are formed by combining them.

Three consequences do most of the work:

* A phrase you want to rank for is reachable when every one of its words is
  somewhere in the pool. Storing the phrase itself buys nothing extra.
* A word already in the title or subtitle is already indexed. Repeating it in
  the keyword field spends characters for no additional reach.
* Because Apple combines words itself, spaces in the keyword field are pure
  overhead — "habit tracker" and "habit,tracker" index identically, and the
  second is a character shorter.

The field is never shown to a user, so none of this is self-correcting. A
listing with a third of its budget wasted looks exactly like a perfect one.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence

from launchpilot.core.models.keywords import KeywordFieldReport, TargetCoverage
from launchpilot.core.models.report import Finding, Severity, Store
from launchpilot.core.specs.registry import AsoSpec, load_aso_spec

_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)


def tokenize(text: str | None) -> list[str]:
    """Split into indexable words, lowercased, punctuation removed.

    Accents are preserved rather than stripped: "café" and "cafe" are different
    search terms on a French storefront, and folding them would silently claim
    coverage the listing does not have.
    """
    if not text:
        return []
    normalised = unicodedata.normalize("NFC", text.lower())
    return [w for w in _WORD_RE.split(normalised) if w]


def split_field(field_value: str) -> list[str]:
    """Split a keyword field into its declared terms, preserving order."""
    return [part.strip() for part in field_value.split(",") if part.strip()]


def looks_plural(word: str, other: str) -> bool:
    """Whether ``word`` is a naive plural of ``other``.

    Apple does some stemming but has never documented which forms it collapses,
    so this drives a warning rather than an automatic removal — telling someone
    to delete a keyword that turns out to matter is worse than letting them
    decide.
    """
    return word in {f"{other}s", f"{other}es"}


class KeywordBuilder:
    """Audits an existing keyword field and can rebuild a better one."""

    def __init__(self, spec: AsoSpec | None = None) -> None:
        self.spec = spec or load_aso_spec()

    # -- helpers -----------------------------------------------------------

    def _severity(self, code: str) -> Severity:
        return Severity(self.spec.findings.get(code, "warning"))

    def _finding(
        self,
        code: str,
        message: str,
        *,
        fix_hint: str | None = None,
        cost: int = 0,
        **metadata: object,
    ) -> Finding:
        payload: dict[str, object] = dict(metadata)
        if cost:
            payload["cost"] = cost
        return Finding(
            code=code,
            severity=self._severity(code),
            message=message,
            store=Store.APPLE,
            fix_hint=fix_hint,
            fixable=True,
            metadata=payload,
        )

    # -- audit -------------------------------------------------------------

    def audit(
        self,
        field_value: str,
        *,
        title: str | None = None,
        subtitle: str | None = None,
        targets: Sequence[str] = (),
    ) -> KeywordFieldReport:
        """Report everything wrong with a keyword field, with the cost of each."""
        spec = self.spec
        terms = split_field(field_value)
        title_words = set(tokenize(title))
        subtitle_words = set(tokenize(subtitle))
        already_indexed = title_words | subtitle_words

        findings: list[Finding] = []

        if len(field_value) > spec.field.max_length:
            findings.append(
                self._finding(
                    "ASO_KEYWORD_FIELD_TOO_LONG",
                    f"Keyword field is {len(field_value)} characters, "
                    f"over the {spec.field.max_length} limit.",
                    fix_hint=f"Remove {len(field_value) - spec.field.max_length} character(s).",
                )
            )

        # Spaces. Apple combines words itself, so every space is overhead —
        # both the conventional ", " after a comma and multi-word terms.
        space_count = field_value.count(" ")
        if space_count:
            findings.append(
                self._finding(
                    "ASO_KEYWORD_SPACES",
                    f"{space_count} space(s) in the keyword field.",
                    fix_hint="Separate with commas only: 'a,b,c' not 'a, b, c'.",
                    cost=space_count,
                )
            )

        seen: dict[str, int] = {}
        for term in terms:
            for word in tokenize(term):
                seen[word] = seen.get(word, 0) + 1

        for word, count in seen.items():
            if count > 1:
                findings.append(
                    self._finding(
                        "ASO_DUPLICATE_IN_FIELD",
                        f"'{word}' appears {count} times in the keyword field.",
                        fix_hint="Apple indexes each word once; keep a single occurrence.",
                        cost=(count - 1) * (len(word) + 1),
                        word=word,
                    )
                )
            if word in already_indexed:
                source = "title" if word in title_words else "subtitle"
                findings.append(
                    self._finding(
                        "ASO_DUPLICATE_OF_TITLE",
                        f"'{word}' is already in the {source}, so it is already indexed.",
                        fix_hint=f"Remove '{word}' and spend the characters on a new term.",
                        cost=len(word) + 1,
                        word=word,
                    )
                )
            if word in spec.noise_words:
                findings.append(
                    self._finding(
                        "ASO_NOISE_WORD",
                        f"'{word}' carries no search intent.",
                        fix_hint=(
                            "Nobody searches this word alone; the characters are better spent."
                        ),
                        cost=len(word) + 1,
                        word=word,
                    )
                )
            if word in spec.category_words:
                findings.append(
                    self._finding(
                        "ASO_CATEGORY_WORD",
                        f"'{word}' is a category name and is already indexed from your category.",
                        fix_hint=f"Remove '{word}'.",
                        cost=len(word) + 1,
                        word=word,
                    )
                )
            if word in spec.trademark_words:
                findings.append(
                    self._finding(
                        "ASO_TRADEMARK_RISK",
                        f"'{word}' looks like another company's trademark.",
                        fix_hint=(
                            "Naming a competitor in metadata risks rejection under "
                            "App Review Guideline 5.2.1."
                        ),
                        word=word,
                    )
                )

        words = list(seen)
        for word in words:
            for other in words:
                if word != other and looks_plural(word, other):
                    findings.append(
                        self._finding(
                            "ASO_PLURAL_PAIR",
                            f"'{word}' and '{other}' differ only by pluralisation.",
                            fix_hint=(
                                "Apple stems some plurals but has never documented which. "
                                "Keeping both is usually spend for nothing."
                            ),
                            cost=len(word) + 1,
                            word=word,
                        )
                    )

        indexed = sorted(already_indexed | set(seen))
        coverage = self.check_coverage(targets, title=title, subtitle=subtitle, field=field_value)
        findings.extend(
            self._finding(
                "ASO_UNCOVERED_TARGET",
                f"'{item.phrase}' is not reachable: missing {', '.join(item.missing_words)}.",
                fix_hint=f"Add {', '.join(item.missing_words)} to the keyword field.",
                phrase=item.phrase,
            )
            for item in coverage
            if not item.covered
        )

        report = KeywordFieldReport(
            field_value=field_value,
            max_length=spec.field.max_length,
            title=title,
            subtitle=subtitle,
            indexed_words=indexed,
            findings=findings,
            coverage=coverage,
        )

        rebuilt = self.build(
            targets or list(terms),
            title=title,
            subtitle=subtitle,
            extra=[w for w in seen if w not in already_indexed],
        )
        if rebuilt != field_value:
            report.suggested_field = rebuilt
        return report

    # -- coverage ----------------------------------------------------------

    def check_coverage(
        self,
        targets: Sequence[str],
        *,
        title: str | None = None,
        subtitle: str | None = None,
        field: str = "",
    ) -> list[TargetCoverage]:
        """Which target phrases the listing can actually rank for."""
        sources = {
            "title": set(tokenize(title)),
            "subtitle": set(tokenize(subtitle)),
            "keywords": {w for term in split_field(field) for w in tokenize(term)},
        }
        pool = set().union(*sources.values()) if sources else set()

        results = []
        for phrase in targets:
            words = tokenize(phrase)
            missing = [w for w in words if w not in pool]
            covered_by = {
                name: [w for w in words if w in source_words]
                for name, source_words in sources.items()
                if any(w in source_words for w in words)
            }
            results.append(
                TargetCoverage(
                    phrase=phrase,
                    covered=bool(words) and not missing,
                    missing_words=missing,
                    covered_by=covered_by,
                )
            )
        return results

    # -- build -------------------------------------------------------------

    def build(
        self,
        targets: Sequence[str],
        *,
        title: str | None = None,
        subtitle: str | None = None,
        extra: Iterable[str] = (),
    ) -> str:
        """Construct the field that covers ``targets`` in the fewest characters.

        Words already in the title or subtitle are dropped, because they are
        already in the pool. Words are emitted in target order so that when the
        budget runs out, the phrases the developer listed first survive.
        """
        spec = self.spec
        already_indexed = set(tokenize(title)) | set(tokenize(subtitle))
        skip = already_indexed | set(spec.noise_words) | set(spec.category_words)

        ordered: list[str] = []
        for phrase in targets:
            for word in tokenize(phrase):
                if word not in skip and word not in ordered:
                    ordered.append(word)
        for word in extra:
            if word not in skip and word not in ordered:
                ordered.append(word)

        chosen: list[str] = []
        length = 0
        for word in ordered:
            cost = len(word) + (1 if chosen else 0)
            if length + cost > spec.field.max_length:
                continue  # a shorter later word may still fit
            chosen.append(word)
            length += cost

        return spec.field.separator.join(chosen)
