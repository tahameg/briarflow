import json
from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Optional

import pytest

from briarflow import (
    ExecContext,
    Image,
    Max,
    MaxLength,
    Min,
    Port,
    node,
    outputs,
    pack,
    struct,
)
from briarflow.pack import camel_case, words_title


class ArtStyle(str, Enum):
    """Drawing style."""

    ANIME = "anime"
    PIXEL = "pixel"


@struct
@dataclass
class Character:
    """A character in the story."""

    name: Annotated[str, MaxLength(40), Port(description="Display name")]
    style: ArtStyle = ArtStyle.ANIME


@outputs
@dataclass
class Thumb:
    image: Image
    width: Annotated[int, Port(title="Width (px)", description="Final width")]


@node(title="Upscale image", category="Image")
def upscale(image: Image, factor: Annotated[int, Min(1), Max(8)] = 2, *, ctx: ExecContext) -> Image:
    """Upscales an image.

    Second paragraph is not part of the description."""
    return image


@node
def upscale_image(image: Image) -> Thumb:
    return Thumb(image=image, width=1)


@node(secrets=["OPENAI_API_KEY"], retry=2, concurrency=2, cache=False, timeout_ms=1000, icon="wand", color="lavender")
def describe(character: Character, others: list[Character] | None = None) -> None:
    pass


def build():
    return pack("imaging", version="0.1.0", nodes=[upscale, upscale_image, describe],
                title="Imaging", description="Image tools")


def test_helpers() -> None:
    assert camel_case("upscale_image") == "upscaleImage"
    assert camel_case("upscale") == "upscale"
    assert words_title("maxTokens") == "Max tokens"
    assert words_title("max_tokens") == "Max tokens"
    assert words_title("upscaleImage") == "Upscale image"


def test_manifest_top_level() -> None:
    m = build().manifest()
    assert m["protocol"] == 1
    assert m["sdk"] == {"name": "briarflow-python", "version": "0.1.0"}
    assert m["pack"] == {"name": "imaging", "version": "0.1.0", "title": "Imaging", "description": "Image tools"}
    json.dumps(m)  # serializable


def test_manifest_types() -> None:
    m = build().manifest()
    assert m["types"] == [
        {
            "kind": "struct", "id": "imaging.Character", "name": "Character", "description": "A character in the story.",
            "fields": [
                {"name": "name", "type": {"kind": "primitive", "name": "text", "constraints": {"maxLength": 40}},
                 "description": "Display name"},
                {"name": "style", "type": {"kind": "named", "id": "imaging.ArtStyle"}, "default": "anime"},
            ],
        },
        {"kind": "enum", "id": "imaging.ArtStyle", "name": "ArtStyle", "description": "Drawing style.",
         "members": [{"value": "anime"}, {"value": "pixel"}]},
    ]


def test_manifest_node_descriptor() -> None:
    nodes = {n["type"]: n for n in build().manifest()["nodes"]}
    assert list(nodes) == ["imaging.upscale", "imaging.upscaleImage", "imaging.describe"]
    up = nodes["imaging.upscale"]
    assert up == {
        "type": "imaging.upscale",
        "pack": {"name": "imaging", "version": "0.1.0"},
        "title": "Upscale image",
        "description": "Upscales an image.",
        "category": "Image",
        "icon": None,
        "color": None,
        "inputs": [
            {"name": "image", "type": {"kind": "primitive", "name": "image"}, "title": "Image"},
            {"name": "factor", "type": {"kind": "primitive", "name": "int", "constraints": {"min": 1, "max": 8}},
             "title": "Factor", "default": 2},
        ],
        "outputs": [{"name": "result", "type": {"kind": "primitive", "name": "image"}, "title": "Result"}],
        "config": [],
        "dynamicPorts": False,
        "secrets": [],
        "cache": True,
        "timeoutMs": 300000,
        "retry": {"maxAttempts": 1},
        "concurrency": None,
        "deprecated": None,
    }


def test_default_type_title_category_and_outputs_dataclass() -> None:
    n = {n["type"]: n for n in build().manifest()["nodes"]}["imaging.upscaleImage"]
    assert n["title"] == "Upscale image"
    assert n["category"] == "Imaging"
    assert n["description"] == ""
    assert n["outputs"] == [
        {"name": "image", "type": {"kind": "primitive", "name": "image"}, "title": "Image"},
        {"name": "width", "type": {"kind": "primitive", "name": "int"}, "title": "Width (px)",
         "description": "Final width"},
    ]


def test_options_and_no_outputs() -> None:
    n = {n["type"]: n for n in build().manifest()["nodes"]}["imaging.describe"]
    assert n["secrets"] == ["OPENAI_API_KEY"]
    assert n["retry"] == {"maxAttempts": 3}
    assert n["concurrency"] == 2 and n["cache"] is False and n["timeoutMs"] == 1000
    assert n["icon"] == "wand" and n["color"] == "lavender"
    assert n["outputs"] == []
    assert n["inputs"][1] == {
        "name": "others",
        "type": {"kind": "optional", "of": {"kind": "list", "of": {"kind": "named", "id": "imaging.Character"}}},
        "title": "Others",
        "default": None,
    }


def test_explicit_type_without_namespace_is_prefixed() -> None:
    @node(type="shout")
    def f(x: str) -> str:
        return x

    p = pack("demo", "1", [f])
    assert list(p.nodes) == ["demo.shout"]


# ---------------------------------------------------------------- errors


def test_missing_parameter_annotation() -> None:
    @node
    def bad(factor) -> int:  # type: ignore[no-untyped-def]
        return 1

    with pytest.raises(TypeError, match=r"node imaging.bad: parameter 'factor' needs a type annotation"):
        pack("imaging", "0.1.0", [bad])


def test_missing_return_annotation() -> None:
    @node
    def bad(x: int):  # type: ignore[no-untyped-def]
        return 1

    with pytest.raises(TypeError, match="return type annotation"):
        pack("imaging", "0.1.0", [bad])


def test_unsupported_parameter_type() -> None:
    @node
    def bad(x: dict) -> int:
        return 1

    with pytest.raises(TypeError, match=r"node imaging.bad: parameter 'x': unsupported type dict"):
        pack("imaging", "0.1.0", [bad])


def test_undecorated_function() -> None:
    def plain(x: int) -> int:
        return x

    with pytest.raises(ValueError, match="decorate it with @node"):
        pack("imaging", "0.1.0", [plain])


@pytest.mark.parametrize("name", ["Imaging", "1x", "a-b", "", "x" * 33])
def test_invalid_pack_name(name: str) -> None:
    with pytest.raises(ValueError, match="pack name"):
        pack(name, "0.1.0", [])


def test_node_type_outside_pack_namespace() -> None:
    @node(type="py.upscale")
    def f(x: int) -> int:
        return x

    with pytest.raises(ValueError, match="must start with the pack name 'imaging.'"):
        pack("imaging", "0.1.0", [f])


def test_duplicate_node_types() -> None:
    @node(type="imaging.same")
    def a(x: int) -> int:
        return x

    @node(type="imaging.same")
    def b(x: int) -> int:
        return x

    with pytest.raises(ValueError, match="duplicate node type imaging.same"):
        pack("imaging", "0.1.0", [a, b])


def test_invalid_default() -> None:
    @node
    def f(x: Annotated[int, Max(3)] = 5) -> int:
        return x

    with pytest.raises(ValueError, match="default 5 is invalid: default must be <= 3"):
        pack("imaging", "0.1.0", [f])


def test_extra_keyword_only_param() -> None:
    @node
    def f(x: int, *, other: int = 1) -> int:
        return x

    with pytest.raises(TypeError, match="keyword-only"):
        pack("imaging", "0.1.0", [f])


def test_varargs_rejected() -> None:
    @node
    def f(*xs: int) -> int:
        return 1

    with pytest.raises(TypeError, match=r"\*args"):
        pack("imaging", "0.1.0", [f])


def test_reserved_and_invalid_type_names() -> None:
    @struct
    @dataclass
    class Text:
        x: int

    @node
    def f(t: Text) -> None:
        pass

    with pytest.raises(ValueError, match="reserved"):
        pack("imaging", "0.1.0", [f])


def test_invalid_enum_value() -> None:
    class Bad(str, Enum):
        A = "has space"

    @node
    def f(b: Bad) -> None:
        pass

    with pytest.raises(ValueError, match="invalid value 'has space'"):
        pack("imaging", "0.1.0", [f])


def test_recursive_struct() -> None:
    @struct
    @dataclass
    class Node_:
        children: "list[Node_]"

    Node_.__annotations__["children"] = list[Node_]

    @node
    def f(n: Node_) -> None:
        pass

    with pytest.raises(ValueError, match="contains itself"):
        pack("imaging", "0.1.0", [f])


def test_case_insensitive_type_name_clash() -> None:
    class Mode(str, Enum):
        A = "a"

    @struct
    @dataclass
    class MODE:
        x: int

    @node
    def f(a: Mode, b: MODE) -> None:
        pass

    with pytest.raises(ValueError, match="unique ignoring case"):
        pack("imaging", "0.1.0", [f])


def test_struct_requires_dataclass() -> None:
    with pytest.raises(TypeError, match="@struct must be applied to a dataclass"):
        @struct
        class X:  # noqa: F841
            pass


def test_explicit_types_are_listed_first() -> None:
    class Extra(str, Enum):
        X = "x"

    @node
    def f(c: Character) -> Optional[str]:
        return None

    p = pack("imaging", "0.1.0", [f], types=[Extra])
    assert [t["id"] for t in p.manifest()["types"]] == ["imaging.Extra", "imaging.Character", "imaging.ArtStyle"]
