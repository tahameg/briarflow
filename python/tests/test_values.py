from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Annotated, Any, Optional

import pytest

from briarflow import (
    Formats,
    Image,
    MaxBytes,
    MaxItems,
    MaxLength,
    MediaHelper,
    MediaRef,
    Min,
    Max,
    Model3D,
    Pattern,
    struct,
)
from briarflow.typebind import InvalidValue, from_json, resolve, to_json


class Style(str, Enum):
    ANIME = "anime"
    PIXEL = "pixel"


@struct
@dataclass
class Character:
    name: Annotated[str, MaxLength(10)]
    style: Style
    age: Annotated[int, Min(0)] = 0
    nickname: Optional[str] = None
    tags: list[str] = field(default_factory=list)


@struct
@dataclass
class Scene:
    hero: Character
    extras: list[Character]
    cover: Optional[Image] = None


def b(ann: Any):
    return resolve(ann, "t")[0]


REF = {"uri": "briar-media://m_1", "mime": "image/png", "bytes": 10, "hash": "a" * 64,
       "url": "http://127.0.0.1:1/media/x"}


def test_primitives_in() -> None:
    assert from_json("hi", b(str), "inputs.x") == "hi"
    assert from_json(3, b(int), "p") == 3
    assert from_json(2.0, b(int), "p") == 2 and isinstance(from_json(2.0, b(int), "p"), int)
    assert from_json(3, b(float), "p") == 3.0 and isinstance(from_json(3, b(float), "p"), float)
    assert from_json(True, b(bool), "p") is True
    assert from_json(None, b(Optional[int]), "p") is None


@pytest.mark.parametrize(
    "value,ann,message",
    [
        ("27", int, 'inputs.p must be a whole number (got "27")'),
        (True, int, "inputs.p must be a whole number (got true)"),
        (2.5, int, "inputs.p must be a whole number (got 2.5)"),
        (2**60, int, "inputs.p must be a whole number"),
        ("x", float, 'inputs.p must be a number (got "x")'),
        (1, bool, "inputs.p must be true or false (got 1)"),
        (5, str, "inputs.p must be text (got 5)"),
        (None, str, "inputs.p is required"),
        (9, Annotated[int, Max(8)], "inputs.p must be <= 8"),
        (-1, Annotated[int, Min(0)], "inputs.p must be >= 0"),
        ("abcdefghijkl", Annotated[str, MaxLength(10)], "inputs.p must be at most 10 characters long"),
        ("ab1", Annotated[str, Pattern("[a-z]+")], "inputs.p must match the pattern [a-z]+"),
        ([1, 2, 3], Annotated[list[int], MaxItems(2)], "inputs.p must have at most 2 items"),
        ([1, "x"], list[int], 'inputs.p[1] must be a whole number (got "x")'),
        ("Anime", Style, 'inputs.p must be one of anime, pixel (got "Anime")'),
        ("x", list[int], "inputs.p must be a list"),
    ],
)
def test_invalid_values(value: Any, ann: Any, message: str) -> None:
    with pytest.raises(InvalidValue) as exc:
        from_json(value, b(ann), "inputs.p")
    assert str(exc.value).startswith(message)


def test_pattern_is_anchored() -> None:
    assert from_json("abc", b(Annotated[str, Pattern("[a-z]+")]), "p") == "abc"
    with pytest.raises(InvalidValue):
        from_json("abc1", b(Annotated[str, Pattern("[a-z]+")]), "p")


def test_enum_in_out() -> None:
    v = from_json("pixel", b(Style), "p")
    assert v is Style.PIXEL
    assert to_json(Style.PIXEL, b(Style), "p") == "pixel"
    assert to_json("anime", b(Style), "p") == "anime"


def test_struct_in_applies_defaults_and_nested() -> None:
    v = from_json(
        {"hero": {"name": "Ann", "style": "anime"}, "extras": [{"name": "Bo", "style": "pixel", "age": 3}]},
        b(Scene),
        "inputs.scene",
    )
    assert isinstance(v, Scene)
    assert v.hero == Character(name="Ann", style=Style.ANIME, age=0, nickname=None, tags=[])
    assert v.extras[0].age == 3 and v.extras[0].style is Style.PIXEL
    assert v.cover is None


def test_struct_errors_have_paths() -> None:
    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"name": "Ann", "style": "anime", "nick": 1}, "extras": []}, b(Scene), "inputs.scene")
    assert exc.value.path == "inputs.scene.hero.nick"
    assert "is not a field of Character. Known fields: name, style, age, nickname, tags" in str(exc.value)

    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"style": "anime"}, "extras": []}, b(Scene), "inputs.scene")
    assert str(exc.value) == "inputs.scene.hero.name is required"

    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"name": "A", "style": "anime"}, "extras": [{"name": "B", "style": "x"}]},
                  b(Scene), "inputs.scene")
    assert exc.value.path == "inputs.scene.extras[0].style"


def test_struct_out() -> None:
    scene = Scene(hero=Character("Ann", Style.ANIME), extras=[Character("Bo", Style.PIXEL, 4, "b", ["x"])])
    assert to_json(scene, b(Scene), "outputs.result") == {
        "hero": {"name": "Ann", "style": "anime", "age": 0, "nickname": None, "tags": []},
        "extras": [{"name": "Bo", "style": "pixel", "age": 4, "nickname": "b", "tags": ["x"]}],
        "cover": None,
    }
    # dicts are accepted too, with defaults filled in
    assert to_json({"name": "Ann", "style": Style.ANIME}, b(Character), "o") == {
        "name": "Ann", "style": "anime", "age": 0, "nickname": None, "tags": []}


def test_media_in() -> None:
    ref = from_json(dict(REF, meta={"width": 4}), b(Image), "inputs.image")
    assert isinstance(ref, Image) and isinstance(ref, MediaRef)
    assert ref.uri == "briar-media://m_1" and ref.url == REF["url"] and ref.meta == {"width": 4}
    # url is dropped when the ref is passed back out unchanged
    assert to_json(ref, b(Image), "o") == {"uri": "briar-media://m_1", "mime": "image/png", "bytes": 10,
                                            "hash": "a" * 64, "meta": {"width": 4}}


@pytest.mark.parametrize(
    "value,ann,fragment",
    [
        (dict(REF, mime="audio/wav"), Image, "is not a valid image"),
        (dict(REF, mime="image/gif"), Annotated[Image, Formats("png", "jpeg")], "must be one of the formats png, jpeg (got image/gif)"),
        (REF, Annotated[Image, MaxBytes(5)], "must be at most 5 bytes"),
        ({"mime": "image/png"}, Image, "missing uri"),
        ("briar-media://x", Image, "expected a MediaRef object"),
    ],
)
def test_media_in_invalid(value: Any, ann: Any, fragment: str) -> None:
    with pytest.raises(InvalidValue, match=fragment.replace("(", r"\(").replace(")", r"\)")):
        from_json(value, b(ann), "inputs.image")


def test_model3d_accepts_octet_stream() -> None:
    assert from_json(dict(REF, mime="application/octet-stream"), b(Model3D), "p").mime == "application/octet-stream"


def test_created_media_serializes_as_dollar_media() -> None:
    ref = MediaHelper().create(b"\x89PNG", mime="image/png", filename="a.png", width=2, height=3)
    assert isinstance(ref, Image) and ref.is_new
    assert to_json(ref, b(Image), "o") == {
        "$media": {"mime": "image/png", "base64": "iVBORw==", "filename": "a.png", "meta": {"width": 2, "height": 3}}
    }
    assert MediaHelper().read(ref) == b"\x89PNG"
    with pytest.raises(InvalidValue, match="is not a valid audio"):
        from briarflow import Audio
        to_json(ref, b(Audio), "o")


def test_media_out_inside_list_and_optional() -> None:
    ref = MediaHelper().create(b"x", mime="image/png")
    out = to_json([ref, None], b(list[Optional[Image]]), "o")
    assert out[0]["$media"]["base64"] == "eA==" and out[1] is None


def test_out_type_errors() -> None:
    with pytest.raises(InvalidValue, match="o must be text"):
        to_json(3, b(str), "o")
    with pytest.raises(InvalidValue, match="o is required"):
        to_json(None, b(int), "o")
    with pytest.raises(InvalidValue, match="o must be a number"):
        to_json(float("inf"), b(float), "o")
    with pytest.raises(InvalidValue, match=r"o\[1\] must be a whole number"):
        to_json([1, "2"], b(list[int]), "o")
