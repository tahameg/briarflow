from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Annotated, Any, ClassVar, Optional

import pytest

from briarflow import (
    Audio,
    Binary,
    Image,
    Json,
    MaxItems,
    MediaHelper,
    Min,
    Max,
    Model3D,
    Text,
    struct,
)
from briarflow.typebind import InvalidValue, from_json, resolve, to_json


class Style(str, Enum):
    ANIME = "anime"
    PIXEL = "pixel"


@struct
class Name(Text):
    max_length = 10


@struct
class Word(Text):
    pattern = "[a-z]+"


@struct
class Photo(Image):
    formats = ("png", "jpeg")
    max_bytes = 5
    max_width = 100


@struct
@dataclass
class Character:
    name: Name
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
IMAGE = {"data": REF, "mime": "image/png", "name": "a.png", "size": 10, "width": 4, "height": 3}


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
        (5, str, "inputs.p must be a string (got 5)"),
        (None, str, "inputs.p is required"),
        (9, Annotated[int, Max(8)], "inputs.p must be <= 8"),
        (-1, Annotated[int, Min(0)], "inputs.p must be >= 0"),
        ({"value": "abcdefghijkl"}, Name, "inputs.p.value must be at most 10 characters long"),
        ({"value": "ab1"}, Word, "inputs.p.value must match the pattern [a-z]+"),
        ({"value": "ab", "maxLength": 3}, Name, "inputs.p.maxLength is a static field of Name: its value comes from the type"),
        ("ab", Name, 'inputs.p must be a Name object (got "ab")'),
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
    assert from_json({"value": "abc"}, b(Word), "p") == Word("abc")
    with pytest.raises(InvalidValue):
        from_json({"value": "abc1"}, b(Word), "p")


def test_text_in_and_out() -> None:
    v = from_json({"value": "Ann"}, b(Name), "p")
    assert isinstance(v, Name) and v.value == "Ann" and str(v) == "Ann" and v.max_length == 10
    assert to_json(v, b(Name), "o") == {"value": "Ann"}
    # a plain str is accepted where a Text is returned
    assert to_json("Bo", b(Name), "o") == {"value": "Bo"}
    # a Text is accepted for a struct extending it, and checked against its limits
    with pytest.raises(InvalidValue, match="o.value must be at most 10 characters long"):
        to_json(Text("x" * 11), b(Name), "o")


def test_user_static_members_are_not_values() -> None:
    @struct
    @dataclass
    class Pet:
        name: str
        legs: ClassVar[int] = 4

    assert from_json({"name": "Rex"}, b(Pet), "p") == Pet("Rex")
    assert to_json(Pet("Rex"), b(Pet), "o") == {"name": "Rex"}
    with pytest.raises(InvalidValue, match="p.legs is a static field of Pet"):
        from_json({"name": "Rex", "legs": 3}, b(Pet), "p")


def test_json_in_and_out() -> None:
    v = from_json({"text": '{"a": 1}'}, b(Json), "p")
    assert v.parse() == {"a": 1}
    assert to_json(Json.of([1, 2]), b(Json), "o") == {"text": "[1, 2]"}


def test_enum_in_out() -> None:
    v = from_json("pixel", b(Style), "p")
    assert v is Style.PIXEL
    assert to_json(Style.PIXEL, b(Style), "p") == "pixel"
    assert to_json("anime", b(Style), "p") == "anime"


def test_struct_in_applies_defaults_and_nested() -> None:
    v = from_json(
        {"hero": {"name": {"value": "Ann"}, "style": "anime"}, "extras": [{"name": {"value": "Bo"}, "style": "pixel", "age": 3}]},
        b(Scene),
        "inputs.scene",
    )
    assert isinstance(v, Scene)
    assert v.hero == Character(name=Name("Ann"), style=Style.ANIME, age=0, nickname=None, tags=[])
    assert v.extras[0].age == 3 and v.extras[0].style is Style.PIXEL
    assert v.cover is None


def test_struct_errors_have_paths() -> None:
    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"name": {"value": "Ann"}, "style": "anime", "nick": 1}, "extras": []}, b(Scene), "inputs.scene")
    assert exc.value.path == "inputs.scene.hero.nick"
    assert "is not a field of Character. Known fields: name, style, age, nickname, tags" in str(exc.value)

    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"style": "anime"}, "extras": []}, b(Scene), "inputs.scene")
    assert str(exc.value) == "inputs.scene.hero.name is required"

    with pytest.raises(InvalidValue) as exc:
        from_json({"hero": {"name": {"value": "A"}, "style": "anime"}, "extras": [{"name": {"value": "B"}, "style": "x"}]},
                  b(Scene), "inputs.scene")
    assert exc.value.path == "inputs.scene.extras[0].style"


def test_struct_out() -> None:
    scene = Scene(hero=Character(Name("Ann"), Style.ANIME), extras=[Character(Name("Bo"), Style.PIXEL, 4, "b", ["x"])])
    assert to_json(scene, b(Scene), "outputs.result") == {
        "hero": {"name": {"value": "Ann"}, "style": "anime", "age": 0, "nickname": None, "tags": []},
        "extras": [{"name": {"value": "Bo"}, "style": "pixel", "age": 4, "nickname": "b", "tags": ["x"]}],
        "cover": None,
    }
    # dicts are accepted too, with defaults filled in
    assert to_json({"name": "Ann", "style": Style.ANIME}, b(Character), "o") == {
        "name": {"value": "Ann"}, "style": "anime", "age": 0, "nickname": None, "tags": []}


def test_media_in() -> None:
    image = from_json(dict(IMAGE, data=dict(REF, meta={"width": 4})), b(Image), "inputs.image")
    assert isinstance(image, Image) and isinstance(image.data, Binary)
    assert image.data.uri == "briar-media://m_1" and image.data.url == REF["url"] and image.data.meta == {"width": 4}
    assert (image.mime, image.name, image.size, image.width, image.height) == ("image/png", "a.png", 10, 4, 3)
    # url is dropped when the value is passed back out unchanged
    assert to_json(image, b(Image), "o") == {
        "data": {"uri": "briar-media://m_1", "mime": "image/png", "bytes": 10, "hash": "a" * 64, "meta": {"width": 4}},
        "mime": "image/png", "name": "a.png", "size": 10, "width": 4, "height": 3,
    }


@pytest.mark.parametrize(
    "value,ann,fragment",
    [
        (dict(IMAGE, mime="audio/wav"), Image, "is not a valid image"),
        (dict(IMAGE, mime="image/gif"), Photo, "must be one of the formats png, jpeg (got image/gif)"),
        (IMAGE, Photo, "must be at most 5 bytes"),
        (dict(IMAGE, size=1, width=101), Photo, "must be at most 100 px wide"),
        (dict(IMAGE, data={"mime": "image/png"}), Image, "missing uri"),
        (dict(IMAGE, data="briar-media://x"), Image, "expected a media object"),
        (dict(IMAGE, maxBytes=3), Photo, "is a static field of Photo"),
    ],
)
def test_media_in_invalid(value: Any, ann: Any, fragment: str) -> None:
    with pytest.raises(InvalidValue, match=fragment.replace("(", r"\(").replace(")", r"\)")):
        from_json(value, b(ann), "inputs.image")


def test_model3d_accepts_octet_stream() -> None:
    value = {"data": dict(REF, mime="application/octet-stream"), "mime": "application/octet-stream"}
    assert from_json(value, b(Model3D), "p").mime == "application/octet-stream"


def test_created_media_serializes_as_dollar_media() -> None:
    image = MediaHelper().create(b"\x89PNG", mime="image/png", filename="a.png", width=2, height=3)
    assert isinstance(image, Image) and image.data.is_new
    assert to_json(image, b(Image), "o") == {
        "data": {"$media": {"mime": "image/png", "base64": "iVBORw==", "filename": "a.png", "meta": {"width": 2, "height": 3}}},
        "mime": "image/png", "name": "a.png", "size": 4, "width": 2, "height": 3,
    }
    assert MediaHelper().read(image) == b"\x89PNG"
    assert MediaHelper().read(image.data) == b"\x89PNG"
    with pytest.raises(InvalidValue, match="o must be a Audio"):
        to_json(image, b(Audio), "o")
    # a new Image is accepted for a struct extending Image, and checked against its limits
    assert to_json(image, b(Photo), "o")["width"] == 2
    big = MediaHelper().create(b"\x89PNG--", mime="image/png")
    with pytest.raises(InvalidValue, match="o must be at most 5 bytes"):
        to_json(big, b(Photo), "o")


def test_create_picks_the_struct_by_mime() -> None:
    m = MediaHelper()
    assert type(m.create(b"x", mime="audio/wav", duration=1.5)).__name__ == "Audio"
    assert m.create(b"x", mime="audio/wav", duration=1.5).duration == 1.5
    assert type(m.create(b"x", mime="video/mp4")).__name__ == "Video"
    assert type(m.create(b"x", mime="model/gltf-binary")).__name__ == "Model3D"
    assert type(m.create(b"x", mime="application/pdf")).__name__ == "File"


def test_media_out_inside_list_and_optional() -> None:
    image = MediaHelper().create(b"x", mime="image/png")
    out = to_json([image, None], b(list[Optional[Image]]), "o")
    assert out[0]["data"]["$media"]["base64"] == "eA==" and out[1] is None


def test_out_type_errors() -> None:
    with pytest.raises(InvalidValue, match="o must be a string"):
        to_json(3, b(str), "o")
    with pytest.raises(InvalidValue, match="o is required"):
        to_json(None, b(int), "o")
    with pytest.raises(InvalidValue, match="o must be a number"):
        to_json(float("inf"), b(float), "o")
    with pytest.raises(InvalidValue, match=r"o\[1\] must be a whole number"):
        to_json([1, "2"], b(list[int]), "o")
