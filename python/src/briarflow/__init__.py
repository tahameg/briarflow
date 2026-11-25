"""Briarflow Python SDK: write nodes in Python and serve them to a Briarflow engine.

Types: ``str`` ``int`` ``float`` ``bool`` ``Binary`` are the primitives; ``Text``, ``Image``…
are built-in structs whose limits are static fields (``class ShortText(Text): max_length = 80``).

Example:
    from briarflow import node, pack, serve

    @node(title="Uppercase", category="Text")
    def uppercase(text: str) -> str:
        return text.upper()

    if __name__ == "__main__":
        serve(pack("textx", version="0.1.0", nodes=[uppercase]))
"""

from ._version import PROTOCOL_VERSION, __version__
from .constraints import Constraint, Max, MaxItems, Min, MinItems, Port
from .context import ExecContext, MediaHelper
from .decorators import node, outputs, struct
from .errors import Cancelled, NodeError
from .media import Binary
from .pack import Pack, pack
from .structs import ApiKey, Audio, Error, File, Image, Json, Model3D, Secret, SecretKind, Text, Video
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
    "Binary",
    "Text",
    "Image",
    "Video",
    "Audio",
    "Model3D",
    "File",
    "Json",
    "Secret",
    "SecretKind",
    "ApiKey",
    "Error",
    "Constraint",
    "Min",
    "Max",
    "MinItems",
    "MaxItems",
    "Port",
    "ExecContext",
    "MediaHelper",
    "NodeError",
    "Cancelled",
]
