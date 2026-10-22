"""``ExecContext``: what a node receives as its keyword-only ``ctx`` argument."""

from __future__ import annotations

import math
import threading
import urllib.error
import urllib.request
from typing import Any, BinaryIO, Callable, Iterator, Mapping

from .errors import Cancelled, NodeError
from .media import MEDIA_CLASSES, MediaRef

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


class MediaHelper:
    """Reads input media and creates output media."""

    def __init__(self, timeout: float = 60.0) -> None:
        self._timeout = timeout

    def _url(self, ref: MediaRef) -> str:
        if not isinstance(ref, MediaRef):
            raise TypeError(f"expected a MediaRef, got {type(ref).__name__}")
        if not ref.url:
            raise NodeError(
                "node.invalid_input",
                f"Media {ref.uri or ref.mime} has no fetchable url; the bridge adds one to every "
                f"input MediaRef.",
            )
        return ref.url

    def read(self, ref: MediaRef) -> bytes:
        """Downloads the media bytes (GET ``ref.url``)."""
        if ref.is_new:
            return bytes(ref._data or b"")
        with self.open(ref) as fh:
            return fh.read()

    def open(self, ref: MediaRef) -> BinaryIO:
        """Streaming variant of ``read``; use as a context manager."""
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

    def create(
        self, data: bytes, mime: str, filename: str | None = None, **meta: Any
    ) -> MediaRef:
        """Creates new media from bytes. Return it from the node (or inside a struct/list).

        Example:
            return ctx.media.create(png_bytes, mime="image/png", width=64, height=64)
        """
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError(f"media.create needs bytes, got {type(data).__name__}")
        if not isinstance(mime, str) or "/" not in mime:
            raise ValueError(f"media.create needs a mime type like 'image/png', got {mime!r}")
        mime = mime.lower()
        kind = mime.split("/", 1)[0]
        cls = {"image": "image", "video": "video", "audio": "audio", "model": "model3d"}.get(kind, "file")
        return MEDIA_CLASSES[cls]._created(bytes(data), mime, filename, dict(meta))


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
