"""Shared fixtures.

Test images are generated at run time rather than committed. Binary fixtures
would bloat the repo, cannot be diffed in review, and hide the very properties
(mode, size, alpha) each test is about — building them inline keeps the
intent of every case readable.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from PIL import Image

from appmates.core.models.testing import DailyTesterCount

# Convenience aliases for sizes used across the suite.
APPLE_6_5 = (1284, 2778)
APPLE_6_9 = (1320, 2868)
APPLE_LEGACY_6_5 = (1242, 2688)
PLAY_FHD = (1080, 1920)

MakeImage = Callable[..., Path]


@pytest.fixture
def make_image(tmp_path: Path) -> MakeImage:
    """Factory writing a single image and returning its path.

    ``padding_bytes`` inflates the file by appending a PNG text chunk, which is
    how the size-limit rules get exercised without generating an actual 8 MB
    image.
    """

    def _make(
        name: str = "shot.png",
        size: tuple[int, int] = APPLE_6_5,
        mode: str = "RGB",
        fmt: str | None = None,
        color: str | tuple[int, ...] = "navy",
        directory: Path | None = None,
        padding_bytes: int = 0,
    ) -> Path:
        target_dir = directory or tmp_path
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / name

        img = Image.new(mode, size, color)  # type: ignore[arg-type]
        image_format = fmt or ("JPEG" if path.suffix.lower() in {".jpg", ".jpeg"} else "PNG")

        if image_format == "PNG" and padding_bytes:
            from PIL import PngImagePlugin

            meta = PngImagePlugin.PngInfo()
            meta.add_text("pad", "x" * padding_bytes)
            img.save(path, format=image_format, pnginfo=meta)
        else:
            img.save(path, format=image_format)
        return path

    return _make


@pytest.fixture
def screenshot_dir(tmp_path: Path, make_image: MakeImage) -> Path:
    """A directory of three valid Apple 6.5" screenshots."""
    directory = tmp_path / "shots"
    for i in range(1, 4):
        make_image(name=f"shot{i}.png", size=APPLE_6_5, directory=directory)
    return directory


@pytest.fixture
def asc_key_path(tmp_path: Path) -> Path:
    """A throwaway ES256 (`.p8`-shaped) keypair, generated fresh per test —
    never a value that resembles a real Apple App Store Connect key."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    path = tmp_path / "AuthKey_TEST.p8"
    path.write_bytes(pem)
    path.chmod(0o600)
    return path


@pytest.fixture
def today() -> dt.date:
    """Fixed date so streak arithmetic never depends on when the suite runs."""
    return dt.date(2026, 7, 26)


@pytest.fixture
def history_factory(today: dt.date) -> Callable[..., list[DailyTesterCount]]:
    """Build a contiguous timeline ending today from a list of daily counts."""

    def _make(counts: list[int], end: dt.date | None = None) -> list[DailyTesterCount]:
        last = end or today
        n = len(counts)
        return [
            DailyTesterCount(date=last - dt.timedelta(days=n - 1 - i), opted_in=c)
            for i, c in enumerate(counts)
        ]

    return _make
