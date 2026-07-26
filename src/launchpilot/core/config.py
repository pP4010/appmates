"""Runtime settings.

Reads ``LAUNCHPILOT_*`` environment variables and an optional ``.env``. The
credential fields are unused by the current commands — they are declared now so
the API-backed services in the next milestone have a settled home rather than
growing their own ad-hoc config.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LAUNCHPILOT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- behaviour ---
    strict: bool = Field(
        default=False,
        description="Treat warnings as errors (exit code 1).",
    )
    max_screenshot_bytes: int = Field(
        default=8 * 1024 * 1024,
        description="Override the Play per-screenshot size ceiling.",
    )

    # --- credentials, reserved for the API-backed services ---
    google_play_service_account_json: Path | None = None
    app_store_key_id: str | None = None
    app_store_issuer_id: str | None = None
    app_store_private_key_path: Path | None = None

    @property
    def has_google_credentials(self) -> bool:
        return self.google_play_service_account_json is not None

    @property
    def has_apple_credentials(self) -> bool:
        return all(
            (
                self.app_store_key_id,
                self.app_store_issuer_id,
                self.app_store_private_key_path,
            )
        )


def get_settings() -> Settings:
    """Not cached: tests and long-running API processes need to re-read env."""
    return Settings()
