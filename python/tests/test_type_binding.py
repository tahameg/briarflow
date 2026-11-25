from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any, Dict, List, Optional, Tuple, Union

import pytest

from briarflow import (
    ApiKey,
    Audio,
    Binary,
    Error,
    File,
    Image,
    Json,
    Max,
    MaxItems,
    Min,
    MinItems,
    Model3D,
    Port,
    Secret,
    Text,
    Video,
    struct,
)
from briarflow.media import Binary as _Binary
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


def N(id_: str) -> dict[str, Any]:
    return {"kind": "named", "id": id_}


TABLE = [
    (str, P("string")),
    (int, P("int")),
    (float, P("float")),
    (bool, P("bool")),
    (Binary, P("binary")),
    (Text, N("briar.Text")),
    (Image, N("briar.Image")),
    (Video, N("briar.Video")),
    (Audio, N("briar.Audio")),
    (Model3D, N("briar.Model3D")),
    (File, N("briar.File")),
    (Json, N("briar.Json")),
    (Secret, N("briar.Secret")),
    (ApiKey, N("briar.ApiKey")),
    (Error, N("briar.Error")),
    (list[str], {"kind": "list", "of": P("string")}),
    (List[int], {"kind": "list", "of": P("int")}),
    (Optional[str], {"kind": "optional", "of": P("string")}),
    (str | None, {"kind": "optional", "of": P("string")}),
    (Union[None, int], {"kind": "optional", "of": P("int")}),
    (list[Image | None], {"kind": "list", "of": {"kind": "optional", "of": N("briar.Image")}}),
    (list[Image] | None, {"kind": "optional", "of": {"kind": "list", "of": N("briar.Image")}}),
    (Character, N("demo.Character")),
    (Style, N("demo.Style")),
    (list[Character], {"kind": "list", "of": N("demo.Character")}),
    (Annotated[int, Min(1), Max(8)], P("int", min=1, max=8)),
    (Annotated[float, Min(0.5)], P("float", min=0.5)),
    (Annotated[list[str], MinItems(1), MaxItems(4)], {"kind": "list", "of": P("string"), "minItems": 1, "maxItems": 4}),
    (Optional[Annotated[int, Min(0)]], {"kind": "optional", "of": P("int", min=0)}),
    (Annotated[Optional[int], Min(0)], {"kind": "optional", "of": P("int", min=0)}),
    (Annotated[str, Port(description="x")], P("string")),
]


@pytest.mark.parametrize("ann,expected", TABLE, ids=[repr(a) for a, _ in TABLE])
def test_binding_table(ann: Any, expected: dict[str, Any]) -> None:
    binding, _ = resolve(ann, "test")
    assert to_typeref(binding, "demo") == expected


def test_port_metadata_is_returned() -> None:
    _, port = resolve(Annotated[str, Port(title="Name", description="Who")], "t")
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
        (Annotated[str, Min(1)], "cannot be used on string"),
        (Annotated[str, MinItems(1)], "cannot be used on string"),
        (Annotated[list[int], Min(1)], "cannot be used on a list"),
        (Annotated[Character, Max(3)], "cannot be used on Character"),
        (Annotated[Image, Max(3)], "limits of Image are its static fields"),
    ],
)
def test_misplaced_constraints(ann: Any, msg: str) -> None:
    with pytest.raises(TypeError, match=msg):
        resolve(ann, "where")


def test_contradicting_constraints() -> None:
    with pytest.raises(ValueError, match="min=5 is greater than max=1"):
        resolve(Annotated[int, Min(5), Max(1)], "where")
    with pytest.raises(ValueError, match="minItems"):
        resolve(Annotated[list[int], MinItems(5), MaxItems(1)], "where")


def test_invalid_constraint_definitions() -> None:
    with pytest.raises(ValueError):
        MinItems(-1)
    with pytest.raises(ValueError):
        Min(float("nan"))


def test_binary_is_the_media_class() -> None:
    assert Binary is _Binary


def test_an_extending_struct_is_a_pack_type() -> None:
    @struct
    class Title(Text):
        max_length = 80

    assert to_typeref(resolve(Title, "t")[0], "demo") == N("demo.Title")


def test_a_subclass_without_struct_hints_at_it() -> None:
    class Title(Text):
        max_length = 80

    with pytest.raises(TypeError, match="decorate it with @struct"):
        resolve(Title, "where")
