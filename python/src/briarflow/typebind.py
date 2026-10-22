"""Python annotations -> Briarflow types, and value conversion in both directions."""

from __future__ import annotations

import dataclasses
import json
import math
import re
import types as _pytypes
import typing
from enum import Enum
from typing import Annotated, Any, Union, get_args, get_origin

from .constraints import Constraint, Port
from .media import MEDIA_CLASSES, MediaRef, format_to_mime, mime_matches_primitive

MAX_SAFE_INT = 2**53 - 1

TYPE_NAME_RE = re.compile(r"^[A-Z][A-Za-z0-9_]*$")
FIELD_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENUM_VALUE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
RESERVED_TYPE_NAMES = frozenset(
    {"Text", "Int", "Float", "Boolean", "Image", "Video", "Audio", "Model3d", "Model3D", "File",
     "List", "Optional"}
)
RESERVED_FIELD_NAMES = frozenset({"__proto__", "constructor", "prototype"})

SUPPORTED = (
    "str, int, float, bool, Image, Video, Audio, Model3D, File, list[T], T | None, "
    "@struct dataclasses, str-valued Enum classes, Annotated[T, ...]"
)


# --------------------------------------------------------------------------- bindings


class Binding:
    """Internal representation of a bound Briarflow type."""

    def describe(self) -> str:  # pragma: no cover - overridden
        raise NotImplementedError


class Prim(Binding):
    __slots__ = ("name", "constraints")

    def __init__(self, name: str, constraints: dict[str, Any] | None = None) -> None:
        self.name = name
        self.constraints = dict(constraints or {})

    def describe(self) -> str:
        return self.name


class ListOf(Binding):
    __slots__ = ("of", "min_items", "max_items")

    def __init__(self, of: Binding, min_items: int | None = None, max_items: int | None = None):
        self.of = of
        self.min_items = min_items
        self.max_items = max_items

    def describe(self) -> str:
        return f"list<{self.of.describe()}>"


class Opt(Binding):
    __slots__ = ("of",)

    def __init__(self, of: Binding) -> None:
        self.of = of

    def describe(self) -> str:
        return f"{self.of.describe()}?"


class StructOf(Binding):
    __slots__ = ("cls",)

    def __init__(self, cls: type) -> None:
        self.cls = cls

    def describe(self) -> str:
        return self.cls.__name__


class EnumOf(Binding):
    __slots__ = ("cls",)

    def __init__(self, cls: type[Enum]) -> None:
        self.cls = cls

    def describe(self) -> str:
        return self.cls.__name__


# --------------------------------------------------------------------------- resolution


def _fmt_annotation(ann: Any) -> str:
    if isinstance(ann, type):
        return ann.__qualname__
    return repr(ann).replace("typing.", "")


def is_struct_class(obj: Any) -> bool:
    return isinstance(obj, type) and obj.__dict__.get("__briarflow_struct__", False) is True


def is_outputs_class(obj: Any) -> bool:
    return isinstance(obj, type) and obj.__dict__.get("__briarflow_outputs__", False) is True


def resolve(ann: Any, where: str) -> tuple[Binding, Port | None]:
    """Binds a Python annotation. Raises ``TypeError`` naming ``where`` for unsupported ones."""
    if get_origin(ann) is Annotated:
        base, *extras = get_args(ann)
        port: Port | None = None
        markers: list[Constraint] = []
        for extra in extras:
            if isinstance(extra, Port):
                port = extra.merged(port)
            elif isinstance(extra, Constraint):
                markers.append(extra)
            elif isinstance(extra, type) and issubclass(extra, Constraint):
                raise TypeError(
                    f"{where}: constraint {extra.__name__} must be instantiated, "
                    f"e.g. {extra.__name__}(…)"
                )
        binding, inner_port = resolve(base, where)
        port = port.merged(inner_port) if port else inner_port
        return _apply_constraints(binding, markers, where), port

    origin = get_origin(ann)
    if origin is Union or (hasattr(_pytypes, "UnionType") and origin is _pytypes.UnionType):
        args = get_args(ann)
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1 and len(args) == 2:
            inner, port = resolve(non_none[0], where)
            return (inner if isinstance(inner, Opt) else Opt(inner)), port
        raise TypeError(
            f"{where}: unions are only supported as `T | None` (got {_fmt_annotation(ann)}). "
            f"Supported types: {SUPPORTED}"
        )

    if origin is list:
        args = get_args(ann)
        if len(args) != 1:
            raise TypeError(f"{where}: list needs one item type, e.g. list[str]")
        item, _ = resolve(args[0], where)
        return ListOf(item), None
    if ann is list or ann is typing.List:
        raise TypeError(f"{where}: list needs an item type, e.g. list[str]")

    if ann is str:
        return Prim("text"), None
    if ann is bool:
        return Prim("boolean"), None
    if ann is int:
        return Prim("int"), None
    if ann is float:
        return Prim("float"), None

    if isinstance(ann, type):
        if issubclass(ann, MediaRef):
            if ann.primitive is None:
                raise TypeError(
                    f"{where}: use a specific media class (Image, Video, Audio, Model3D or File), "
                    f"not MediaRef"
                )
            return Prim(ann.primitive), None
        if issubclass(ann, Enum):
            if not issubclass(ann, str):
                raise TypeError(
                    f"{where}: enum {ann.__name__} must be str-valued: "
                    f"class {ann.__name__}(str, Enum)"
                )
            return EnumOf(ann), None
        if is_outputs_class(ann):
            raise TypeError(
                f"{where}: @outputs class {ann.__name__} can only be used as a node return type"
            )
        if is_struct_class(ann):
            return StructOf(ann), None
        if dataclasses.is_dataclass(ann):
            raise TypeError(
                f"{where}: dataclass {ann.__name__} is not a Briarflow type; decorate it with "
                f"@struct (above @dataclass)"
            )

    if isinstance(ann, (str, typing.ForwardRef)):
        raise TypeError(f"{where}: cannot resolve the annotation {ann!r}; is the name imported?")

    raise TypeError(
        f"{where}: unsupported type {_fmt_annotation(ann)}. Supported types: {SUPPORTED}"
    )


def _apply_constraints(binding: Binding, markers: list[Constraint], where: str) -> Binding:
    if not markers:
        return binding
    if isinstance(binding, Opt):
        return Opt(_apply_constraints(binding.of, markers, where))
    if isinstance(binding, Prim):
        kind = binding.name
        cons = dict(binding.constraints)
        for m in markers:
            if kind not in m.applies_to:
                raise TypeError(f"{where}: constraint {m!r} cannot be used on {kind}")
            cons[m.key] = m.value
        _check_pairs(cons, where)
        return Prim(kind, cons)
    if isinstance(binding, ListOf):
        out = ListOf(binding.of, binding.min_items, binding.max_items)
        for m in markers:
            if "list" not in m.applies_to:
                raise TypeError(f"{where}: constraint {m!r} cannot be used on a list")
            if m.key == "minItems":
                out.min_items = m.value
            else:
                out.max_items = m.value
        _check_pairs({"minItems": out.min_items, "maxItems": out.max_items}, where)
        return out
    raise TypeError(
        f"{where}: constraints like {markers[0]!r} cannot be used on {binding.describe()}"
    )


_PAIRS = (
    ("minLength", "maxLength"),
    ("min", "max"),
    ("minItems", "maxItems"),
    ("minWidth", "maxWidth"),
    ("minHeight", "maxHeight"),
)


def _check_pairs(cons: dict[str, Any], where: str) -> None:
    for lo, hi in _PAIRS:
        a, b = cons.get(lo), cons.get(hi)
        if a is not None and b is not None and a > b:
            raise ValueError(f"{where}: constraint {lo}={a} is greater than {hi}={b}")


# --------------------------------------------------------------------------- structs


class FieldSpec:
    __slots__ = ("name", "binding", "description", "has_default", "default_factory")

    def __init__(self, name, binding, description, has_default, default_factory):
        self.name: str = name
        self.binding: Binding = binding
        self.description: str | None = description
        self.has_default: bool = has_default
        self.default_factory = default_factory  # () -> python value

    def default_value(self) -> Any:
        return self.default_factory()


def class_fields(cls: type, what: str) -> list[FieldSpec]:
    """Fields of a @struct / @outputs dataclass, bound to Briarflow types (cached)."""
    cache_attr = "__briarflow_fields__"
    cached = cls.__dict__.get(cache_attr)
    if cached is not None:
        return cached
    try:
        hints = typing.get_type_hints(cls, include_extras=True)
    except Exception as exc:  # NameError for unresolved forward refs, etc.
        raise TypeError(f"{what} {cls.__name__}: cannot resolve field annotations: {exc}") from None
    specs: list[FieldSpec] = []
    seen: dict[str, str] = {}
    for f in dataclasses.fields(cls):
        if not f.init:
            continue
        where = f"{what} {cls.__name__}: field '{f.name}'"
        _check_field_name(f.name, where)
        low = f.name.lower()
        if low in seen:
            raise ValueError(f"{where} clashes with field '{seen[low]}' (names must differ ignoring case)")
        seen[low] = f.name
        binding, port = resolve(hints[f.name], where)
        if f.default is not dataclasses.MISSING:
            value = f.default
            factory = lambda v=value: v  # noqa: E731
            has_default = True
        elif f.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
            factory = f.default_factory  # type: ignore[assignment]
            has_default = True
        else:
            factory = None
            has_default = False
        specs.append(
            FieldSpec(f.name, binding, port.description if port else None, has_default, factory)
        )
    setattr(cls, cache_attr, specs)
    return specs


def _check_field_name(name: str, where: str) -> None:
    if not FIELD_NAME_RE.match(name) or len(name) > 64 or name in RESERVED_FIELD_NAMES:
        raise ValueError(
            f"{where}: '{name}' is not a valid name (use letters, digits and _, start with a "
            f"letter or _, at most 64 characters)"
        )


def check_port_name(name: str, where: str) -> None:
    _check_field_name(name, where)


def class_description(cls: type) -> str | None:
    doc = cls.__dict__.get("__doc__")
    if not doc:
        return None
    if dataclasses.is_dataclass(cls) and doc.startswith(cls.__name__ + "("):
        return None  # auto-generated by @dataclass
    if doc.strip() in ("An enumeration.",):
        return None
    return first_paragraph(doc)


def first_paragraph(doc: str | None) -> str | None:
    if not doc:
        return None
    import inspect

    text = inspect.cleandoc(doc)
    para = text.split("\n\n", 1)[0]
    return " ".join(line.strip() for line in para.splitlines()).strip() or None


# --------------------------------------------------------------------------- TypeRef IR


def type_id(cls: type, pack_name: str) -> str:
    return f"{pack_name}.{cls.__name__}"


def to_typeref(b: Binding, pack_name: str) -> dict[str, Any]:
    if isinstance(b, Prim):
        out: dict[str, Any] = {"kind": "primitive", "name": b.name}
        if b.constraints:
            out["constraints"] = dict(b.constraints)
        return out
    if isinstance(b, ListOf):
        out = {"kind": "list", "of": to_typeref(b.of, pack_name)}
        if b.min_items is not None:
            out["minItems"] = b.min_items
        if b.max_items is not None:
            out["maxItems"] = b.max_items
        return out
    if isinstance(b, Opt):
        return {"kind": "optional", "of": to_typeref(b.of, pack_name)}
    if isinstance(b, (StructOf, EnumOf)):
        return {"kind": "named", "id": type_id(b.cls, pack_name)}
    raise AssertionError(b)


def named_classes(b: Binding) -> list[type]:
    """Struct/enum classes referenced directly by a binding (not following struct fields)."""
    if isinstance(b, (StructOf, EnumOf)):
        return [b.cls]
    if isinstance(b, (ListOf, Opt)):
        return named_classes(b.of)
    return []


# --------------------------------------------------------------------------- values


class InvalidValue(Exception):
    """A value does not match its type. ``path`` uses dot notation with ``[i]``."""

    def __init__(self, path: str, suffix: str) -> None:
        super().__init__(f"{path} {suffix}")
        self.path = path
        self.suffix = suffix


def _got(value: Any) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, default=lambda o: f"<{type(o).__name__}>")
    except (TypeError, ValueError):
        text = repr(value)
    return text if len(text) <= 60 else text[:57] + "..."


def _check_text(value: str, cons: dict[str, Any], path: str) -> None:
    n = cons.get("minLength")
    if n is not None and len(value) < n:
        raise InvalidValue(path, f"must be at least {n} characters long")
    n = cons.get("maxLength")
    if n is not None and len(value) > n:
        raise InvalidValue(path, f"must be at most {n} characters long")
    pat = cons.get("pattern")
    if pat is not None and re.fullmatch(pat, value) is None:
        raise InvalidValue(path, f"must match the pattern {pat}")


def _check_range(value: int | float, cons: dict[str, Any], path: str) -> None:
    lo, hi = cons.get("min"), cons.get("max")
    if lo is not None and value < lo:
        raise InvalidValue(path, f"must be >= {lo}")
    if hi is not None and value > hi:
        raise InvalidValue(path, f"must be <= {hi}")


def _as_int(value: Any, path: str) -> int:
    if isinstance(value, bool):
        raise InvalidValue(path, f"must be a whole number (got {_got(value)})")
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        value = int(value)
    if not isinstance(value, int) or abs(value) > MAX_SAFE_INT:
        raise InvalidValue(path, f"must be a whole number (got {_got(value)})")
    return value


def _as_float(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidValue(path, f"must be a number (got {_got(value)})")
    if not math.isfinite(value):
        raise InvalidValue(path, f"must be a number (got {_got(value)})")
    return float(value)


def _check_media(primitive: str, mime: str, size: Any, meta: Any, cons: dict, path: str) -> None:
    if not mime_matches_primitive(mime, primitive):
        raise InvalidValue(path, f"is not a valid {primitive}: mime {mime} is not a {primitive} type")
    formats = cons.get("formats")
    if formats:
        allowed = {format_to_mime(f) for f in formats}
        if mime.lower() not in allowed:
            raise InvalidValue(
                path, f"must be one of the formats {', '.join(formats)} (got {mime})"
            )
    n = cons.get("maxBytes")
    if n is not None and isinstance(size, int) and size > n:
        raise InvalidValue(path, f"must be at most {n} bytes")
    if isinstance(meta, dict):
        w, h, d = meta.get("width"), meta.get("height"), meta.get("durationSec")
        checks = (
            ("minWidth", w, lambda v, n: v >= n, "must be at least {n} px wide"),
            ("maxWidth", w, lambda v, n: v <= n, "must be at most {n} px wide"),
            ("minHeight", h, lambda v, n: v >= n, "must be at least {n} px high"),
            ("maxHeight", h, lambda v, n: v <= n, "must be at most {n} px high"),
            ("maxDurationSec", d, lambda v, n: v <= n, "must be at most {n} seconds long"),
        )
        for key, v, ok, msg in checks:
            n = cons.get(key)
            if n is not None and isinstance(v, (int, float)) and not ok(v, n):
                raise InvalidValue(path, msg.format(n=n))


def from_json(value: Any, b: Binding, path: str) -> Any:
    """Validates a JSON value against ``b`` and converts it to the Python value a node receives."""
    if isinstance(b, Opt):
        return None if value is None else from_json(value, b.of, path)
    if value is None:
        raise InvalidValue(path, "is required")
    if isinstance(b, Prim):
        cons = b.constraints
        name = b.name
        if name == "text":
            if not isinstance(value, str):
                raise InvalidValue(path, f"must be text (got {_got(value)})")
            _check_text(value, cons, path)
            return value
        if name == "int":
            v = _as_int(value, path)
            _check_range(v, cons, path)
            return v
        if name == "float":
            f = _as_float(value, path)
            _check_range(f, cons, path)
            return f
        if name == "boolean":
            if not isinstance(value, bool):
                raise InvalidValue(path, f"must be true or false (got {_got(value)})")
            return value
        return _media_from_json(value, name, cons, path)
    if isinstance(b, EnumOf):
        members = [m.value for m in b.cls]
        if isinstance(value, str) and value in members:
            return b.cls(value)
        raise InvalidValue(path, f"must be one of {', '.join(members)} (got {_got(value)})")
    if isinstance(b, ListOf):
        if not isinstance(value, list):
            raise InvalidValue(path, f"must be a list (got {_got(value)})")
        if b.min_items is not None and len(value) < b.min_items:
            raise InvalidValue(path, f"must have at least {b.min_items} items")
        if b.max_items is not None and len(value) > b.max_items:
            raise InvalidValue(path, f"must have at most {b.max_items} items")
        return [from_json(v, b.of, f"{path}[{i}]") for i, v in enumerate(value)]
    if isinstance(b, StructOf):
        cls = b.cls
        if not isinstance(value, dict):
            raise InvalidValue(path, f"must be a {cls.__name__} object (got {_got(value)})")
        fields = class_fields(cls, "struct")
        known = {f.name for f in fields}
        for key in value:
            if key not in known:
                raise InvalidValue(
                    f"{path}.{key}",
                    f"is not a field of {cls.__name__}. Known fields: {', '.join(f.name for f in fields)}",
                )
        kwargs: dict[str, Any] = {}
        for f in fields:
            fpath = f"{path}.{f.name}"
            if f.name in value:
                kwargs[f.name] = from_json(value[f.name], f.binding, fpath)
            elif f.has_default:
                kwargs[f.name] = f.default_value()
            elif isinstance(f.binding, Opt):
                kwargs[f.name] = None
            else:
                raise InvalidValue(fpath, "is required")
        return cls(**kwargs)
    raise AssertionError(b)


def _media_from_json(value: Any, primitive: str, cons: dict, path: str) -> MediaRef:
    if not isinstance(value, dict):
        raise InvalidValue(path, f"is not a valid {primitive}: expected a MediaRef object (got {_got(value)})")
    uri, mime = value.get("uri"), value.get("mime")
    if not isinstance(uri, str) or not uri:
        raise InvalidValue(path, f"is not a valid {primitive}: missing uri")
    if not isinstance(mime, str) or not mime:
        raise InvalidValue(path, f"is not a valid {primitive}: missing mime")
    size, meta, h, url = value.get("bytes"), value.get("meta"), value.get("hash"), value.get("url")
    if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
        raise InvalidValue(path, f"is not a valid {primitive}: bytes must be a whole number >= 0")
    if meta is not None and not isinstance(meta, dict):
        raise InvalidValue(path, f"is not a valid {primitive}: meta must be an object")
    if h is not None and not isinstance(h, str):
        raise InvalidValue(path, f"is not a valid {primitive}: hash must be a string")
    if url is not None and not isinstance(url, str):
        raise InvalidValue(path, f"is not a valid {primitive}: url must be a string")
    _check_media(primitive, mime, size, meta, cons, path)
    return MEDIA_CLASSES[primitive](uri=uri, mime=mime, bytes=size, hash=h, meta=meta, url=url)


def to_json(value: Any, b: Binding, path: str) -> Any:
    """Converts a Python value a node returned (or a default) to its JSON wire form."""
    if isinstance(b, Opt):
        return None if value is None else to_json(value, b.of, path)
    if value is None:
        raise InvalidValue(path, "is required (got None)")
    if isinstance(b, Prim):
        name = b.name
        if name == "text":
            if isinstance(value, Enum) and isinstance(value, str):
                value = value.value
            if not isinstance(value, str):
                raise InvalidValue(path, f"must be text (got {_got(value)})")
            return value
        if name == "int":
            return _as_int(value, path)
        if name == "float":
            v = _as_float(value, path)
            return int(value) if isinstance(value, int) else v
        if name == "boolean":
            if not isinstance(value, bool):
                raise InvalidValue(path, f"must be true or false (got {_got(value)})")
            return value
        if isinstance(value, MediaRef):
            if not mime_matches_primitive(value.mime, name):
                raise InvalidValue(path, f"is not a valid {name}: mime {value.mime} is not a {name} type")
            return value.to_json()
        if isinstance(value, dict) and ("uri" in value or "$media" in value):
            out = {k: v for k, v in value.items() if k != "url"}
            return out
        raise InvalidValue(path, f"must be a {name} MediaRef (got {_got(value)})")
    if isinstance(b, EnumOf):
        members = [m.value for m in b.cls]
        if isinstance(value, b.cls):
            return value.value
        if isinstance(value, str) and value in members:
            return value
        raise InvalidValue(path, f"must be one of {', '.join(members)} (got {_got(value)})")
    if isinstance(b, ListOf):
        if not isinstance(value, (list, tuple)):
            raise InvalidValue(path, f"must be a list (got {_got(value)})")
        return [to_json(v, b.of, f"{path}[{i}]") for i, v in enumerate(value)]
    if isinstance(b, StructOf):
        cls = b.cls
        fields = class_fields(cls, "struct")
        if isinstance(value, cls):
            return {f.name: to_json(getattr(value, f.name), f.binding, f"{path}.{f.name}") for f in fields}
        if isinstance(value, dict):
            known = {f.name for f in fields}
            for key in value:
                if key not in known:
                    raise InvalidValue(
                        f"{path}.{key}",
                        f"is not a field of {cls.__name__}. Known fields: {', '.join(sorted(known))}",
                    )
            out = {}
            for f in fields:
                if f.name in value:
                    out[f.name] = to_json(value[f.name], f.binding, f"{path}.{f.name}")
                elif f.has_default:
                    out[f.name] = to_json(f.default_value(), f.binding, f"{path}.{f.name}")
                elif isinstance(f.binding, Opt):
                    out[f.name] = None
                else:
                    raise InvalidValue(f"{path}.{f.name}", "is required")
            return out
        raise InvalidValue(path, f"must be a {cls.__name__} (got {_got(value)})")
    raise AssertionError(b)
