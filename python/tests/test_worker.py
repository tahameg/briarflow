import asyncio
import base64
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Annotated, Optional

import pytest

from briarflow import (
    Cancelled,
    ExecContext,
    Image,
    Max,
    Min,
    NodeError,
    node,
    outputs,
    pack,
    struct,
)

ROOT = Path(__file__).resolve().parent.parent


@struct
@dataclass
class Point:
    x: int
    y: int = 0


@outputs
@dataclass
class Pair:
    first: str
    second: Optional[str]


@node
def add(a: int, b: Annotated[int, Min(0), Max(100)] = 1, *, ctx: ExecContext) -> int:
    ctx.progress(0.5, "adding")
    ctx.log("info", "inputs seen", a=a, b=b)
    ctx.progress(1.0)
    return a + b


@node
def fail_expected(message: str) -> str:
    raise NodeError("demo.bad", message, retryable=True, details={"why": "test"})


@node
def fail_unexpected(x: int) -> int:
    raise RuntimeError(f"boom {x}")


@node
def bad_output(x: int) -> int:
    return "not an int"  # type: ignore[return-value]


@node
def split(text: str) -> Pair:
    a, _, b = text.partition(" ")
    return Pair(first=a, second=b or None)


@node
def shift(p: Point, dx: int = 1) -> Point:
    return Point(p.x + dx, p.y)


@node
async def slow_upper(text: str, *, ctx: ExecContext) -> str:
    await asyncio.sleep(0.01)
    ctx.progress(0.5)
    return text.upper()


@node(secrets=["API_KEY", "OTHER"])
def use_secret(name: str, *, ctx: ExecContext) -> str:
    return f"{ctx.secrets[name]}|{sorted(ctx.secrets)}"


@node
def passthrough(image: Image) -> Image:
    return image


@node
def make_image(size: int, *, ctx: ExecContext) -> list[Image]:
    return [ctx.media.create(b"\x00" * size, mime="image/png", filename="z.png", width=size)]


@node
def nothing(x: int) -> None:
    return None


@node
def read_media(image: Image, *, ctx: ExecContext) -> int:
    return len(ctx.media.read(image))


@node
def give_up(reason: str) -> int:
    raise Cancelled(reason) if reason else Cancelled()


demo = pack(
    "demo",
    "0.1.0",
    [add, fail_expected, fail_unexpected, bad_output, split, shift, slow_upper, use_secret,
     passthrough, make_image, nothing, read_media, give_up],
)

REF = {"uri": "briar-media://m_1", "mime": "image/png", "bytes": 3, "hash": "b" * 64}


@pytest.fixture
def client(serve_pack):
    return serve_pack(demo)


def test_health(client) -> None:
    r = client.get("/briarflow/health")
    assert r.status == 200
    assert r.json() == {"ok": True, "protocol": 1, "pack": {"name": "demo", "version": "0.1.0"}}
    assert r.headers["x-briarflow-protocol"] == "1"


def test_manifest(client) -> None:
    r = client.get("/briarflow/manifest")
    assert r.status == 200 and r.headers["x-briarflow-protocol"] == "1"
    assert r.json() == demo.manifest()


def test_unknown_path(client) -> None:
    r = client.get("/nope")
    assert r.status == 404 and r.json()["error"]["code"] == "protocol.not_found"


def test_execute_streams_progress_log_and_result(client) -> None:
    r = client.execute("demo.add", {"a": 2, "b": 3})
    assert r.status == 200
    assert r.headers["content-type"] == "application/x-ndjson"
    assert r.headers["x-briarflow-protocol"] == "1"
    assert r.lines == [
        {"type": "progress", "fraction": 0.5, "message": "adding"},
        {"type": "log", "level": "info", "message": "inputs seen", "data": {"a": 2, "b": 3}},
        {"type": "progress", "fraction": 1.0},
        {"type": "result", "outputs": {"result": 5}},
    ]


def test_execute_applies_defaults(client) -> None:
    assert client.execute("demo.add", {"a": 2}).lines[-1] == {"type": "result", "outputs": {"result": 3}}


def test_node_error_line(client) -> None:
    r = client.execute("demo.failExpected", {"message": "nope"})
    assert r.status == 200
    assert r.lines == [{"type": "error", "code": "demo.bad", "message": "nope", "retryable": True,
                        "details": {"why": "test"}}]


def test_unexpected_exception_becomes_node_failed(client, capfd) -> None:
    r = client.execute("demo.failUnexpected", {"x": 7})
    assert r.lines == [{"type": "error", "code": "node.failed", "message": "boom 7", "retryable": False,
                        "details": {}}]
    assert "RuntimeError: boom 7" in capfd.readouterr().err


def test_cancelled_while_connected_is_node_cancelled_line(client) -> None:
    r = client.execute("demo.giveUp", {"reason": "user stopped it"})
    assert r.status == 200
    assert r.lines == [{"type": "error", "code": "node.cancelled", "message": "user stopped it",
                        "retryable": False, "details": {}}]
    line = client.execute("demo.giveUp", {"reason": ""}).lines[-1]
    assert line["code"] == "node.cancelled" and line["message"] == "demo.giveUp was cancelled."


def test_invalid_output(client) -> None:
    line = client.execute("demo.badOutput", {"x": 1}).lines[-1]
    assert line["type"] == "error" and line["code"] == "node.invalid_output"
    assert line["details"] == {"path": "outputs.result"}
    assert "outputs.result must be a whole number" in line["message"]


def test_outputs_dataclass(client) -> None:
    assert client.execute("demo.split", {"text": "a b"}).lines[-1]["outputs"] == {"first": "a", "second": "b"}
    assert client.execute("demo.split", {"text": "a"}).lines[-1]["outputs"] == {"first": "a", "second": None}


def test_struct_in_and_out(client) -> None:
    r = client.execute("demo.shift", {"p": {"x": 1}, "dx": 5})
    assert r.lines[-1]["outputs"] == {"result": {"x": 6, "y": 0}}


def test_async_node(client) -> None:
    r = client.execute("demo.slowUpper", {"text": "hi"})
    assert r.lines[-1] == {"type": "result", "outputs": {"result": "HI"}}


def test_none_return_gives_empty_outputs(client) -> None:
    assert client.execute("demo.nothing", {"x": 1}).lines == [{"type": "result", "outputs": {}}]


def test_secrets_only_declared_names(client) -> None:
    r = client.execute("demo.useSecret", {"name": "API_KEY"}, secrets={"API_KEY": "k1", "LEAK": "x"})
    assert r.lines[-1]["outputs"]["result"] == "k1|['API_KEY']"
    missing = client.execute("demo.useSecret", {"name": "OTHER"}, secrets={"API_KEY": "k1"}).lines[-1]
    assert missing["code"] == "node.missing_secret"
    undeclared = client.execute("demo.useSecret", {"name": "LEAK"}, secrets={"LEAK": "x"}).lines[-1]
    assert undeclared["code"] == "node.secret_not_declared"


def test_media_passthrough_drops_url(client) -> None:
    r = client.execute("demo.passthrough", {"image": dict(REF, url="http://127.0.0.1:9/media/t")})
    assert r.lines[-1]["outputs"] == {"result": REF}


def test_media_created_is_dollar_media(client) -> None:
    out = client.execute("demo.makeImage", {"size": 3}).lines[-1]["outputs"]["result"]
    assert out == [{"$media": {"mime": "image/png", "base64": base64.b64encode(b"\x00\x00\x00").decode(),
                               "filename": "z.png", "meta": {"width": 3}}}]


def test_media_read_via_url(client) -> None:
    payload = b"hello media"

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *a):
            pass

    media = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=media.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{media.server_address[1]}/media/tok_1"
        r = client.execute("demo.readMedia", {"image": dict(REF, url=url)})
        assert r.lines[-1] == {"type": "result", "outputs": {"result": len(payload)}}
        # no url -> clear NodeError
        r = client.execute("demo.readMedia", {"image": REF})
        assert r.lines[-1]["code"] == "node.invalid_input"
    finally:
        media.shutdown()
        media.server_close()


# ---------------------------------------------------------------- errors before streaming


def test_unknown_node(client) -> None:
    r = client.execute("demo.missing", {})
    assert r.status == 404
    err = r.json()["error"]
    assert err["code"] == "protocol.unknown_node" and "demo.missing" in err["message"]
    assert r.headers["x-briarflow-protocol"] == "1"


def test_bad_json(client) -> None:
    r = client.request("POST", "/briarflow/execute", b"{not json")
    assert r.status == 400 and r.json()["error"]["code"] == "protocol.bad_request"


@pytest.mark.parametrize(
    "body",
    [
        {"protocol": 1},
        {"protocol": 1, "nodeType": "demo.add", "inputs": []},
        {"protocol": 1, "nodeType": "demo.add", "inputs": {}, "attempt": 0},
        {"nodeType": "demo.add", "inputs": {"a": 1}},
        [1, 2],
    ],
)
def test_bad_request_fields(client, body) -> None:
    r = client.request("POST", "/briarflow/execute", body)
    assert r.status == 400 and r.json()["error"]["code"] == "protocol.bad_request"


def test_unsupported_protocol_version(client) -> None:
    r = client.execute("demo.add", {"a": 1}, protocol=2)
    assert r.status == 409 and r.json()["error"]["code"] == "protocol.unsupported_version"


@pytest.mark.parametrize(
    "inputs,path,message",
    [
        ({"a": "x"}, "inputs.a", 'inputs.a must be a whole number (got "x")'),
        ({"a": 1, "b": 101}, "inputs.b", "inputs.b must be <= 100"),
        ({}, "inputs.a", "inputs.a is required"),
    ],
)
def test_invalid_inputs(client, inputs, path, message) -> None:
    r = client.execute("demo.add", inputs)
    assert r.status == 422
    assert r.json() == {"error": {"code": "node.invalid_input", "message": message, "details": {"path": path}}}


def test_invalid_struct_input_path(client) -> None:
    r = client.execute("demo.shift", {"p": {"x": 1, "z": 2}})
    assert r.status == 422 and r.json()["error"]["details"]["path"] == "inputs.p.z"


# ---------------------------------------------------------------- auth


def test_auth_token(serve_pack) -> None:
    c = serve_pack(demo, token="s3cret")
    for path in ("/briarflow/health", "/briarflow/manifest"):
        r = c.get(path, token=None)
        assert r.status == 401 and r.json()["error"]["code"] == "protocol.unauthorized"
        assert r.headers["x-briarflow-protocol"] == "1"
        assert c.get(path, token="wrong").status == 401
        assert c.get(path).status == 200
    assert c.execute("demo.add", {"a": 1}, token=None).status == 401
    assert c.execute("demo.add", {"a": 1}).lines[-1]["outputs"] == {"result": 2}


# ---------------------------------------------------------------- keep-alive + concurrency


def test_keep_alive_across_requests(client) -> None:
    conn = http.client.HTTPConnection(client.worker.host, client.worker.port, timeout=5)
    try:
        for i in range(3):
            body = json.dumps({"protocol": 1, "nodeType": "demo.add", "inputs": {"a": i}})
            conn.request("POST", "/briarflow/execute", body=body)
            res = conn.getresponse()
            lines = [json.loads(x) for x in res.read().splitlines()]
            assert lines[-1]["outputs"]["result"] == i + 1
        conn.request("GET", "/briarflow/health")
        assert conn.getresponse().status == 200
    finally:
        conn.close()


def test_parallel_executions(client) -> None:
    results: list[int] = []

    def run(i: int) -> None:
        results.append(client.execute("demo.add", {"a": i, "b": 0}).lines[-1]["outputs"]["result"])

    threads = [threading.Thread(target=run, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == list(range(8))


# ---------------------------------------------------------------- serve() as a process


def test_serve_prints_ready_line_and_stops_on_sigterm(tmp_path) -> None:
    env = dict(os.environ, BRIARFLOW_PORT="0", BRIARFLOW_TOKEN="tok", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "examples" / "imaging_nodes.py")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    try:
        line = proc.stdout.readline().strip()  # type: ignore[union-attr]
        assert line.startswith("briarflow-worker ready port=")
        port = int(line.split("=", 1)[1])
        assert port > 0
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/briarflow/health", headers={"Authorization": "Bearer tok"})
        res = conn.getresponse()
        assert res.status == 200 and json.loads(res.read())["pack"]["name"] == "imaging"
        conn.close()
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
