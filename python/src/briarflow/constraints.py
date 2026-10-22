"""Constraint and metadata markers for ``typing.Annotated``.

Example:
    name: Annotated[str, MaxLength(40), Port(description="Display name")]
"""

from __future__ import annotations

import math
import re
from typing import Any, ClassVar

_TEXT = frozenset({"text"})
_NUMBER = frozenset({"int", "float"})
_LIST = frozenset({"list"})
_MEDIA = frozenset({"image", "video", "audio", "model3d", "file"})
_IMAGE = frozenset({"image"})
_TIMED = frozenset({"video", "audio"})


class Constraint:
    """Base class of constraint markers. ``key`` is the IR constraint name."""

    key: ClassVar[str]
    applies_to: ClassVar[frozenset[str]]
    __slots__ = ("value",)

    def __init__(self, value: Any) -> None:
        self.value = value

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.value!r})"

    def __eq__(self, other: object) -> bool:
        return type(other) is type(self) and other.value == self.value  # type: ignore[attr-defined]

    def __hash__(self) -> int:
        return hash((type(self), repr(self.value)))


def _non_negative_int(name: str, n: Any) -> int:
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        raise ValueError(f"{name}() needs a whole number >= 0, got {n!r}")
    return n


def _number(name: str, n: Any) -> int | float:
    if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n):
        raise ValueError(f"{name}() needs a finite number, got {n!r}")
    return n


class MinLength(Constraint):
    """Text: minimum length in code points."""

    key = "minLength"
    applies_to = _TEXT
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MinLength", n))


class MaxLength(Constraint):
    """Text: maximum length in code points."""

    key = "maxLength"
    applies_to = _TEXT
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MaxLength", n))


class Pattern(Constraint):
    """Text: regex the whole string must match (ECMAScript syntax; keep to the common subset)."""

    key = "pattern"
    applies_to = _TEXT
    __slots__ = ()

    def __init__(self, regex: str) -> None:
        if not isinstance(regex, str):
            raise ValueError(f"Pattern() needs a string, got {regex!r}")
        try:
            re.compile(regex)
        except re.error as exc:
            raise ValueError(f"Pattern({regex!r}) does not compile: {exc}") from None
        super().__init__(regex)


class Multiline(Constraint):
    """Text: UI hint to edit the value in a multi-line box. Never validated."""

    key = "multiline"
    applies_to = _TEXT
    __slots__ = ()

    def __init__(self, enabled: bool = True) -> None:
        super().__init__(bool(enabled))


class Min(Constraint):
    """int/float: inclusive minimum."""

    key = "min"
    applies_to = _NUMBER
    __slots__ = ()

    def __init__(self, n: int | float) -> None:
        super().__init__(_number("Min", n))


class Max(Constraint):
    """int/float: inclusive maximum."""

    key = "max"
    applies_to = _NUMBER
    __slots__ = ()

    def __init__(self, n: int | float) -> None:
        super().__init__(_number("Max", n))


class MinItems(Constraint):
    """list: minimum number of items."""

    key = "minItems"
    applies_to = _LIST
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MinItems", n))


class MaxItems(Constraint):
    """list: maximum number of items."""

    key = "maxItems"
    applies_to = _LIST
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MaxItems", n))


class Formats(Constraint):
    """Media: allowed formats (``"png"``, ``"jpeg"``… or literal mime types)."""

    key = "formats"
    applies_to = _MEDIA
    __slots__ = ()

    def __init__(self, *formats: str) -> None:
        if not formats or not all(isinstance(f, str) and f for f in formats):
            raise ValueError(f"Formats() needs one or more non-empty strings, got {formats!r}")
        super().__init__(list(formats))


class MaxBytes(Constraint):
    """Media: maximum size in bytes (checked when ``bytes`` is known)."""

    key = "maxBytes"
    applies_to = _MEDIA
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MaxBytes", n))


class MinWidth(Constraint):
    """Image: minimum width in px (checked when ``meta.width`` is known)."""

    key = "minWidth"
    applies_to = _IMAGE
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MinWidth", n))


class MaxWidth(Constraint):
    """Image: maximum width in px."""

    key = "maxWidth"
    applies_to = _IMAGE
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MaxWidth", n))


class MinHeight(Constraint):
    """Image: minimum height in px."""

    key = "minHeight"
    applies_to = _IMAGE
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MinHeight", n))


class MaxHeight(Constraint):
    """Image: maximum height in px."""

    key = "maxHeight"
    applies_to = _IMAGE
    __slots__ = ()

    def __init__(self, n: int) -> None:
        super().__init__(_non_negative_int("MaxHeight", n))


class MaxDurationSec(Constraint):
    """Video/audio: maximum duration in seconds (checked when ``meta.durationSec`` is known)."""

    key = "maxDurationSec"
    applies_to = _TIMED
    __slots__ = ()

    def __init__(self, n: int | float) -> None:
        v = _number("MaxDurationSec", n)
        if v < 0:
            raise ValueError(f"MaxDurationSec() needs a number >= 0, got {n!r}")
        super().__init__(v)


class Port:
    """Port or struct-field metadata.

    Example:
        prompt: Annotated[str, Port(title="Prompt", description="What to draw")]
    """

    __slots__ = ("title", "description")

    def __init__(self, title: str | None = None, description: str | None = None) -> None:
        self.title = title
        self.description = description

    def merged(self, other: "Port | None") -> "Port":
        if other is None:
            return self
        return Port(
            title=self.title if self.title is not None else other.title,
            description=self.description if self.description is not None else other.description,
        )

    def __repr__(self) -> str:
        return f"Port(title={self.title!r}, description={self.description!r})"
