"""Briarflow Python SDK: write nodes in Python and serve them to a Briarflow engine.

Example:
    from briarflow import node, pack, serve

    @node(title="Uppercase", category="Text")
    def uppercase(text: str) -> str:
        return text.upper()

    if __name__ == "__main__":
        serve(pack("textx", version="0.1.0", nodes=[uppercase]))
"""

from ._version import PROTOCOL_VERSION, __version__
from .constraints import (
    Constraint,
    Formats,
    Max,
    MaxBytes,
    MaxDurationSec,
    MaxHeight,
    MaxItems,
    MaxLength,
    MaxWidth,
    Min,
    MinHeight,
    MinItems,
    MinLength,
    MinWidth,
    Multiline,
    Pattern,
    Port,
)
from .context import ExecContext, MediaHelper
from .decorators import node, outputs, struct
from .errors import Cancelled, NodeError
from .media import Audio, File, Image, MediaRef, Model3D, Video
from .pack import Pack, pack
from .worker import Worker, serve

__all__ = [
    "__version__",
    "PROTOCOL_VERSION",
    "node",
    "struct",
    "outputs",
    "pack",
    "Pack",
    "serve",
    "Worker",
    "Image",
    "Video",
    "Audio",
    "Model3D",
    "File",
    "MediaRef",
    "Constraint",
    "MinLength",
    "MaxLength",
    "Pattern",
    "Multiline",
    "Min",
    "Max",
    "MinItems",
    "MaxItems",
    "Formats",
    "MaxBytes",
    "MinWidth",
    "MaxWidth",
    "MinHeight",
    "MaxHeight",
    "MaxDurationSec",
    "Port",
    "ExecContext",
    "MediaHelper",
    "NodeError",
    "Cancelled",
]
