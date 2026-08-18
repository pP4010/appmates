"""Tests for suggest_prices."""

from __future__ import annotations

import pytest

from launchpilot.core.services.pricing_calculator import suggest_prices


def test_uniform_model_charges_the_same_everywhere() -> None:
    plan = suggest_prices(10.0, model="uniform", countries=["us", "in", "br"])
    assert all(t.multiplier == 1.0 for t in plan.territories)
    assert all(t.suggested_price == 10.0 for t in plan.territories)


def test_ppp_tier_scales_lower_income_storefronts_down() -> None:
    plan = suggest_prices(10.0, model="ppp_tier", countries=["us", "in"])
    by_country = {t.country: t for t in plan.territories}
    assert by_country["us"].suggested_price == 10.0
    assert by_country["in"].suggested_price < 10.0
    assert by_country["in"].tier_id == "tier_3"


def test_unclassified_country_falls_back_to_base_rate() -> None:
    plan = suggest_prices(10.0, model="ppp_tier", countries=["zz"])
    territory = plan.territories[0]
    assert territory.tier_id is None
    assert territory.suggested_price == 10.0


def test_unknown_model_raises() -> None:
    with pytest.raises(ValueError, match="Unknown pricing model"):
        suggest_prices(10.0, model="bogus")


def test_default_countries_cover_the_whole_known_list() -> None:
    plan = suggest_prices(1.0)
    assert len(plan.territories) >= 14
    assert {t.country for t in plan.territories} >= {"us", "in", "br"}


def test_price_is_rounded_to_cents() -> None:
    plan = suggest_prices(9.99, model="ppp_tier", countries=["in"])
    price = plan.territories[0].suggested_price
    assert round(price, 2) == price
