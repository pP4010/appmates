"""Exceptions raised by the core.

The CLI maps these to exit code 2 (usage/input error) so they stay
distinguishable from "validation found problems", which is exit code 1.
"""

from __future__ import annotations


class LaunchPilotError(Exception):
    """Base class for every error raised deliberately by AppMates."""


class DirectoryNotFoundError(LaunchPilotError):
    def __init__(self, path: object) -> None:
        super().__init__(f"Directory not found: {path}")


class NoAssetsFoundError(LaunchPilotError):
    def __init__(self, path: object) -> None:
        super().__init__(f"No PNG or JPEG files found in {path}")


class UnreadableImageError(LaunchPilotError):
    def __init__(self, path: object, reason: str) -> None:
        super().__init__(f"Could not read image {path}: {reason}")


class MetadataParseError(LaunchPilotError):
    pass


class OutputExistsError(LaunchPilotError):
    def __init__(self, path: object) -> None:
        super().__init__(
            f"Output directory {path} is not empty. Pass --force to overwrite its contents."
        )


class SourceIsDestinationError(LaunchPilotError):
    """The fixer never edits in place; input and output must differ."""

    def __init__(self, path: object) -> None:
        super().__init__(
            f"Refusing to write over the source directory {path}. "
            "Pass a different --out directory; originals are never modified."
        )
