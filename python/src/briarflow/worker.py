"""The stdlib HTTP worker implementing Briarflow Python protocol v1."""

from __future__ import annotations

import hmac
import json
import os
import select
import signal
import socket
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ._version import PROTOCOL_VERSION, __version__
from .context import ExecContext, MediaHelper, Secrets
from .errors import Cancelled, NodeError
from .pack import Pack
from .typebind import InvalidValue

MAX_BODY_BYTES = 256 * 1024 * 1024
READY_PREFIX = "briarflow-worker ready port="


def _dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default).encode(
        "utf-8"
    )


def _json_default(o: Any) -> Any:
    if hasattr(o, "to_json"):
        return o.to_json()
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


class _Stream:
    """Chunked NDJSON writer shared by the node thread(s) and the handler."""

    def __init__(self, handler: "_Handler", cancelled: threading.Event) -> None:
        self._h = handler
        self._lock = threading.Lock()
        self._cancelled = cancelled
        self._ended = False

    def send(self, line: dict[str, Any]) -> bool:
        data = _dumps(line) + b"\n"
        with self._lock:
            if self._ended or self._cancelled.is_set():
                return False
            try:
                self._h.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self._h.wfile.flush()
                return True
            except OSError:
                self._cancelled.set()
                return False

    def end(self) -> None:
        with self._lock:
            if self._ended:
                return
            self._ended = True
            if self._cancelled.is_set():
                return
            try:
                self._h.wfile.write(b"0\r\n\r\n")
                self._h.wfile.flush()
            except OSError:
                self._cancelled.set()


def _watch_disconnect(sock: socket.socket, cancelled: threading.Event, done: threading.Event) -> None:
    """Sets ``cancelled`` when the client closes its side of the connection."""
    while not done.is_set() and not cancelled.is_set():
        try:
            readable, _, _ = select.select([sock], [], [], 0.05)
        except (OSError, ValueError):
            cancelled.set()
            return
        if not readable:
            continue
        try:
            peek = sock.recv(1, socket.MSG_PEEK)
        except BlockingIOError:
            continue
        except OSError:
            cancelled.set()
            return
        if not peek:
            cancelled.set()
        return  # EOF -> cancelled; any data -> client is pipelining, stop watching


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"briarflow-python/{__version__}"
    server: "_Server"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if self.server.verbose:
            super().log_message(format, *args)

    # ------------------------------------------------------------------ helpers

    def _send_json(self, status: int, body: Any) -> None:
        data = _dumps(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Briarflow-Protocol", str(PROTOCOL_VERSION))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        err: dict[str, Any] = {"code": code, "message": message}
        if details is not None:
            err["details"] = details
        self._send_json(status, {"error": err})

    def _authorized(self) -> bool:
        token = self.server.token
        if not token:
            return True
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {token}"
        if hmac.compare_digest(header.encode("utf-8"), expected.encode("utf-8")):
            return True
        self.close_connection = True
        self._error(
            401,
            "protocol.unauthorized",
            "Missing or wrong bearer token. Send 'Authorization: Bearer <token>' with the "
            "token the worker was started with.",
        )
        return False

    def _route(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    # ------------------------------------------------------------------ methods

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        route = self._route()
        pack = self.server.pack
        if route == "/briarflow/health":
            self._send_json(
                200,
                {"ok": True, "protocol": PROTOCOL_VERSION, "pack": {"name": pack.name, "version": pack.version}},
            )
        elif route == "/briarflow/manifest":
            self._send_json(200, pack.manifest())
        elif route == "/briarflow/execute":
            self._error(405, "protocol.method_not_allowed", "Use POST for /briarflow/execute.")
        else:
            self._error(404, "protocol.not_found", f"No endpoint {route}.")

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        route = self._route()
        if route != "/briarflow/execute":
            self.close_connection = True
            if route in ("/briarflow/health", "/briarflow/manifest"):
                self._error(405, "protocol.method_not_allowed", f"Use GET for {route}.")
            else:
                self._error(404, "protocol.not_found", f"No endpoint {route}.")
            return
        self._execute()

    # ------------------------------------------------------------------ execute

    def _read_body(self) -> bytes | None:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            total = 0
            while True:
                size_line = self.rfile.readline(1024)
                size = int(size_line.split(b";", 1)[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                        pass
                    break
                total += size
                if total > MAX_BODY_BYTES:
                    return None
                chunks.append(self.rfile.read(size))
                self.rfile.readline(1024)
            return b"".join(chunks)
        length = self.headers.get("Content-Length")
        if length is None:
            return b""
        n = int(length)
        if n < 0 or n > MAX_BODY_BYTES:
            return None
        return self.rfile.read(n)

    def _execute(self) -> None:
        try:
            raw = self._read_body()
        except (ValueError, OSError):
            raw = None
        if raw is None:
            self.close_connection = True
            self._error(400, "protocol.bad_request", "Could not read the request body.")
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, "protocol.bad_request", f"Request body is not valid JSON: {exc}")
            return
        if not isinstance(body, dict):
            self._error(400, "protocol.bad_request", "Request body must be a JSON object.")
            return

        protocol = body.get("protocol")
        if protocol is None:
            self._error(400, "protocol.bad_request", "Missing field 'protocol' (expected 1).")
            return
        if protocol != PROTOCOL_VERSION or isinstance(protocol, bool):
            self._error(
                409,
                "protocol.unsupported_version",
                f"This worker speaks protocol {PROTOCOL_VERSION}; the request uses {protocol!r}.",
            )
            return

        node_type = body.get("nodeType")
        inputs = body.get("inputs", {})
        config = body.get("config", {})
        secrets = body.get("secrets", {})
        attempt = body.get("attempt", 1)
        timeout_ms = body.get("timeoutMs")
        problems = []
        if not isinstance(node_type, str) or not node_type:
            problems.append("'nodeType' must be a non-empty string")
        if not isinstance(inputs, dict):
            problems.append("'inputs' must be an object")
        if not isinstance(config, dict):
            problems.append("'config' must be an object")
        if not isinstance(secrets, dict) or not all(isinstance(v, str) for v in secrets.values()):
            problems.append("'secrets' must be an object of strings")
        if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
            problems.append("'attempt' must be an integer >= 1")
        for key in ("runId", "nodeId"):
            if key in body and not isinstance(body[key], str):
                problems.append(f"'{key}' must be a string")
        if timeout_ms is not None and (isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float))):
            problems.append("'timeoutMs' must be a number")
        if problems:
            self._error(400, "protocol.bad_request", "Invalid execute request: " + "; ".join(problems) + ".")
            return

        spec = self.server.pack.node(node_type)
        if spec is None:
            known = ", ".join(self.server.pack.nodes) or "none"
            self._error(
                404,
                "protocol.unknown_node",
                f"Node type {node_type} is not in pack {self.server.pack.name}. Known types: {known}.",
            )
            return

        try:
            kwargs = spec.convert_inputs(inputs)
        except InvalidValue as exc:
            self._error(422, "node.invalid_input", str(exc), {"path": exc.path})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Briarflow-Protocol", str(PROTOCOL_VERSION))
        self.end_headers()
        self.wfile.flush()

        cancelled = threading.Event()
        done = threading.Event()
        stream = _Stream(self, cancelled)
        watcher = threading.Thread(
            target=_watch_disconnect, args=(self.connection, cancelled, done), daemon=True
        )
        watcher.start()

        ctx = ExecContext(
            run_id=body.get("runId", ""),
            node_id=body.get("nodeId", ""),
            node_type=spec.type,
            attempt=attempt,
            timeout_ms=int(timeout_ms) if timeout_ms is not None else None,
            secrets=Secrets(spec.secrets, secrets),
            emit=stream.send,
            cancel_event=cancelled,
            media=MediaHelper(),
        )

        terminal: dict[str, Any] | None
        try:
            result = spec.call(kwargs, ctx)
            if cancelled.is_set():
                terminal = None
            else:
                try:
                    terminal = {"type": "result", "outputs": spec.convert_outputs(result)}
                except InvalidValue as exc:
                    terminal = NodeError(
                        "node.invalid_output", f"{spec.type}: {exc}", details={"path": exc.path}
                    ).to_line()
        except Cancelled as exc:
            # Client gone: nobody to tell. Still connected (the node raised it itself): report it.
            terminal = None if cancelled.is_set() else {
                "type": "error",
                "code": "node.cancelled",
                "message": (
                    f"{spec.type} was cancelled."
                    if str(exc) in ("", Cancelled.DEFAULT_MESSAGE)
                    else str(exc)
                ),
                "retryable": False,
                "details": {},
            }
        except NodeError as exc:
            terminal = exc.to_line()
        except Exception as exc:  # noqa: BLE001 - every failure must become an error line
            if cancelled.is_set():
                terminal = None
            else:
                sys.stderr.write(f"briarflow: node {spec.type} failed:\n{traceback.format_exc()}")
                sys.stderr.flush()
                terminal = {
                    "type": "error",
                    "code": "node.failed",
                    "message": str(exc) or type(exc).__name__,
                    "retryable": False,
                    "details": {},
                }
        finally:
            done.set()

        if terminal is not None:
            stream.send(terminal)
        else:
            self.close_connection = True
        stream.end()
        if cancelled.is_set():
            self.close_connection = True


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr: tuple[str, int], pack: Pack, token: str | None, verbose: bool) -> None:
        self.pack = pack
        self.token = token or None
        self.verbose = verbose
        if ":" in addr[0]:
            self.address_family = socket.AF_INET6
        super().__init__(addr, _Handler)


class Worker:
    """A worker bound to a socket. ``serve()`` is the blocking convenience wrapper.

    Example (tests, embedding):
        w = Worker(my_pack, port=0)
        w.start()                     # background thread
        print(w.url)
        w.stop()
    """

    def __init__(
        self,
        pack: Pack,
        host: str = "127.0.0.1",
        port: int = 8765,
        token: str | None = None,
        verbose: bool = False,
    ) -> None:
        if not isinstance(pack, Pack):
            raise TypeError(f"Worker needs a Pack built with pack(...), got {type(pack).__name__}")
        self.pack = pack
        self._httpd = _Server((host, port), pack, token, verbose)
        self._thread: threading.Thread | None = None

    @property
    def host(self) -> str:
        return self._httpd.server_address[0]

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def url(self) -> str:
        host = self.host
        if ":" in host:
            host = f"[{host}]"
        return f"http://{host}:{self.port}"

    def serve_forever(self) -> None:
        self._httpd.serve_forever(poll_interval=0.2)

    def start(self) -> "Worker":
        self._thread = threading.Thread(target=self.serve_forever, name="briarflow-worker", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> "Worker":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()


def serve(
    pack: Pack,
    host: str = "127.0.0.1",
    port: int = 8765,
    token: str | None = None,
    *,
    verbose: bool = False,
) -> None:
    """Runs the worker until SIGTERM/SIGINT (blocking).

    Env ``BRIARFLOW_HOST``, ``BRIARFLOW_PORT`` and ``BRIARFLOW_TOKEN`` override the arguments.
    Port ``0`` picks a free port. Prints ``briarflow-worker ready port=<n>`` once listening.

    Example:
        if __name__ == "__main__":
            serve(imaging)
    """
    host = os.environ.get("BRIARFLOW_HOST") or host
    env_port = os.environ.get("BRIARFLOW_PORT")
    if env_port not in (None, ""):
        try:
            port = int(env_port)
        except ValueError:
            raise ValueError(f"BRIARFLOW_PORT must be a port number, got {env_port!r}") from None
    env_token = os.environ.get("BRIARFLOW_TOKEN")
    if env_token is not None:
        token = env_token or None

    worker = Worker(pack, host=host, port=port, token=token, verbose=verbose)

    def _stop(signum: int, frame: Any) -> None:
        threading.Thread(target=worker._httpd.shutdown, daemon=True).start()

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, _stop)

    sys.stdout.write(f"{READY_PREFIX}{worker.port}\n")
    sys.stdout.flush()
    try:
        worker.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        worker._httpd.server_close()
