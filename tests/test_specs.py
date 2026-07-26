"""Tests for the spec registry.

These guard the catalogue itself, not just the loader: the numbers here are the
product, so a typo in the YAML is a correctness bug.
"""

from __future__ import annotations

import datetime as dt

import pytest

from launchpilot.core.models.report import Store
from launchpilot.core.specs.registry import all_specs, load_spec


def test_both_catalogues_load() -> None:
    assert len(all_specs()) == 2


def test_specs_are_cached() -> None:
    assert load_spec(Store.APPLE) is load_spec(Store.APPLE)


@pytest.mark.parametrize("store", list(Store))
def test_every_spec_declares_its_provenance(store: Store) -> None:
    """A stale catalogue is a silent correctness problem, so provenance is required."""
    spec = load_spec(store)
    assert spec.source_url.startswith("https://")
    assert isinstance(spec.last_verified, dt.date)
    assert spec.rules.formats


@pytest.mark.parametrize("store", list(Store))
def test_size_ids_are_unique(store: Store) -> None:
    ids = [s.id for s in load_spec(store).sizes]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("store", list(Store))
def test_supersedes_targets_exist(store: Store) -> None:
    spec = load_spec(store)
    for size in spec.sizes:
        if size.supersedes:
            assert spec.get(size.supersedes) is not None, size.id


@pytest.mark.parametrize("store", list(Store))
def test_statuses_are_from_the_known_set(store: Store) -> None:
    allowed = {"required", "accepted", "legacy", "deprecated"}
    assert {s.status for s in load_spec(store).sizes} <= allowed


def test_apple_current_sizes_match_the_published_table() -> None:
    """Pinned against Apple's specification table; update with the source URL."""
    apple = load_spec(Store.APPLE)
    expected = {
        'iPhone 6.9"': (1320, 2868),
        'iPhone 6.5"': (1284, 2778),
        'iPhone 6.3"': (1206, 2622),
        'iPhone 5.5"': (1242, 2208),
        'iPad 13"': (2064, 2752),
    }
    actual = {s.device_class: (s.width, s.height) for s in apple.sizes}
    for device, size in expected.items():
        assert actual[device] == size


def test_neither_store_allows_alpha_on_screenshots() -> None:
    for spec in all_specs():
        assert spec.rules.allow_alpha is False


def test_play_icon_is_the_one_asset_requiring_alpha() -> None:
    play = load_spec(Store.GOOGLE)
    icon = next(a for a in play.graphic_assets if a.id == "play-icon")
    assert icon.allow_alpha is True
    assert (icon.width, icon.height) == (512, 512)


def test_exact_match_prefers_current_over_legacy() -> None:
    """1242x2688 is only legacy; a size that were both must resolve to current."""
    apple = load_spec(Store.APPLE)
    assert apple.find_exact(1242, 2688).id == "apple-iphone-6.5-legacy"
    assert apple.find_exact(1284, 2778).id == "apple-iphone-6.5"


def test_exact_match_is_orientation_agnostic() -> None:
    apple = load_spec(Store.APPLE)
    assert apple.find_exact(2868, 1320).id == "apple-iphone-6.9"


def test_no_match_returns_none() -> None:
    assert load_spec(Store.APPLE).find_exact(123, 456) is None


def test_nearest_never_returns_a_legacy_size() -> None:
    apple = load_spec(Store.APPLE)
    for width, height in [(1242, 2688), (640, 1136), (1000, 2000)]:
        nearest = apple.nearest(width, height)
        assert nearest is not None
        assert nearest.status in {"required", "accepted"}


def test_apple_sizes_all_violate_the_play_ratio_rule() -> None:
    """Documents why `--store both` on one directory is not a sensible default."""
    play_ratio = load_spec(Store.GOOGLE).rules.max_side_ratio
    assert play_ratio is not None

    iphones = [
        s
        for s in load_spec(Store.APPLE).sizes
        if s.device_class.startswith("iPhone") and s.status in {"required", "accepted"}
    ]
    tall = [s for s in iphones if s.portrait[1] > s.portrait[0] * play_ratio]
    assert tall, "expected modern iPhone sizes to exceed Play's 2:1 ceiling"


def test_label_is_human_readable() -> None:
    assert load_spec(Store.APPLE).get("apple-iphone-6.9").label == 'iPhone 6.9" (1320x2868)'
