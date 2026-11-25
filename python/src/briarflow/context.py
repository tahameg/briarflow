"""``ExecContext``: what a node receives as its keyword-only ``ctx`` argument."""

from __future__ import annotations

import math
import threading
import urllib.error
import urllib.request
from typing import Any, BinaryIO, Callable, Iterator, Mapping

from .errors import Cancelled, NodeError
from .media import Binary
from .structs import Audio, File, Image, Model3D, Video

LOG_LEVELS = ("debug", "info", "warn", "error")
_LEVEL_ALIASES = {"warning": "warn", "err": "error", "critical": "error", "fatal": "error"}

Emit = Callable[[dict[str, Any]], bool]


class Secrets(Mapping[str, str]):
    """Read-only mapping of the secrets a node declared with ``@node(secrets=[...])``."""

    def __init__(self, declared: tuple[str, ...], values: Mapping[str, str]) -> None:
        self._declared = declared
        self._values = {k: v for k, v in values.items() if k in declared}

    def __getitem__(self, name: str) -> str:
        if name not in self._declared:
            raise NodeError(
                "node.secret_not_declared",
                f'Secret "{name}" is not declared by this node. Add it to @node(secrets=[...]).',
            )
        if name not in self._values:
            raise NodeError(
                "node.missing_secret",
                f'Secret "{name}" was not provided. Set it in your secrets provider '
                f"(e.g. env var {name}).",
            )
        return self._values[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __contains__(self, name: object) -> bool:
        return name in self._values

    def __repr__(self) -> str:
        return f"Secrets({sorted(self._values)})"


_KIND_CLASSES: dict[str, type] = {"image": Image, "video": Video, "audio": Audio, "model": Model3D}

Media = Any  # Image | Video | Audio | Model3D | File, or a struct extending one


def _binary(value: Any) -> Binary:
    """The ``Binary`` of a media struct value (its ``data``), or the value itself."""
    data = getattr(value, "data", value)
    if not isinstance(data, Binary):
        raise TypeError(f"expected media (Image, Video…) or Binary, got {type(value).__name__}")
    return data


def _num(meta: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = meta.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
    return None


class MediaHelper:
    """Reads input media and creates output media."""

    def __init__(self, timeout: float = 60.0) -> None:
        self._timeout = timeout

    def _url(self, ref: Binary) -> str:
        if not ref.url:
            raise NodeError(
                "node.invalid_input",
                f"Media {ref.uri or ref.mime} has no fetchable url; the bridge adds one to every "
                f"input media value.",
            )
        return ref.url

    def read(self, value: Media | Binary) -> bytes:
        """Downloads the bytes of a media value (``image``) or of a ``Binary``."""
        ref = _binary(value)
        if ref.is_new:
            return bytes(ref._data or b"")
        with self.open(ref) as fh:
            return fh.read()

    def open(self, value: Media | Binary) -> BinaryIO:
        """Streaming variant of ``read``; use as a context manager."""
        ref = _binary(value)
        if ref.is_new:
            import io

            return io.BytesIO(ref._data or b"")
        url = self._url(ref)
        try:
            return urllib.request.urlopen(url, timeout=self._timeout)  # noqa: S310 - bridge-provided URL
        except urllib.error.HTTPError as exc:
            raise NodeError(
                "node.unavailable" if exc.code >= 500 else "node.invalid_input",
                f"Could not fetch media {ref.uri}: HTTP {exc.code}",
                retryable=exc.code >= 500,
            ) from None
        except (urllib.error.URLError, OSError) as exc:
            raise NodeError(
                "node.unavailable", f"Could not fetch media {ref.uri}: {exc}", retryable=True
            ) from None

    def create(self, data: bytes, mime: str, filename: str | None = None, **meta: Any) -> Media:
        """Creates new media from bytes: an ``Image`` for ``image/*``, a ``Video``, ``Audio``,
        ``Model3D`` or else a ``File``. Return it from the node (or inside a struct/list).
        ``width``, ``height``, ``duration`` and ``fps`` in ``meta`` fill those members.

        Example:
            return ctx.media.create(png_bytes, mime="image/png", width=64, height=64)
        """
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError(f"media.create needs bytes, got {type(data).__name__}")
        if not isinstance(mime, str) or "/" not in mime:
            raise ValueError(f"media.create needs a mime type like 'image/png', got {mime!r}")
        mime = mime.lower()
        raw = bytes(data)
        ref = Binary.created(raw, mime, filename, dict(meta))
        cls = _KIND_CLASSES.get(mime.split("/", 1)[0], File)
        if mime == "application/octet-stream":
            cls = File
        values: dict[str, Any] = {"data": ref, "mime": mime, "name": filename, "size": len(raw)}
        if cls in (Image, Video):
            values["width"] = _num(meta, "width")
            values["height"] = _num(meta, "height")
        if cls in (Video, Audio):
            values["duration"] = _num(meta, "duration", "durationSec")
        if cls is Video:
            values["fps"] = _num(meta, "fps")
        return cls(**values)


class ExecContext:
    """Per-execution context injected as the keyword-only ``ctx`` parameter.

    When the bridge disconnects (cancel or timeout) ``cancelled`` becomes True and
    ``progress()`` raises ``Cancelled``. A node may raise ``Cancelled`` itself; if the bridge
    is still connected the engine then sees a ``node.cancelled`` error.

    Example:
        @node
        def slow(n: int, *, ctx: ExecContext) -> int:
            for i in range(n):
                ctx.progress(i / n, f"step {i}")   # raises Cancelled once cancelled
            return n
    """

    def __init__(
        self,
        *,
        run_id: str = "",
        node_id: str = "",
        node_type: str = "",
        attempt: int = 1,
        timeout_ms: int | None = None,
        secrets: Secrets | None = None,
        emit: Emit | None = None,
        cancel_event: threading.Event | None = None,
        media: MediaHelper | None = None,
    ) -> None:
        self.run_id = run_id
        self.node_id = node_id
        self.node_type = node_type
        self.attempt = attempt
        self.timeout_ms = timeout_ms
        self.secrets: Mapping[str, str] = secrets if secrets is not None else Secrets((), {})
        self.media = media or MediaHelper()
        self._emit: Emit = emit or (lambda line: True)
        self._cancel = cancel_event or threading.Event()

    @property
    def cancelled(self) -> bool:
        """True once the bridge has disconnected (cancel or timeout)."""
        return self._cancel.is_set()

    def progress(self, fraction: float, message: str | None = None) -> None:
        """Reports progress in [0, 1]. Raises ``Cancelled`` if the execution was cancelled."""
        if self.cancelled:
            raise Cancelled()
        try:
            f = float(fraction)
        except (TypeError, ValueError):
            f = math.nan
        if not math.isnan(f):
            line: dict[str, Any] = {"type": "progress", "fraction": min(1.0, max(0.0, f))}
            if message is not None:
                line["message"] = str(message)
            self._emit(line)
        if self.cancelled:
            raise Cancelled()

    def log(self, level: str, message: str, **data: Any) -> None:
        """Sends a log line to the engine. ``level`` is debug, info, warn or error."""
        lvl = _LEVEL_ALIASES.get(str(level).lower(), str(level).lower())
        if lvl not in LOG_LEVELS:
            raise ValueError(f"log level must be one of {', '.join(LOG_LEVELS)}, got {level!r}")
        line: dict[str, Any] = {"type": "log", "level": lvl, "message": str(message)}
        if data:
            line["data"] = data
        self._emit(line)
