"""Python annotations -> Briarflow types, and value conversion in both directions.

Primitives: ``str`` -> ``string``, ``int``, ``float``, ``bool``, ``Binary`` -> ``binary``.
Everything else is a struct or an enum: the built-ins (``Text``, ``Image``…, structs.py),
``@struct`` dataclasses, and ``@struct`` classes that extend another struct, which may only give
its static members (``ClassVar`` attributes) other values (types.md §1.3).
"""

from __future__ import annotations

import dataclasses
import json
import math
import re
import types as _pytypes
import typing
from enum import Enum
from typing import Annotated, Any, ClassVar, Union, get_args, get_origin

from .constraints import Constraint, Port
from .media import Binary, format_to_mime, mime_matches_kind
from .structs import BUILTIN_NAMES, Text, builtin_id, builtin_root, media_kind_of, wire_name

MAX_SAFE_INT = 2**53 - 1

TYPE_NAME_RE = re.compile(r"^[A-Z][A-Za-z0-9_]*$")
FIELD_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENUM_VALUE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
RESERVED_TYPE_NAMES = BUILTIN_NAMES | frozenset(
    {"Int", "Float", "Bool", "String", "Binary", "Boolean", "Model3d", "List", "Optional"}
)
RESERVED_FIELD_NAMES = frozenset({"__proto__", "constructor", "prototype"})

SUPPORTED = (
    "str, int, float, bool, Binary, the built-in structs (Text, Image, Video, Audio, Model3D, "
    "File, Json, Secret, ApiKey, Error), list[T], T | None, @struct classes, str-valued Enum "
    "classes, Annotated[T, ...]"
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

    if origin is list or origin is tuple:
        args = get_args(ann)
        if origin is tuple and len(args) == 2 and args[1] is Ellipsis:
            args = (args[0],)
        if len(args) != 1:
            raise TypeError(f"{where}: list needs one item type, e.g. list[str]")
        item, _ = resolve(args[0], where)
        return ListOf(item), None
    if ann is list or ann is typing.List:
        raise TypeError(f"{where}: list needs an item type, e.g. list[str]")

    if ann is str:
        return Prim("string"), None
    if ann is bool:
        return Prim("bool"), None
    if ann is int:
        return Prim("int"), None
    if ann is float:
        return Prim("float"), None
    if ann is Binary:
        return Prim("binary"), None

    if isinstance(ann, type):
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
                f"{where}: {ann.__name__} is not a Briarflow type; decorate it with @struct"
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
        _check_pair(cons, "min", "max", where)
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
        _check_pair({"minItems": out.min_items, "maxItems": out.max_items}, "minItems", "maxItems", where)
        return out
    hint = ""
    if isinstance(binding, StructOf):
        hint = (
            f"; limits of {binding.cls.__name__} are its static members: extend it "
            f"(@struct class Short{binding.cls.__name__}({binding.cls.__name__}): …)"
        )
    raise TypeError(
        f"{where}: constraints like {markers[0]!r} cannot be used on {binding.describe()}{hint}"
    )


def _check_pair(cons: dict[str, Any], lo: str, hi: str, where: str) -> None:
    a, b = cons.get(lo), cons.get(hi)
    if a is not None and b is not None and a > b:
        raise ValueError(f"{where}: {lo}={a} is greater than {hi}={b}")


# --------------------------------------------------------------------------- structs


class FieldSpec:
    """An instance field of a struct (or a field of an @outputs class)."""

    __slots__ = ("name", "wire", "binding", "description", "has_default", "default_factory")

    def __init__(self, name, wire, binding, description, has_default, default_factory):
        self.name: str = name
        self.wire: str = wire
        self.binding: Binding = binding
        self.description: str | None = description
        self.has_default: bool = has_default
        self.default_factory = default_factory  # () -> python value

    def default_value(self) -> Any:
        return self.default_factory()


class StaticSpec:
    """A static member: its value is fixed by the type (a ``ClassVar``), never by a value."""

    __slots__ = ("name", "wire", "binding", "value", "own", "description")

    def __init__(self, name, wire, binding, value, own, description):
        self.name: str = name
        self.wire: str = wire
        self.binding: Binding = binding
        self.value: Any = value
        self.own: bool = own  # declared or given a value by this class itself
        self.description: str | None = description


def class_fields(cls: type, what: str) -> list[FieldSpec]:
    """Instance fields of a struct / @outputs dataclass, bound to Briarflow types (cached)."""
    cache_attr = "__briarflow_fields__"
    cached = cls.__dict__.get(cache_attr)
    if cached is not None:
        return cached
    hints = _hints(cls, what)
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
            FieldSpec(f.name, wire_name(cls, f.name), binding, port.description if port else None, has_default, factory)
        )
    type.__setattr__(cls, cache_attr, specs)
    return specs


def _hints(cls: type, what: str) -> dict[str, Any]:
    try:
        return typing.get_type_hints(cls, include_extras=True)
    except Exception as exc:  # NameError for unresolved forward refs, etc.
        raise TypeError(f"{what} {cls.__name__}: cannot resolve field annotations: {exc}") from None


def struct_base(cls: type) -> type | None:
    """The struct ``cls`` extends (the nearest struct class among its bases), if any."""
    for base in cls.__mro__[1:]:
        if is_struct_class(base):
            return base
    return None


def struct_root(cls: type) -> type:
    """The struct at the top of ``cls``'s ``extends`` chain (``Text`` for ``ShortText``)."""
    root = cls
    base = struct_base(cls)
    while base is not None:
        root = base
        base = struct_base(base)
    return root


def class_statics(cls: type) -> dict[str, StaticSpec]:
    """Static members of a struct, inherited ones included, with this class's values (cached)."""
    cache_attr = "__briarflow_statics__"
    cached = cls.__dict__.get(cache_attr)
    if cached is not None:
        return cached
    hints = _hints(cls, "struct")
    out: dict[str, StaticSpec] = {}
    for name, ann in hints.items():
        if get_origin(ann) is not ClassVar or name.startswith("_"):
            continue
        args = get_args(ann)
        where = f"struct {cls.__name__}: static member '{name}'"
        if len(args) != 1:
            raise TypeError(f"{where} needs a type, e.g. ClassVar[int]")
        if not hasattr(cls, name):
            raise ValueError(f"{where} needs a value; static members are fixed by the type")
        _check_field_name(name, where)
        binding, port = resolve(args[0], where)
        out[name] = StaticSpec(
            name, wire_name(cls, name), binding, getattr(cls, name), name in cls.__dict__, port.description if port else None
        )
    type.__setattr__(cls, cache_attr, out)
    return out


def check_struct(cls: type, pack_name: str) -> None:
    """Raises ``TypeError`` / ``ValueError`` for a struct that breaks the ``extends`` rules or
    whose static values are wrong (types.md §1.3)."""
    who = f"pack {pack_name}: struct {cls.__name__}"
    base = struct_base(cls)
    fields = class_fields(cls, "struct")
    statics = class_statics(cls)
    if base is not None:
        base_fields = {f.name for f in class_fields(base, "struct")}
        for f in fields:
            if f.name not in base_fields:
                raise TypeError(
                    f"{who} extends {base.__name__}, so it can only give static members values; "
                    f"field '{f.name}' is new. Declare it as ClassVar[…] = value, or don't extend."
                )
        inherited = class_statics(base)
        for name, s in statics.items():
            prior = inherited.get(name)
            if prior is not None and describe_binding(prior.binding) != describe_binding(s.binding):
                raise TypeError(
                    f"{who}: static member '{name}' is {describe_binding(prior.binding)} in "
                    f"{base.__name__}; an extending struct can't change its type"
                )
    for s in statics.values():
        try:
            json.dumps(to_json(s.value, s.binding, f"{cls.__name__}.{s.name}"), allow_nan=False)
        except InvalidValue as exc:
            raise ValueError(f"{who}: static member {exc}") from None
    _check_limits_of(cls, who)


def describe_binding(b: Binding) -> str:
    return b.describe()


def _check_limits_of(cls: type, who: str) -> None:
    root = builtin_root(cls)
    if root is None:
        return
    s = {k: v.value for k, v in class_statics(cls).items()}
    pairs = [("min_length", "max_length"), ("min_width", "max_width"), ("min_height", "max_height")]
    for lo, hi in pairs:
        a, b = s.get(lo), s.get(hi)
        if a is not None and b is not None and a > b:
            raise ValueError(f"{who}: {wire_name(cls, lo)}={a} is greater than {wire_name(cls, hi)}={b}")
    for key, value in s.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value < 0 and key != "kind":
            raise ValueError(f"{who}: {wire_name(cls, key)} must be >= 0 (got {value})")
    pattern = s.get("pattern")
    if pattern is not None:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ValueError(f"{who}: pattern {pattern!r} does not compile: {exc}") from None


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
    return builtin_id(cls) or f"{pack_name}.{cls.__name__}"


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


def check_limits(cls: type, value: dict[str, Any], path: str) -> None:
    """Checks a struct value (wire form) against the limits its type fixes: Text's length and
    pattern, media's formats, size, dimensions and duration."""
    root = builtin_root(cls)
    if root is None:
        return
    s = {k: v.value for k, v in class_statics(cls).items()}
    if issubclass(root, Text):
        text = value.get("value")
        if not isinstance(text, str):
            return
        n = s.get("min_length")
        if n is not None and len(text) < n:
            raise InvalidValue(path, f"must be at least {n} characters long")
        n = s.get("max_length")
        if n is not None and len(text) > n:
            raise InvalidValue(path, f"must be at most {n} characters long")
        pat = s.get("pattern")
        if pat is not None and re.fullmatch(pat, text) is None:
            raise InvalidValue(path, f"must match the pattern {pat}")
        return
    kind = media_kind_of(cls)
    if kind is None:
        return
    mime = value.get("mime")
    if not isinstance(mime, str):
        return
    if not mime_matches_kind(mime, kind):
        raise InvalidValue(path, f"is not a valid {kind}: mime {mime} is not a {kind} type")
    formats = s.get("formats") or ()
    if formats:
        allowed = {format_to_mime(f) for f in formats}
        if mime.lower() not in allowed:
            raise InvalidValue(path, f"must be one of the formats {', '.join(formats)} (got {mime})")
    size = value.get("size")
    data = value.get("data")
    if size is None and isinstance(data, dict):
        size = data.get("bytes")
    n = s.get("max_bytes")
    if n is not None and isinstance(size, int) and size > n:
        raise InvalidValue(path, f"must be at most {n} bytes")
    checks = (
        ("min_width", value.get("width"), lambda v, n: v >= n, "must be at least {n} px wide"),
        ("max_width", value.get("width"), lambda v, n: v <= n, "must be at most {n} px wide"),
        ("min_height", value.get("height"), lambda v, n: v >= n, "must be at least {n} px high"),
        ("max_height", value.get("height"), lambda v, n: v <= n, "must be at most {n} px high"),
        ("max_duration", value.get("duration"), lambda v, n: v <= n, "must be at most {n} seconds long"),
    )
    for key, v, ok, msg in checks:
        n = s.get(key)
        if n is not None and isinstance(v, (int, float)) and not ok(v, n):
            raise InvalidValue(path, msg.format(n=n))


def _static_wires(cls: type) -> dict[str, str]:
    return {s.wire: s.name for s in class_statics(cls).values()}


def from_json(value: Any, b: Binding, path: str) -> Any:
    """Validates a JSON value against ``b`` and converts it to the Python value a node receives."""
    if isinstance(b, Opt):
        return None if value is None else from_json(value, b.of, path)
    if value is None:
        raise InvalidValue(path, "is required")
    if isinstance(b, Prim):
        cons = b.constraints
        name = b.name
        if name == "string":
            if not isinstance(value, str):
                raise InvalidValue(path, f"must be a string (got {_got(value)})")
            return value
        if name == "int":
            v = _as_int(value, path)
            _check_range(v, cons, path)
            return v
        if name == "float":
            f = _as_float(value, path)
            _check_range(f, cons, path)
            return f
        if name == "bool":
            if not isinstance(value, bool):
                raise InvalidValue(path, f"must be true or false (got {_got(value)})")
            return value
        return _binary_from_json(value, path)
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
        known = {f.wire for f in fields}
        statics = _static_wires(cls)
        for key in value:
            if key in statics:
                raise InvalidValue(f"{path}.{key}", f"is a static member of {cls.__name__}; values can't set it")
            if key not in known:
                raise InvalidValue(
                    f"{path}.{key}",
                    f"is not a field of {cls.__name__}. Known fields: {', '.join(f.wire for f in fields)}",
                )
        kwargs: dict[str, Any] = {}
        for f in fields:
            fpath = f"{path}.{f.wire}"
            if f.wire in value:
                kwargs[f.name] = from_json(value[f.wire], f.binding, fpath)
            elif f.has_default:
                kwargs[f.name] = f.default_value()
            elif isinstance(f.binding, Opt):
                kwargs[f.name] = None
            else:
                raise InvalidValue(fpath, "is required")
        check_limits(cls, value, path)
        return cls(**kwargs)
    raise AssertionError(b)


def _binary_from_json(value: Any, path: str) -> Binary:
    if not isinstance(value, dict):
        raise InvalidValue(path, f"is not valid binary data: expected a media object (got {_got(value)})")
    uri, mime = value.get("uri"), value.get("mime")
    if not isinstance(uri, str) or not uri:
        raise InvalidValue(path, "is not valid binary data: missing uri")
    if not isinstance(mime, str) or not mime:
        raise InvalidValue(path, "is not valid binary data: missing mime")
    size, meta, h, url = value.get("bytes"), value.get("meta"), value.get("hash"), value.get("url")
    if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
        raise InvalidValue(path, "is not valid binary data: bytes must be a whole number >= 0")
    if meta is not None and not isinstance(meta, dict):
        raise InvalidValue(path, "is not valid binary data: meta must be an object")
    if h is not None and not isinstance(h, str):
        raise InvalidValue(path, "is not valid binary data: hash must be a string")
    if url is not None and not isinstance(url, str):
        raise InvalidValue(path, "is not valid binary data: url must be a string")
    return Binary(uri=uri, mime=mime, bytes=size, hash=h, meta=meta, url=url)


def to_json(value: Any, b: Binding, path: str) -> Any:
    """Converts a Python value a node returned (or a default) to its JSON wire form."""
    if isinstance(b, Opt):
        return None if value is None else to_json(value, b.of, path)
    if value is None:
        raise InvalidValue(path, "is required (got None)")
    if isinstance(b, Prim):
        name = b.name
        if name == "string":
            if isinstance(value, Enum) and isinstance(value, str):
                value = value.value
            if not isinstance(value, str):
                raise InvalidValue(path, f"must be a string (got {_got(value)})")
            return value
        if name == "int":
            return _as_int(value, path)
        if name == "float":
            v = _as_float(value, path)
            return int(value) if isinstance(value, int) else v
        if name == "bool":
            if not isinstance(value, bool):
                raise InvalidValue(path, f"must be true or false (got {_got(value)})")
            return value
        if isinstance(value, Binary):
            return value.to_json()
        if isinstance(value, dict) and ("uri" in value or "$media" in value):
            return {k: v for k, v in value.items() if k != "url"}
        raise InvalidValue(path, f"must be Binary data (got {_got(value)})")
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
        root = struct_root(cls)
        if isinstance(value, str) and issubclass(root, Text):
            value = {"value": value}
        if isinstance(value, root):
            out = {f.wire: to_json(getattr(value, f.name), f.binding, f"{path}.{f.wire}") for f in fields}
        elif isinstance(value, dict):
            by_wire = {f.wire: f for f in fields}
            statics = _static_wires(cls)
            for key in value:
                if key in statics:
                    raise InvalidValue(f"{path}.{key}", f"is a static member of {cls.__name__}; values can't set it")
                if key not in by_wire and key not in {f.name for f in fields}:
                    raise InvalidValue(
                        f"{path}.{key}",
                        f"is not a field of {cls.__name__}. Known fields: {', '.join(sorted(by_wire))}",
                    )
            out = {}
            for f in fields:
                key = f.wire if f.wire in value else f.name
                if key in value:
                    out[f.wire] = to_json(value[key], f.binding, f"{path}.{f.wire}")
                elif f.has_default:
                    out[f.wire] = to_json(f.default_value(), f.binding, f"{path}.{f.wire}")
                elif isinstance(f.binding, Opt):
                    out[f.wire] = None
                else:
                    raise InvalidValue(f"{path}.{f.wire}", "is required")
        else:
            raise InvalidValue(path, f"must be a {cls.__name__} (got {_got(value)})")
        check_limits(cls, out, path)
        return out
    raise AssertionError(b)
