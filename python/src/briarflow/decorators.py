"""``@node``, ``@struct`` and ``@outputs``."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence, TypeVar, overload

F = TypeVar("F", bound=Callable[..., Any])
C = TypeVar("C", bound=type)


@dataclass
class NodeOptions:
    type: str | None = None
    title: str | None = None
    category: str | None = None
    description: str | None = None
    cache: bool = True
    timeout_ms: int = 300_000
    retry: int | Mapping[str, Any] = 0
    concurrency: int | None = None
    secrets: Sequence[str] = field(default_factory=tuple)
    icon: str | None = None
    color: str | None = None


@overload
def node(fn: F) -> F: ...
@overload
def node(
    fn: None = None,
    *,
    type: str | None = None,
    title: str | None = None,
    category: str | None = None,
    description: str | None = None,
    cache: bool = True,
    timeout_ms: int = 300_000,
    retry: int | Mapping[str, Any] = 0,
    concurrency: int | None = None,
    secrets: Sequence[str] = (),
    icon: str | None = None,
    color: str | None = None,
) -> Callable[[F], F]: ...


def node(
    fn: Any = None,
    *,
    type: str | None = None,  # noqa: A002 - public API name from the spec
    title: str | None = None,
    category: str | None = None,
    description: str | None = None,
    cache: bool = True,
    timeout_ms: int = 300_000,
    retry: int | Mapping[str, Any] = 0,
    concurrency: int | None = None,
    secrets: Sequence[str] = (),
    icon: str | None = None,
    color: str | None = None,
) -> Any:
    """Marks a function as a Briarflow node. Ports come from its signature.

    The function stays a plain callable; ``pack()`` reads the options and binds the types.

    Example:
        @node(title="Uppercase", category="Text")
        def uppercase(text: str) -> str:
            return text.upper()
    """
    opts = NodeOptions(
        type=type,
        title=title,
        category=category,
        description=description,
        cache=cache,
        timeout_ms=timeout_ms,
        retry=retry,
        concurrency=concurrency,
        secrets=tuple(secrets),
        icon=icon,
        color=color,
    )

    def decorate(f: F) -> F:
        if not callable(f):
            raise TypeError(f"@node can only decorate functions, got {f!r}")
        f.__briarflow_node__ = opts  # type: ignore[attr-defined]
        return f

    if fn is not None:
        return decorate(fn)
    return decorate


def _require_dataclass(cls: Any, deco: str) -> None:
    if not isinstance(cls, type) or not dataclasses.is_dataclass(cls):
        raise TypeError(
            f"{deco} must be applied to a dataclass; put {deco} above @dataclass "
            f"(got {getattr(cls, '__name__', cls)!r})"
        )


def struct(cls: C) -> C:
    """Makes a ``@dataclass`` a pack struct type named after the class.

    Example:
        @struct
        @dataclass
        class Character:
            name: Annotated[str, MaxLength(40)]
            age: int = 0
    """
    _require_dataclass(cls, "@struct")
    cls.__briarflow_struct__ = True  # type: ignore[attr-defined]
    return cls


def outputs(cls: C) -> C:
    """Marks a ``@dataclass`` used as a node return type: one output port per field."""
    _require_dataclass(cls, "@outputs")
    cls.__briarflow_outputs__ = True  # type: ignore[attr-defined]
    return cls
