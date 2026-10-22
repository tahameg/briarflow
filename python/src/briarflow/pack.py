"""``pack()``: binds node functions and types, validates them, and builds the manifest."""

from __future__ import annotations

import copy
import inspect
import json
import re
import typing
from enum import Enum
from typing import Any, Callable, Iterable, Mapping, Sequence

from ._version import PROTOCOL_VERSION, SDK_NAME, __version__
from .context import ExecContext
from .decorators import NodeOptions
from .typebind import (
    ENUM_VALUE_RE,
    RESERVED_TYPE_NAMES,
    TYPE_NAME_RE,
    Binding,
    InvalidValue,
    Opt,
    check_port_name,
    class_description,
    class_fields,
    first_paragraph,
    from_json,
    is_outputs_class,
    is_struct_class,
    named_classes,
    resolve,
    to_json,
    to_typeref,
    type_id,
)

PACK_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
NODE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$")
SECRET_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
COLORS = ("mint", "lavender", "peach", "sky", "pink", "yellow")


def camel_case(name: str) -> str:
    """``upscale_image`` -> ``upscaleImage``."""
    parts = [p for p in name.split("_") if p]
    if not parts:
        return name
    return parts[0][:1].lower() + parts[0][1:] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def words_title(name: str) -> str:
    """``maxTokens`` / ``max_tokens`` -> ``Max tokens``."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name.replace("_", " "))
    words = spaced.split()
    if not words:
        return name
    first = words[0][:1].upper() + words[0][1:]
    rest = [w if (len(w) > 1 and w.isupper()) else w.lower() for w in words[1:]]
    return " ".join([first, *rest])


class PortSpec:
    __slots__ = ("name", "binding", "title", "description", "has_default", "default")

    def __init__(self, name, binding, title, description, has_default=False, default=None):
        self.name: str = name
        self.binding: Binding = binding
        self.title: str = title
        self.description: str | None = description
        self.has_default: bool = has_default
        self.default: Any = default  # JSON form

    def descriptor(self, pack_name: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "type": to_typeref(self.binding, pack_name),
            "title": self.title,
        }
        if self.description:
            out["description"] = self.description
        if self.has_default:
            out["default"] = copy.deepcopy(self.default)
        return out


class NodeSpec:
    """A bound node: its descriptor data plus how to call the function."""

    def __init__(self, fn: Callable[..., Any], opts: NodeOptions, type_: str, pack_name: str):
        self.fn = fn
        self.opts = opts
        self.type = type_
        self.pack_name = pack_name
        self.inputs: list[PortSpec] = []
        self.outputs: list[PortSpec] = []
        self.output_mode = "none"  # "none" | "single" | "fields"
        self.outputs_cls: type | None = None
        self.ctx_param: str | None = None
        self.is_async = inspect.iscoroutinefunction(fn)
        self.secrets = tuple(opts.secrets)
        name = type_.split(".", 1)[1]
        self.title = opts.title or words_title(name.split(".")[-1])
        self.category = opts.category or (pack_name[:1].upper() + pack_name[1:])
        self.description = (
            opts.description if opts.description is not None else first_paragraph(fn.__doc__) or ""
        )

    # ------------------------------------------------------------------ call support

    def convert_inputs(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        """JSON inputs -> keyword arguments. Raises ``InvalidValue`` with an ``inputs.<port>`` path."""
        kwargs: dict[str, Any] = {}
        for p in self.inputs:
            path = f"inputs.{p.name}"
            if p.name in raw:
                value = raw[p.name]
            elif p.has_default:
                value = copy.deepcopy(p.default)
            elif isinstance(p.binding, Opt):
                value = None
            else:
                raise InvalidValue(path, "is required")
            kwargs[p.name] = from_json(value, p.binding, path)
        return kwargs

    def convert_outputs(self, result: Any) -> dict[str, Any]:
        """Function result -> JSON outputs. Raises ``InvalidValue`` with an ``outputs.<port>`` path."""
        if self.output_mode == "none":
            return {}
        if self.output_mode == "single":
            p = self.outputs[0]
            return {p.name: to_json(result, p.binding, f"outputs.{p.name}")}
        cls = self.outputs_cls
        assert cls is not None
        if isinstance(result, cls):
            get = lambda name: getattr(result, name)  # noqa: E731
            present = lambda name: True  # noqa: E731
        elif isinstance(result, Mapping):
            extra = set(result) - {p.name for p in self.outputs}
            if extra:
                raise InvalidValue(
                    f"outputs.{sorted(extra)[0]}",
                    f"is not an output of {self.type}. Outputs: {', '.join(p.name for p in self.outputs)}",
                )
            get = lambda name: result[name]  # noqa: E731
            present = lambda name: name in result  # noqa: E731
        else:
            raise InvalidValue("outputs", f"must be a {cls.__name__} instance (got {type(result).__name__})")
        out: dict[str, Any] = {}
        for p in self.outputs:
            value = get(p.name) if present(p.name) else None
            out[p.name] = to_json(value, p.binding, f"outputs.{p.name}")
        return out

    def call(self, kwargs: dict[str, Any], ctx: ExecContext) -> Any:
        if self.ctx_param:
            kwargs = {**kwargs, self.ctx_param: ctx}
        if self.is_async:
            import asyncio

            return asyncio.run(self.fn(**kwargs))
        return self.fn(**kwargs)

    def descriptor(self, pack_name: str, pack_version: str) -> dict[str, Any]:
        retry = self.opts.retry
        if isinstance(retry, Mapping):
            retry_obj = dict(retry)
        else:
            retry_obj = {"maxAttempts": int(retry) + 1}
        return {
            "type": self.type,
            "pack": {"name": pack_name, "version": pack_version},
            "title": self.title,
            "description": self.description,
            "category": self.category,
            "icon": self.opts.icon,
            "color": self.opts.color,
            "inputs": [p.descriptor(pack_name) for p in self.inputs],
            "outputs": [p.descriptor(pack_name) for p in self.outputs],
            "config": [],
            "dynamicPorts": False,
            "secrets": list(self.secrets),
            "cache": self.opts.cache,
            "timeoutMs": self.opts.timeout_ms,
            "retry": retry_obj,
            "concurrency": self.opts.concurrency,
            "deprecated": None,
        }


class Pack:
    """A Python node pack, ready to ``serve()``. Build it with ``pack()``."""

    def __init__(
        self,
        name: str,
        version: str,
        title: str | None,
        description: str | None,
        nodes: dict[str, NodeSpec],
        types: list[type],
    ) -> None:
        self.name = name
        self.version = version
        self.title = title
        self.description = description
        self.nodes = nodes
        self.types = types
        self._manifest = self._build_manifest()

    def node(self, node_type: str) -> NodeSpec | None:
        return self.nodes.get(node_type)

    def manifest(self) -> dict[str, Any]:
        """The ``GET /briarflow/manifest`` body."""
        return copy.deepcopy(self._manifest)

    def _build_manifest(self) -> dict[str, Any]:
        pack_info: dict[str, Any] = {"name": self.name, "version": self.version}
        if self.title is not None:
            pack_info["title"] = self.title
        if self.description is not None:
            pack_info["description"] = self.description
        return {
            "protocol": PROTOCOL_VERSION,
            "sdk": {"name": SDK_NAME, "version": __version__},
            "pack": pack_info,
            "types": [self._type_decl(cls) for cls in self.types],
            "nodes": [spec.descriptor(self.name, self.version) for spec in self.nodes.values()],
        }

    def _type_decl(self, cls: type) -> dict[str, Any]:
        desc = class_description(cls)
        if issubclass(cls, Enum):
            out: dict[str, Any] = {"kind": "enum", "id": type_id(cls, self.name), "name": cls.__name__}
            if desc:
                out["description"] = desc
            out["members"] = [{"value": m.value} for m in cls]
            return out
        out = {"kind": "struct", "id": type_id(cls, self.name), "name": cls.__name__}
        if desc:
            out["description"] = desc
        fields = []
        for f in class_fields(cls, "struct"):
            fd: dict[str, Any] = {"name": f.name, "type": to_typeref(f.binding, self.name)}
            if f.description:
                fd["description"] = f.description
            if f.has_default:
                fd["default"] = to_json(f.default_value(), f.binding, f"{cls.__name__}.{f.name}")
            fields.append(fd)
        out["fields"] = fields
        return out


def pack(
    name: str,
    version: str,
    nodes: Sequence[Callable[..., Any]],
    types: Iterable[type] = (),
    title: str | None = None,
    description: str | None = None,
) -> Pack:
    """Builds a pack from ``@node`` functions.

    Resolves default node types (``<pack>.<camelCase(function)>``), binds every annotation and
    validates the result. Raises ``TypeError`` for missing or unsupported annotations and
    ``ValueError`` for invalid names, defaults or duplicates.

    Example:
        imaging = pack("imaging", version="0.1.0", nodes=[thumbnail])
    """
    if not isinstance(name, str) or not PACK_NAME_RE.match(name) or len(name) > 32:
        raise ValueError(
            f"pack name {name!r} is invalid: use lowercase letters, digits and _, start with a "
            f"letter, at most 32 characters (e.g. 'imaging')"
        )
    if not isinstance(version, str) or not version.strip():
        raise ValueError(f"pack {name}: version must be a non-empty string like '0.1.0'")

    specs: dict[str, NodeSpec] = {}
    for fn in nodes:
        spec = _bind_node(fn, name)
        if spec.type in specs:
            raise ValueError(f"pack {name}: duplicate node type {spec.type}")
        specs[spec.type] = spec

    collected = _collect_types(list(types), specs, name)
    return Pack(name, version, title, description, specs, collected)


def _bind_node(fn: Callable[..., Any], pack_name: str) -> NodeSpec:
    opts: NodeOptions | None = getattr(fn, "__briarflow_node__", None)
    fname = getattr(fn, "__name__", repr(fn))
    if opts is None:
        raise ValueError(f"pack {pack_name}: {fname} is not a node; decorate it with @node")

    node_type = opts.type or f"{pack_name}.{camel_case(fname)}"
    if "." not in node_type:
        node_type = f"{pack_name}.{node_type}"
    if not NODE_TYPE_RE.match(node_type):
        raise ValueError(
            f"node {node_type}: type is invalid; use <pack>.<name> with a lowercase start, "
            f"e.g. {pack_name}.upscaleImage"
        )
    if node_type.split(".", 1)[0] != pack_name:
        raise ValueError(
            f"node {node_type}: type must start with the pack name '{pack_name}.' "
            f"(e.g. {pack_name}.{node_type.split('.')[-1]})"
        )
    who = f"node {node_type}"
    if opts.color is not None and opts.color not in COLORS:
        raise ValueError(f"{who}: color must be one of {', '.join(COLORS)} (got {opts.color!r})")
    for s in opts.secrets:
        if not isinstance(s, str) or not SECRET_NAME_RE.match(s):
            raise ValueError(f"{who}: secret name {s!r} is invalid (use letters, digits and _)")
    if isinstance(opts.retry, bool) or not isinstance(opts.retry, (int, Mapping)):
        raise ValueError(f"{who}: retry must be a number of retries or a RetryPolicy mapping")
    if isinstance(opts.retry, int) and opts.retry < 0:
        raise ValueError(f"{who}: retry must be >= 0")
    if isinstance(opts.retry, Mapping) and not isinstance(opts.retry.get("maxAttempts"), int):
        raise ValueError(f"{who}: retry policy needs an integer maxAttempts")
    if opts.concurrency is not None and (not isinstance(opts.concurrency, int) or opts.concurrency < 1):
        raise ValueError(f"{who}: concurrency must be a whole number >= 1 or None")
    if not isinstance(opts.timeout_ms, int) or opts.timeout_ms < 0:
        raise ValueError(f"{who}: timeout_ms must be a whole number >= 0 (0 = no timeout)")

    spec = NodeSpec(fn, opts, node_type, pack_name)
    try:
        hints = typing.get_type_hints(fn, include_extras=True)
    except Exception as exc:
        raise TypeError(f"{who}: cannot resolve annotations: {exc}") from None
    sig = inspect.signature(fn)

    seen: dict[str, str] = {}
    for param in sig.parameters.values():
        pwhere = f"{who}: parameter '{param.name}'"
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            raise TypeError(f"{pwhere}: *args and **kwargs are not supported; declare each input")
        ann = hints.get(param.name, inspect.Parameter.empty)
        if param.kind is param.KEYWORD_ONLY:
            if param.name == "ctx" or ann is ExecContext:
                if ann is not inspect.Parameter.empty and ann is not ExecContext:
                    raise TypeError(f"{pwhere}: ctx must be annotated as ExecContext")
                spec.ctx_param = param.name
                continue
            raise TypeError(
                f"{pwhere}: keyword-only parameters are reserved for `ctx: ExecContext`; "
                f"make it a normal parameter to use it as an input"
            )
        if ann is ExecContext:
            raise TypeError(f"{pwhere}: ExecContext must be keyword-only: def f(..., *, ctx: ExecContext)")
        if ann is inspect.Parameter.empty:
            raise TypeError(f"{pwhere} needs a type annotation")
        check_port_name(param.name, pwhere)
        low = param.name.lower()
        if low in seen:
            raise ValueError(f"{pwhere} clashes with '{seen[low]}' (port names must differ ignoring case)")
        seen[low] = param.name
        binding, port = resolve(ann, pwhere)
        p = PortSpec(
            param.name,
            binding,
            (port.title if port and port.title else words_title(param.name)),
            port.description if port else None,
        )
        if param.default is not inspect.Parameter.empty:
            try:
                p.default = to_json(param.default, binding, "default")
                json.dumps(p.default, allow_nan=False)
                from_json(copy.deepcopy(p.default), binding, "default")
            except InvalidValue as exc:
                raise ValueError(f"{pwhere}: default {param.default!r} is invalid: {exc}") from None
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{pwhere}: default must be JSON-serializable ({exc})") from None
            p.has_default = True
        spec.inputs.append(p)

    if "return" not in hints:
        raise TypeError(f"{who}: needs a return type annotation (use -> None for a node without outputs)")
    ret = hints["return"]
    rwhere = f"{who}: return type"
    if ret is None or ret is type(None):
        spec.output_mode = "none"
    elif is_outputs_class(ret):
        spec.output_mode = "fields"
        spec.outputs_cls = ret
        for f in class_fields(ret, "outputs"):
            spec.outputs.append(PortSpec(f.name, f.binding, words_title(f.name), f.description))
        # Port titles from Annotated[..., Port(title=…)] on output fields.
        hints_out = typing.get_type_hints(ret, include_extras=True)
        for p in spec.outputs:
            _, port = resolve(hints_out[p.name], rwhere)
            if port and port.title:
                p.title = port.title
    else:
        binding, port = resolve(ret, rwhere)
        spec.output_mode = "single"
        spec.outputs.append(
            PortSpec(
                "result",
                binding,
                port.title if port and port.title else "Result",
                port.description if port else None,
            )
        )
    return spec


def _collect_types(explicit: list[type], specs: dict[str, NodeSpec], pack_name: str) -> list[type]:
    """Explicit types first, then every struct/enum reachable from ports, deduplicated."""
    ordered: list[type] = []
    seen_ids: set[int] = set()
    by_name: dict[str, type] = {}

    def add(cls: type, where: str) -> None:
        if id(cls) in seen_ids:
            return
        if not (is_struct_class(cls) or (isinstance(cls, type) and issubclass(cls, Enum))):
            raise TypeError(
                f"pack {pack_name}: {where} {getattr(cls, '__name__', cls)!r} is not a type; "
                f"use a @struct dataclass or a str-valued Enum"
            )
        if issubclass(cls, Enum):
            resolve(cls, f"pack {pack_name}: type {cls.__name__}")  # str-valued check
        n = cls.__name__
        if not TYPE_NAME_RE.match(n) or len(n) > 64:
            raise ValueError(
                f"pack {pack_name}: type name {n!r} is invalid; type names start with an "
                f"uppercase letter and use letters, digits and _ (e.g. Character)"
            )
        if n in RESERVED_TYPE_NAMES:
            raise ValueError(f"pack {pack_name}: type name {n!r} is reserved; choose another name")
        other = by_name.get(n.lower())
        if other is not None and other is not cls:
            raise ValueError(
                f"pack {pack_name}: two different types are named {other.__name__!r} and {n!r} "
                f"(type names must be unique ignoring case)"
            )
        by_name[n.lower()] = cls
        seen_ids.add(id(cls))
        ordered.append(cls)
        if issubclass(cls, Enum):
            values: set[str] = set()
            for m in cls:
                v = m.value
                if not isinstance(v, str) or not ENUM_VALUE_RE.match(v) or len(v) > 64:
                    raise ValueError(
                        f"pack {pack_name}: enum {n} member {m.name} has invalid value {v!r}; "
                        f"use letters, digits, _, . and - (e.g. 'anime', '16x9')"
                    )
                if v in values:
                    raise ValueError(f"pack {pack_name}: enum {n} has duplicate value {v!r}")
                values.add(v)
        else:
            for f in class_fields(cls, "struct"):
                for ref in named_classes(f.binding):
                    add(ref, f"field {n}.{f.name} uses")
                if f.has_default:
                    try:
                        dv = to_json(f.default_value(), f.binding, f"{n}.{f.name}")
                        json.dumps(dv, allow_nan=False)
                    except (InvalidValue, TypeError, ValueError) as exc:
                        raise ValueError(f"pack {pack_name}: default of {n}.{f.name} is invalid: {exc}") from None

    for cls in explicit:
        add(cls, "types entry")
    for spec in specs.values():
        for p in [*spec.inputs, *spec.outputs]:
            for ref in named_classes(p.binding):
                add(ref, f"node {spec.type} port {p.name} uses")

    _check_recursion(ordered, pack_name)
    return ordered


def _check_recursion(classes: list[type], pack_name: str) -> None:
    structs = [c for c in classes if is_struct_class(c)]
    state: dict[type, int] = {}

    def visit(cls: type, chain: list[str]) -> None:
        if state.get(cls) == 2:
            return
        if state.get(cls) == 1:
            path = " -> ".join([*chain, cls.__name__])
            raise ValueError(
                f"pack {pack_name}: type {cls.__name__} contains itself through {path}. "
                f"Recursive types are not supported."
            )
        state[cls] = 1
        for f in class_fields(cls, "struct"):
            for ref in named_classes(f.binding):
                if isinstance(ref, type) and is_struct_class(ref):
                    visit(ref, [*chain, f"{cls.__name__}.{f.name}"])
        state[cls] = 2

    for c in structs:
        visit(c, [])


__all__ = ["Pack", "NodeSpec", "PortSpec", "pack", "camel_case", "words_title"]
