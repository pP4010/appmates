"""Store listing text, and the per-store length limits it must satisfy.

Text overruns are the second most common cause of a rejected or blocked
submission after malformed screenshots, and unlike screenshots the limits
differ per store — the same listing can pass Apple and fail Play.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from appmates.core.models.report import Store


class FieldLimit(BaseModel):
    name: str
    max_length: int
    required: bool = False


APPLE_LIMITS: dict[str, FieldLimit] = {
    "title": FieldLimit(name="App name", max_length=30, required=True),
    "subtitle": FieldLimit(name="Subtitle", max_length=30),
    "promotional_text": FieldLimit(name="Promotional text", max_length=170),
    "description": FieldLimit(name="Description", max_length=4000, required=True),
    "keywords": FieldLimit(name="Keywords", max_length=100),
}

GOOGLE_LIMITS: dict[str, FieldLimit] = {
    "title": FieldLimit(name="App name", max_length=30, required=True),
    "short_description": FieldLimit(name="Short description", max_length=80, required=True),
    "description": FieldLimit(name="Full description", max_length=4000, required=True),
}

LIMITS: dict[Store, dict[str, FieldLimit]] = {
    Store.APPLE: APPLE_LIMITS,
    Store.GOOGLE: GOOGLE_LIMITS,
}


class AppMetadata(BaseModel):
    """One locale's store listing.

    Fields are optional so a partially-filled listing can still be checked;
    the validator reports what is missing rather than refusing to parse.
    """

    locale: str = "en-US"
    title: str | None = None
    subtitle: str | None = None
    short_description: str | None = None
    description: str | None = None
    promotional_text: str | None = None
    keywords: str | None = None

    def field_value(self, key: str) -> str | None:
        return getattr(self, key, None)


class AppListing(BaseModel):
    """A whole listing: the app plus every localisation of its text."""

    package_name: str | None = None
    bundle_id: str | None = None
    locales: list[AppMetadata] = Field(default_factory=list)
