"""Keyword field tests.

Fully deterministic: no network, no filesystem, no clock. Every rule here is a
consequence of Apple indexing title + subtitle + keyword field as one pool of
words, so the tests are written against that behaviour rather than against the
implementation.
"""

from __future__ import annotations

import pytest

from appmates.core.models.report import Severity
from appmates.core.services.keyword_builder import (
    KeywordBuilder,
    looks_plural,
    split_field,
    tokenize,
)
from appmates.core.specs.registry import load_aso_spec


@pytest.fixture
def builder() -> KeywordBuilder:
    return KeywordBuilder()


def codes(report: object) -> set[str]:
    return {f.code for f in report.findings}  # type: ignore[attr-defined]


# --- tokenisation --------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Habit Tracker", ["habit", "tracker"]),
        ("Kaizen: Habits & Streaks", ["kaizen", "habits", "streaks"]),
        ("multi   space", ["multi", "space"]),
        ("hyphen-word", ["hyphen", "word"]),
        ("", []),
        (None, []),
        ("123 fitness", ["123", "fitness"]),
    ],
)
def test_tokenize(text: str | None, expected: list[str]) -> None:
    assert tokenize(text) == expected


def test_tokenize_preserves_accents() -> None:
    """'café' and 'cafe' are different search terms; folding them would claim
    coverage the listing does not have."""
    assert tokenize("Café Météo") == ["café", "météo"]


def test_split_field_trims_and_drops_empties() -> None:
    assert split_field("a, b ,, c,") == ["a", "b", "c"]


@pytest.mark.parametrize(
    ("word", "other", "expected"),
    [("habits", "habit", True), ("boxes", "box", True), ("habit", "habits", False)],
)
def test_looks_plural(word: str, other: str, expected: bool) -> None:
    assert looks_plural(word, other) is expected


# --- waste detection -----------------------------------------------------


def test_spaces_are_flagged_because_apple_combines_words_itself(
    builder: KeywordBuilder,
) -> None:
    report = builder.audit("habit, streak, focus")
    assert "ASO_KEYWORD_SPACES" in codes(report)
    space = next(f for f in report.findings if f.code == "ASO_KEYWORD_SPACES")
    assert space.metadata["cost"] == 2


def test_a_word_repeated_in_the_field_is_flagged(builder: KeywordBuilder) -> None:
    report = builder.audit("habit,streak,habit")
    assert "ASO_DUPLICATE_IN_FIELD" in codes(report)


def test_a_word_already_in_the_title_is_flagged(builder: KeywordBuilder) -> None:
    report = builder.audit("habit,streak", title="Habit Tracker")
    finding = next(f for f in report.findings if f.code == "ASO_DUPLICATE_OF_TITLE")
    assert finding.metadata["word"] == "habit"
    assert finding.metadata["cost"] == len("habit") + 1


def test_a_word_already_in_the_subtitle_is_flagged(builder: KeywordBuilder) -> None:
    report = builder.audit("routine", subtitle="Daily routine builder")
    assert "ASO_DUPLICATE_OF_TITLE" in codes(report)
    assert "subtitle" in next(
        f.message for f in report.findings if f.code == "ASO_DUPLICATE_OF_TITLE"
    )


def test_noise_words_are_flagged(builder: KeywordBuilder) -> None:
    assert "ASO_NOISE_WORD" in codes(builder.audit("app,free,habit"))


def test_category_words_are_flagged(builder: KeywordBuilder) -> None:
    assert "ASO_CATEGORY_WORD" in codes(builder.audit("productivity,habit"))


def test_trademarks_are_flagged_as_a_rejection_risk(builder: KeywordBuilder) -> None:
    report = builder.audit("habit,instagram")
    finding = next(f for f in report.findings if f.code == "ASO_TRADEMARK_RISK")
    assert "5.2.1" in (finding.fix_hint or "")


def test_singular_and_plural_pairs_are_flagged(builder: KeywordBuilder) -> None:
    assert "ASO_PLURAL_PAIR" in codes(builder.audit("habit,habits"))


def test_an_over_length_field_is_an_error(builder: KeywordBuilder) -> None:
    report = builder.audit("x" * 101)
    assert "ASO_KEYWORD_FIELD_TOO_LONG" in codes(report)
    assert report.remaining < 0


def test_a_clean_field_produces_no_errors(builder: KeywordBuilder) -> None:
    report = builder.audit("streak,focus,routine", title="Kaizen")
    assert not [f for f in report.findings if f.severity is Severity.ERROR]


# --- waste accounting ----------------------------------------------------


def test_waste_is_deduplicated_per_word(builder: KeywordBuilder) -> None:
    """A word tripping several rules still reclaims its characters only once.

    'habit' here is both a duplicate within the field and already in the title.
    Summing the findings would double-count the same six characters — exactly
    the inflation this tool exists to point out in other people's listings.
    """
    report = builder.audit("habit,habit,streak", title="Habit Tracker")
    naive_sum = sum(int(f.metadata.get("cost", 0)) for f in report.findings)
    assert report.wasted_characters < naive_sum
    assert report.wasted_characters == max(
        int(f.metadata.get("cost", 0)) for f in report.findings if f.metadata.get("word") == "habit"
    )


def test_space_cost_is_counted_alongside_word_costs(builder: KeywordBuilder) -> None:
    report = builder.audit("app, free")
    assert report.wasted_characters >= 1  # at least the space


def test_a_clean_field_wastes_nothing(builder: KeywordBuilder) -> None:
    assert builder.audit("streak,focus", title="Kaizen").wasted_characters == 0


def test_length_and_remaining_track_the_budget(builder: KeywordBuilder) -> None:
    report = builder.audit("habit,streak")
    assert report.length == len("habit,streak")
    assert report.remaining == 100 - report.length


# --- coverage ------------------------------------------------------------


def test_a_phrase_is_covered_when_all_its_words_are_indexed(
    builder: KeywordBuilder,
) -> None:
    """The rule that surprises people: the phrase itself never has to appear."""
    coverage = builder.check_coverage(["habit tracker"], title="Kaizen", field="habit,tracker")
    assert coverage[0].covered is True


def test_words_split_across_title_and_field_still_cover_a_phrase(
    builder: KeywordBuilder,
) -> None:
    coverage = builder.check_coverage(["habit tracker"], title="Habit", field="tracker")
    assert coverage[0].covered is True
    assert set(coverage[0].covered_by) == {"title", "keywords"}


def test_a_missing_word_leaves_a_phrase_unreachable(builder: KeywordBuilder) -> None:
    coverage = builder.check_coverage(["morning streak"], field="streak")
    assert coverage[0].covered is False
    assert coverage[0].missing_words == ["morning"]


def test_uncovered_targets_become_findings(builder: KeywordBuilder) -> None:
    report = builder.audit("streak", targets=["morning streak"])
    assert "ASO_UNCOVERED_TARGET" in codes(report)
    assert report.uncovered_targets == ["morning streak"]


def test_an_empty_phrase_is_not_covered(builder: KeywordBuilder) -> None:
    assert builder.check_coverage([""], field="a")[0].covered is False


def test_coverage_is_case_insensitive(builder: KeywordBuilder) -> None:
    assert builder.check_coverage(["HABIT Tracker"], field="habit,tracker")[0].covered


# --- building ------------------------------------------------------------


def test_build_omits_words_already_in_the_title(builder: KeywordBuilder) -> None:
    built = builder.build(["habit tracker", "morning streak"], title="Habit Tracker")
    assert "habit" not in split_field(built)
    assert "tracker" not in split_field(built)
    assert set(split_field(built)) == {"morning", "streak"}


def test_build_omits_noise_and_category_words(builder: KeywordBuilder) -> None:
    built = builder.build(["free habit app", "productivity streak"])
    assert set(split_field(built)) == {"habit", "streak"}


def test_build_deduplicates_across_phrases(builder: KeywordBuilder) -> None:
    built = builder.build(["habit streak", "habit routine"])
    assert split_field(built).count("habit") == 1


def test_build_uses_commas_without_spaces(builder: KeywordBuilder) -> None:
    built = builder.build(["habit streak", "daily routine"])
    assert " " not in built


def test_build_output_covers_every_target(builder: KeywordBuilder) -> None:
    targets = ["habit tracker", "morning streak", "gratitude journal"]
    built = builder.build(targets, title="Kaizen")
    coverage = builder.check_coverage(targets, title="Kaizen", field=built)
    assert all(c.covered for c in coverage)


def test_build_respects_the_character_budget(builder: KeywordBuilder) -> None:
    targets = [f"unique{i} phrase{i}" for i in range(40)]
    built = builder.build(targets)
    assert len(built) <= load_aso_spec().field.max_length


def test_build_keeps_the_earliest_targets_when_the_budget_runs_out(
    builder: KeywordBuilder,
) -> None:
    """Order is the developer's priority signal, so it must survive truncation."""
    targets = ["aaaa", *[f"filler{i}" for i in range(30)]]
    built = builder.build(targets)
    assert "aaaa" in split_field(built)


def test_build_from_nothing_is_empty(builder: KeywordBuilder) -> None:
    assert builder.build([]) == ""


# --- suggestions ---------------------------------------------------------


def test_a_wasteful_field_gets_a_shorter_suggestion(builder: KeywordBuilder) -> None:
    report = builder.audit(
        "habit, habits, app, free, productivity, streak",
        title="Habit Tracker",
        targets=["habit tracker", "streak"],
    )
    assert report.suggested_field is not None
    assert len(report.suggested_field) < report.length


def test_the_suggestion_still_covers_every_target(builder: KeywordBuilder) -> None:
    targets = ["habit tracker", "daily routine", "gratitude journal"]
    report = builder.audit(
        "habit, habits, app, free, daily",
        title="Kaizen: Habit Tracker",
        subtitle="Build daily routines",
        targets=targets,
    )
    assert report.suggested_field is not None
    coverage = builder.check_coverage(
        targets,
        title="Kaizen: Habit Tracker",
        subtitle="Build daily routines",
        field=report.suggested_field,
    )
    assert all(c.covered for c in coverage)


def test_an_already_optimal_field_gets_no_suggestion(builder: KeywordBuilder) -> None:
    report = builder.audit("streak,focus", title="Kaizen", targets=["streak", "focus"])
    assert report.suggested_field is None


def test_indexed_words_include_every_source(builder: KeywordBuilder) -> None:
    report = builder.audit("streak", title="Kaizen", subtitle="Daily")
    assert set(report.indexed_words) == {"kaizen", "daily", "streak"}
