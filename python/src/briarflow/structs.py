"""The built-in structs (types.md §1.2): ``Text``, ``Image``, ``Video``, ``Audio``, ``Model3D``,
``File``, ``Json``, ``Secret``, ``ApiKey`` and ``Error``, the same as the engine's ``briar.*``.

Their limits are **static members**: class attributes the type fixes, not values. A struct that
extends one gives them other values::

    @struct
    class ShortText(Text):
        max_length = 80

    @struct
    class Thumbnail(Image):
        formats = ("png", "webp")
        max_width = 512

``ShortText`` is accepted wherever ``Text`` is. Unlimited text is a plain ``str``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Any, ClassVar, Optional

from .media import Binary

BUILTIN_ATTR = "__briarflow_builtin__"
WIRE_ATTR = "__briarflow_wire__"


def _builtin(type_id: str, wire: dict[str, str] | None = None):
    """Marks a class as the built-in struct or enum ``type_id``."""

    def mark(cls: type) -> type:
        type.__setattr__(cls, BUILTIN_ATTR, type_id)
        if not issubclass(cls, Enum):
            type.__setattr__(cls, "__briarflow_struct__", True)
        type.__setattr__(cls, WIRE_ATTR, dict(wire or {}))
        return cls

    return mark


@_builtin("briar.Text", {"min_length": "minLength", "max_length": "maxLength"})
@dataclass
class Text:
    """Text with limits, for what people type. ``value`` is the text."""

    value: str
    min_length: ClassVar[int] = 0
    max_length: ClassVar[Optional[int]] = None
    pattern: ClassVar[Optional[str]] = None
    multiline: ClassVar[bool] = False

    def __str__(self) -> str:
        return self.value


_MEDIA_WIRE = {
    "max_bytes": "maxBytes",
    "min_width": "minWidth",
    "max_width": "maxWidth",
    "min_height": "minHeight",
    "max_height": "maxHeight",
    "max_duration": "maxDuration",
}


@_builtin("briar.Image", _MEDIA_WIRE)
@dataclass
class Image:
    """A picture. ``data`` holds the bytes; read them with ``ctx.media.read(image)``."""

    data: Binary
    mime: str
    name: Optional[str] = None
    size: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    formats: ClassVar[tuple[str, ...]] = ()
    max_bytes: ClassVar[Optional[int]] = None
    min_width: ClassVar[Optional[int]] = None
    max_width: ClassVar[Optional[int]] = None
    min_height: ClassVar[Optional[int]] = None
    max_height: ClassVar[Optional[int]] = None


@_builtin("briar.Video", _MEDIA_WIRE)
@dataclass
class Video:
    """A video."""

    data: Binary
    mime: str
    name: Optional[str] = None
    size: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    duration: Optional[float] = None
    fps: Optional[float] = None
    formats: ClassVar[tuple[str, ...]] = ()
    max_bytes: ClassVar[Optional[int]] = None
    max_duration: ClassVar[Optional[float]] = None


@_builtin("briar.Audio", _MEDIA_WIRE)
@dataclass
class Audio:
    """A sound."""

    data: Binary
    mime: str
    name: Optional[str] = None
    size: Optional[int] = None
    duration: Optional[float] = None
    formats: ClassVar[tuple[str, ...]] = ()
    max_bytes: ClassVar[Optional[int]] = None
    max_duration: ClassVar[Optional[float]] = None


@_builtin("briar.Model3D", _MEDIA_WIRE)
@dataclass
class Model3D:
    """A 3D model."""

    data: Binary
    mime: str
    name: Optional[str] = None
    size: Optional[int] = None
    formats: ClassVar[tuple[str, ...]] = ()
    max_bytes: ClassVar[Optional[int]] = None


@_builtin("briar.File", _MEDIA_WIRE)
@dataclass
class File:
    """Any file."""

    data: Binary
    mime: str
    name: Optional[str] = None
    size: Optional[int] = None
    formats: ClassVar[tuple[str, ...]] = ()
    max_bytes: ClassVar[Optional[int]] = None


@_builtin("briar.Json")
@dataclass
class Json:
    """A JSON document, as text. ``Json.of(data)`` makes one, ``.parse()`` reads it."""

    text: str

    @classmethod
    def of(cls, data: Any) -> "Json":
        return cls(json.dumps(data, ensure_ascii=False))

    def parse(self) -> Any:
        return json.loads(self.text)


@_builtin("briar.SecretKind")
class SecretKind(str, Enum):
    """Which secrets a picker offers."""

    API_KEY = "apiKey"
    TEXT = "text"
    NUMBER = "number"
    JSON = "json"


@_builtin("briar.Secret")
@dataclass
class Secret:
    """The name of a secret in the vault (its value never travels in a graph)."""

    name: str
    kind: ClassVar[Optional[SecretKind]] = None


@_builtin("briar.ApiKey")
@dataclass
class ApiKey(Secret):
    """An API key in the vault."""

    kind: ClassVar[Optional[SecretKind]] = SecretKind.API_KEY


@_builtin("briar.Error", {"node_id": "nodeId"})
@dataclass
class Error:
    """Why a node failed."""

    code: str
    message: str
    node: Optional[str] = None
    node_id: Optional[str] = None
    details: Optional[Json] = None


#: Media struct class -> media kind.
MEDIA_STRUCTS: dict[type, str] = {Image: "image", Video: "video", Audio: "audio", Model3D: "model3d", File: "file"}

BUILTIN_CLASSES: tuple[type, ...] = (Text, Image, Video, Audio, Model3D, File, Json, SecretKind, Secret, ApiKey, Error)

#: Names no pack type may use (the engine's built-in names).
BUILTIN_NAMES = frozenset(c.__name__ for c in BUILTIN_CLASSES)


def builtin_id(cls: type) -> str | None:
    """The ``briar.*`` id when ``cls`` itself is a built-in (not a struct extending one)."""
    value = cls.__dict__.get(BUILTIN_ATTR)
    return value if isinstance(value, str) else None


def builtin_root(cls: type) -> type | None:
    """The built-in class ``cls`` is or extends (nearest first), if any."""
    for base in cls.__mro__:
        if builtin_id(base) is not None and base is not object:
            return base
    return None


def media_kind_of(cls: type) -> str | None:
    """``image`` for ``Image`` and every struct extending it, …; None for non-media."""
    for base in cls.__mro__:
        kind = MEDIA_STRUCTS.get(base)
        if kind is not None:
            return kind
    return None


def wire_name(cls: type, py_name: str) -> str:
    """The engine's member name for a Python attribute (``max_length`` -> ``maxLength``)."""
    for base in cls.__mro__:
        table = base.__dict__.get(WIRE_ATTR)
        if isinstance(table, dict) and py_name in table:
            return table[py_name]
    return py_name


__all__ = [
    "Text",
    "Image",
    "Video",
    "Audio",
    "Model3D",
    "File",
    "Json",
    "SecretKind",
    "Secret",
    "ApiKey",
    "Error",
    "MEDIA_STRUCTS",
    "BUILTIN_CLASSES",
    "BUILTIN_NAMES",
    "builtin_id",
    "builtin_root",
    "media_kind_of",
    "wire_name",
]
