"""Media references: values of the media primitives (image, video, audio, model3d, file)."""

from __future__ import annotations

import base64
import hashlib
from typing import Any, ClassVar

#: Media primitive -> required mime prefix (None = any mime). See types.md §8.
MEDIA_PRIMITIVES = ("image", "video", "audio", "model3d", "file")

#: Format name -> mime type (types.md §6).
FORMAT_MIMES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
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


def mime_matches_primitive(mime: str, primitive: str) -> bool:
    mime = mime.lower()
    if primitive == "image":
        return mime.startswith("image/")
    if primitive == "video":
        return mime.startswith("video/")
    if primitive == "audio":
        return mime.startswith("audio/")
    if primitive == "model3d":
        return mime.startswith("model/") or mime == "application/octet-stream"
    return True


def format_to_mime(fmt: str) -> str:
    return FORMAT_MIMES.get(fmt.lower(), fmt.lower())


class MediaRef:
    """A reference to stored media, as passed between nodes.

    Inputs arrive as instances of the port's media class (``Image``, ``Audio``…), which are
    all ``MediaRef`` subclasses. ``url`` is a temporary, fetchable URL added by the bridge
    for the duration of one execution; read the bytes with ``ctx.media.read(ref)``.

    Return an input ref unchanged to pass media through, or create new media with
    ``ctx.media.create(data, mime=...)``.
    """

    primitive: ClassVar[str | None] = None

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
    def _created(
        cls, data: bytes, mime: str, filename: str | None, meta: dict[str, Any]
    ) -> "MediaRef":
        ref = cls(
            uri="",
            mime=mime,
            bytes=len(data),
            hash=hashlib.sha256(data).hexdigest(),
            meta=meta or None,
        )
        ref._data = bytes(data)
        ref._filename = filename
        return ref

    @property
    def is_new(self) -> bool:
        """True for media created in this execution (not yet stored by the engine)."""
        return self._data is not None

    def to_json(self) -> dict[str, Any]:
        """Wire form: a MediaRef object, or ``{"$media": …}`` for newly created media."""
        if self._data is not None:
            payload: dict[str, Any] = {
                "mime": self.mime,
                "base64": base64.b64encode(self._data).decode("ascii"),
            }
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
        if not isinstance(other, MediaRef):
            return NotImplemented
        return self.to_json() == other.to_json()

    def __hash__(self) -> int:
        return hash((self.uri, self.mime, self.hash))

    def __repr__(self) -> str:
        if self._data is not None:
            return f"{type(self).__name__}(<new {self.mime}, {len(self._data)} bytes>)"
        return f"{type(self).__name__}(uri={self.uri!r}, mime={self.mime!r})"


class Image(MediaRef):
    """Media primitive ``image`` (mime ``image/*``)."""

    primitive = "image"
    __slots__ = ()


class Video(MediaRef):
    """Media primitive ``video`` (mime ``video/*``)."""

    primitive = "video"
    __slots__ = ()


class Audio(MediaRef):
    """Media primitive ``audio`` (mime ``audio/*``)."""

    primitive = "audio"
    __slots__ = ()


class Model3D(MediaRef):
    """Media primitive ``model3d`` (mime ``model/*`` or ``application/octet-stream``)."""

    primitive = "model3d"
    __slots__ = ()


class File(MediaRef):
    """Media primitive ``file`` (any mime)."""

    primitive = "file"
    __slots__ = ()


MEDIA_CLASSES: dict[str, type[MediaRef]] = {
    "image": Image,
    "video": Video,
    "audio": Audio,
    "model3d": Model3D,
    "file": File,
}
