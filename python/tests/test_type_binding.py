from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any, Dict, List, Optional, Tuple, Union

import pytest

from briarflow import (
    Audio,
    File,
    Formats,
    Image,
    Max,
    MaxBytes,
    MaxItems,
    MaxLength,
    MediaRef,
    Min,
    MinItems,
    MinLength,
    MinWidth,
    Model3D,
    Multiline,
    Pattern,
    Port,
    Video,
    struct,
)
from briarflow.typebind import resolve, to_typeref


class Style(str, Enum):
    ANIME = "anime"
    PIXEL = "pixel"


class IntEnum_(Enum):
    A = 1


@struct
@dataclass
class Character:
    name: str


@dataclass
class Plain:
    x: int


def P(name: str, **cons: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": "primitive", "name": name}
    if cons:
        out["constraints"] = cons
    return out


TABLE = [
    (str, P("text")),
    (int, P("int")),
    (float, P("float")),
    (bool, P("boolean")),
    (Image, P("image")),
    (Video, P("video")),
    (Audio, P("audio")),
    (Model3D, P("model3d")),
    (File, P("file")),
    (list[str], {"kind": "list", "of": P("text")}),
    (List[int], {"kind": "list", "of": P("int")}),
    (Optional[str], {"kind": "optional", "of": P("text")}),
    (str | None, {"kind": "optional", "of": P("text")}),
    (Union[None, int], {"kind": "optional", "of": P("int")}),
    (list[Image | None], {"kind": "list", "of": {"kind": "optional", "of": P("image")}}),
    (list[Image] | None, {"kind": "optional", "of": {"kind": "list", "of": P("image")}}),
    (Character, {"kind": "named", "id": "demo.Character"}),
    (Style, {"kind": "named", "id": "demo.Style"}),
    (list[Character], {"kind": "list", "of": {"kind": "named", "id": "demo.Character"}}),
    (Annotated[str, MaxLength(40)], P("text", maxLength=40)),
    (
        Annotated[str, MinLength(1), MaxLength(5), Pattern("[a-z]+"), Multiline()],
        P("text", minLength=1, maxLength=5, pattern="[a-z]+", multiline=True),
    ),
    (Annotated[int, Min(1), Max(8)], P("int", min=1, max=8)),
    (Annotated[float, Min(0.5)], P("float", min=0.5)),
    (Annotated[list[str], MinItems(1), MaxItems(4)], {"kind": "list", "of": P("text"), "minItems": 1, "maxItems": 4}),
    (Annotated[Image, Formats("png", "jpeg"), MaxBytes(1000)], P("image", formats=["png", "jpeg"], maxBytes=1000)),
    (Annotated[Image, MinWidth(16)], P("image", minWidth=16)),
    (Optional[Annotated[int, Min(0)]], {"kind": "optional", "of": P("int", min=0)}),
    (Annotated[Optional[int], Min(0)], {"kind": "optional", "of": P("int", min=0)}),
    (Annotated[str, Port(description="x")], P("text")),
]


@pytest.mark.parametrize("ann,expected", TABLE, ids=[repr(a) for a, _ in TABLE])
def test_binding_table(ann: Any, expected: dict[str, Any]) -> None:
    binding, _ = resolve(ann, "test")
    assert to_typeref(binding, "demo") == expected


def test_port_metadata_is_returned() -> None:
    _, port = resolve(Annotated[str, MaxLength(3), Port(title="Name", description="Who")], "t")
    assert port is not None and port.title == "Name" and port.description == "Who"


UNSUPPORTED = [
    dict,
    Dict[str, int],
    tuple,
    Tuple[int, int],
    Any,
    Union[int, str],
    int | str | None,
    list,
    bytes,
    object,
    MediaRef,
    IntEnum_,
    Plain,
]


@pytest.mark.parametrize("ann", UNSUPPORTED, ids=[repr(a) for a in UNSUPPORTED])
def test_unsupported_annotations_raise_type_error(ann: Any) -> None:
    with pytest.raises(TypeError) as exc:
        resolve(ann, "node demo.x: parameter 'p'")
    assert "node demo.x: parameter 'p'" in str(exc.value)


def test_unsupported_message_lists_supported_types() -> None:
    with pytest.raises(TypeError, match="Supported types: str, int"):
        resolve(dict, "where")


def test_plain_dataclass_hints_at_struct() -> None:
    with pytest.raises(TypeError, match="@struct"):
        resolve(Plain, "where")


@pytest.mark.parametrize(
    "ann,msg",
    [
        (Annotated[int, MaxLength(3)], "cannot be used on int"),
        (Annotated[str, Min(1)], "cannot be used on text"),
        (Annotated[str, MinItems(1)], "cannot be used on text"),
        (Annotated[list[int], Min(1)], "cannot be used on a list"),
        (Annotated[Character, MaxLength(3)], "cannot be used on Character"),
        (Annotated[str, Formats("png")], "cannot be used on text"),
        (Annotated[Audio, MinWidth(3)], "cannot be used on audio"),
    ],
)
def test_misplaced_constraints(ann: Any, msg: str) -> None:
    with pytest.raises(TypeError, match=msg):
        resolve(ann, "where")


def test_contradicting_constraints() -> None:
    with pytest.raises(ValueError, match="min=5 is greater than max=1"):
        resolve(Annotated[int, Min(5), Max(1)], "where")
    with pytest.raises(ValueError, match="minLength"):
        resolve(Annotated[str, MinLength(5), MaxLength(1)], "where")


def test_invalid_constraint_definitions() -> None:
    with pytest.raises(ValueError):
        MaxLength(-1)
    with pytest.raises(ValueError):
        Pattern("(")
    with pytest.raises(ValueError):
        Min(float("nan"))
    with pytest.raises(ValueError):
        Formats()
