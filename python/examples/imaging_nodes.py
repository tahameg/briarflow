"""Example Briarflow pack written in Python, with no third-party dependencies.

Run it:
    python examples/imaging_nodes.py            # serves on 127.0.0.1:8765
    BRIARFLOW_PORT=0 python examples/imaging_nodes.py   # any free port (see the ready line)
"""

from __future__ import annotations

import hashlib
import struct as _bin
import time
import zlib
from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from briarflow import (
    ExecContext,
    Image,
    Max,
    MaxLength,
    Min,
    NodeError,
    Port,
    node,
    outputs,
    pack,
    serve,
    struct,
)


class Color(str, Enum):
    """A named fill color."""

    RED = "red"
    GREEN = "green"
    BLUE = "blue"
    BRIAR = "briar"


RGB = {
    Color.RED: (230, 57, 70),
    Color.GREEN: (42, 157, 143),
    Color.BLUE: (69, 123, 157),
    Color.BRIAR: (155, 93, 229),
}


@struct
@dataclass
class Swatch:
    """A color and the size of the image to fill with it."""

    color: Color
    width: Annotated[int, Min(1), Max(512), Port(description="Width in px")] = 64
    height: Annotated[int, Min(1), Max(512), Port(description="Height in px")] = 64


@outputs
@dataclass
class ImageInfo:
    image: Image
    mime: str
    bytes: int | None
    is_png: bool


def make_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """Encodes a solid-color RGB PNG with zlib and struct only."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            _bin.pack(">I", len(data))
            + tag
            + data
            + _bin.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    row = b"\x00" + bytes(rgb) * width
    raw = row * height
    ihdr = _bin.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


@node(title="Uppercase", category="Text")
def uppercase(text: Annotated[str, MaxLength(10_000)]) -> str:
    """Returns the text in upper case."""
    return text.upper()


@node(title="Solid color image", category="Image", color="peach")
def solid_image(swatch: Swatch, *, ctx: ExecContext) -> Image:
    """Creates a PNG filled with one color."""
    ctx.progress(0.1, "encoding")
    data = make_png(swatch.width, swatch.height, RGB[swatch.color])
    ctx.progress(1.0, "done")
    ctx.log("info", "encoded png", bytes=len(data))
    return ctx.media.create(
        data,
        mime="image/png",
        filename=f"{swatch.color.value}.png",
        width=swatch.width,
        height=swatch.height,
    )


@node(title="Image info", category="Image")
def image_info(image: Image, *, ctx: ExecContext) -> ImageInfo:
    """Passes the image through unchanged and reports its mime, size and whether it is a PNG."""
    head = ctx.media.read(image)[:8] if image.url else b""
    return ImageInfo(image=image, mime=image.mime, bytes=image.bytes, is_png=head == b"\x89PNG\r\n\x1a\n")


@node(title="Repeat text", category="Text", cache=False)
def repeat(text: str, times: Annotated[int, Min(0), Max(1000)] = 2, separator: str = " ") -> str:
    """Repeats the text `times` times."""
    if times == 0:
        raise NodeError("imaging.nothing_to_repeat", "times is 0, so there is nothing to output.")
    return separator.join([text] * times)


@node(title="Count slowly", category="Utility", cache=False)
def count_slowly(
    steps: Annotated[int, Min(1), Max(10_000)],
    delay_ms: Annotated[int, Min(0), Max(1000)] = 20,
    *,
    ctx: ExecContext,
) -> int:
    """Counts to `steps`, sleeping between steps and reporting progress (stops when cancelled)."""
    for i in range(steps):
        ctx.progress(i / steps, f"step {i + 1} of {steps}")  # raises Cancelled once cancelled
        time.sleep(delay_ms / 1000)
    return steps


@node(title="Sign text", category="Text", secrets=["IMAGING_KEY"])
def sign(text: str, *, ctx: ExecContext) -> str:
    """Returns a SHA-256 hex digest of the secret key followed by the text."""
    return hashlib.sha256((ctx.secrets["IMAGING_KEY"] + text).encode("utf-8")).hexdigest()


imaging = pack(
    "imaging",
    version="0.1.0",
    title="Imaging (example)",
    description="Example Python nodes: text and tiny generated images.",
    nodes=[uppercase, solid_image, image_info, repeat, count_slowly, sign],
)

if __name__ == "__main__":
    serve(imaging)
