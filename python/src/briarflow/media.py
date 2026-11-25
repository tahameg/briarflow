"""``Binary``: the value of the ``binary`` primitive (bytes held by the engine's media registry)."""

from __future__ import annotations

import base64
import hashlib
from typing import Any

#: Media kinds of the built-in media structs (types.md §1.2).
MEDIA_KINDS = ("image", "video", "audio", "model3d", "file")

#: Format name -> mime type (types.md §1.2).
FORMAT_MIMES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "glb": "model/gltf-binary",
    "gltf": "model/gltf+json",
    "obj": "model/obj",
    "stl": "model/stl",
    "pdf": "application/pdf",
    "json": "application/json",
    "txt": "text/plain",
}


def mime_matches_kind(mime: str, kind: str) -> bool:
    """Does ``mime`` fit the media kind (``image`` needs ``image/*``…)?"""
    mime = mime.lower()
    if kind == "image":
        return mime.startswith("image/")
    if kind == "video":
        return mime.startswith("video/")
    if kind == "audio":
        return mime.startswith("audio/")
    if kind == "model3d":
        return mime.startswith("model/") or mime == "application/octet-stream"
    return True


def format_to_mime(fmt: str) -> str:
    return FORMAT_MIMES.get(fmt.lower(), fmt.lower())


class Binary:
    """Bytes held by the engine: the value of the ``binary`` primitive.

    The ``data`` member of ``Image``, ``Video``… is a ``Binary``. Inputs arrive with a
    temporary ``url`` added by the bridge for one execution; read the bytes with
    ``ctx.media.read(value)``. Return an input value unchanged to pass it through, or make new
    media with ``ctx.media.create(data, mime=...)``.
    """

    __slots__ = ("uri", "mime", "bytes", "hash", "meta", "url", "_data", "_filename")

    def __init__(
        self,
        uri: str,
        mime: str,
        bytes: int | None = None,  # noqa: A002 - mirrors the wire field name
        hash: str | None = None,  # noqa: A002
        meta: dict[str, Any] | None = None,
        url: str | None = None,
    ) -> None:
        self.uri = uri
        self.mime = mime
        self.bytes = bytes
        self.hash = hash
        self.meta = dict(meta) if meta else None
        self.url = url
        self._data: bytes | None = None
        self._filename: str | None = None

    @classmethod
    def created(
        cls, data: bytes, mime: str, filename: str | None = None, meta: dict[str, Any] | None = None
    ) -> "Binary":
        """New bytes made in this execution; the engine stores them when the node returns."""
        ref = cls(uri="", mime=mime, bytes=len(data), hash=hashlib.sha256(data).hexdigest(), meta=meta or None)
        ref._data = bytes(data)
        ref._filename = filename
        return ref

    @property
    def is_new(self) -> bool:
        """True for bytes created in this execution (not yet stored by the engine)."""
        return self._data is not None

    def to_json(self) -> dict[str, Any]:
        """Wire form: ``{uri, mime…}`` for stored bytes, ``{"$media": …}`` for new ones."""
        if self._data is not None:
            payload: dict[str, Any] = {"mime": self.mime, "base64": base64.b64encode(self._data).decode("ascii")}
            if self._filename:
                payload["filename"] = self._filename
            if self.meta:
                payload["meta"] = dict(self.meta)
            return {"$media": payload}
        out: dict[str, Any] = {"uri": self.uri, "mime": self.mime}
        if self.bytes is not None:
            out["bytes"] = self.bytes
        if self.hash is not None:
            out["hash"] = self.hash
        if self.meta is not None:
            out["meta"] = dict(self.meta)
        return out

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Binary):
            return NotImplemented
        return self.to_json() == other.to_json()

    def __hash__(self) -> int:
        return hash((self.uri, self.mime, self.hash))

    def __repr__(self) -> str:
        if self._data is not None:
            return f"Binary(<new {self.mime}, {len(self._data)} bytes>)"
        return f"Binary(uri={self.uri!r}, mime={self.mime!r})"
