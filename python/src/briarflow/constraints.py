"""Constraint and metadata markers for ``typing.Annotated``.

Only numbers and lists take constraints. Text and media limits are static fields of the
built-in structs (``class ShortText(Text): max_length = 40``, see ``structs.py``).

Example:
    count: Annotated[int, Min(1), Max(8), Port(description="How many")]
"""

from __future__ import annotations

import math
from typing import Any, ClassVar

_NUMBER = frozenset({"int", "float"})
_LIST = frozenset({"list"})


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
