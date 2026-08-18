"""Suggested prices per storefront, from one base price and a chosen model.

Apple and Google let you set a different price per storefront but give no
guidance on what to set it to. This turns one price into a starting point per
territory — a sanity check to copy into App Store Connect / Play Console
yourself, never a push to either API.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from appmates.core.services.market_scanner import COUNTRY_NAMES
from appmates.core.specs.registry import PricingSpec, load_pricing_spec


class TerritoryPrice(BaseModel):
    country: str
    country_name: str
    tier_id: str | None = None
    tier_label: str | None = None
    multiplier: float = 1.0
    suggested_price: float


class PricingPlan(BaseModel):
    base_price: float
    base_country: str
    model: str
    territories: list[TerritoryPrice] = Field(default_factory=list)


def suggest_prices(
    base_price: float,
    *,
    base_country: str = "us",
    model: str = "ppp_tier",
    countries: list[str] | None = None,
    spec: PricingSpec | None = None,
) -> PricingPlan:
    """Suggest a price per storefront.

    ``countries`` defaults to every storefront ``market_scanner.COUNTRY_NAMES``
    knows about. A country with no tier is priced at the base rate under
    every model, rather than guessed at.
    """
    spec = spec or load_pricing_spec()
    if model not in spec.models:
        choices = ", ".join(spec.models)
        raise ValueError(f"Unknown pricing model {model!r}. Choose from: {choices}.")

    codes = [c.lower() for c in (countries or COUNTRY_NAMES.keys())]
    territories = []
    for code in codes:
        tier = spec.tier_for(code)
        multiplier = tier.multiplier if (tier and model == "ppp_tier") else 1.0
        territories.append(
            TerritoryPrice(
                country=code,
                country_name=COUNTRY_NAMES.get(code, code.upper()),
                tier_id=tier.id if tier else None,
                tier_label=tier.label if tier else None,
                multiplier=multiplier,
                suggested_price=round(base_price * multiplier, 2),
            )
        )

    return PricingPlan(
        base_price=base_price,
        base_country=base_country.lower(),
        model=model,
        territories=territories,
    )
