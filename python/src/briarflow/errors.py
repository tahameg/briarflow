"""Exceptions a node may raise."""

from __future__ import annotations

from typing import Any, Mapping


class NodeError(Exception):
    """An expected node failure, reported to the engine with a stable code.

    Example:
        raise NodeError("node.rate_limited", "Provider asked us to slow down.", retryable=True)
    """

    def __init__(
        self,
        code: str,
        message: str,
        retryable: bool = False,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details: dict[str, Any] = dict(details or {})

    def to_line(self) -> dict[str, Any]:
        return {
            "type": "error",
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "details": self.details,
        }


class Cancelled(Exception):
    """Raised by ``ctx.progress()`` once the engine has cancelled the execution.

    A node may raise it itself to stop early; while the bridge is still connected the worker
    then reports a terminal ``node.cancelled`` error line.
    """

    DEFAULT_MESSAGE = "Execution was cancelled."

    def __init__(self, message: str = DEFAULT_MESSAGE) -> None:
        super().__init__(message)
