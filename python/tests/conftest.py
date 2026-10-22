from __future__ import annotations

import http.client
import json
import sys
from pathlib import Path
from typing import Any, Iterator

import pytest

from briarflow import Pack, Worker

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
if str(EXAMPLES) not in sys.path:
    sys.path.insert(0, str(EXAMPLES))


class Response:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        return json.loads(self.body)

    @property
    def lines(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.body.decode("utf-8").splitlines() if line.strip()]


class Client:
    def __init__(self, worker: Worker, token: str | None = None) -> None:
        self.worker = worker
        self.token = token

    def request(self, method: str, path: str, body: Any = None, token: str | None = ...) -> Response:  # type: ignore[assignment]
        tok = self.token if token is ... else token
        conn = http.client.HTTPConnection(self.worker.host, self.worker.port, timeout=10)
        headers = {}
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        try:
            conn.request(method, path, body=data, headers=headers)
            res = conn.getresponse()
            return Response(res.status, {k.lower(): v for k, v in res.getheaders()}, res.read())
        finally:
            conn.close()

    def get(self, path: str, **kw: Any) -> Response:
        return self.request("GET", path, **kw)

    def execute(self, node_type: str, inputs: dict[str, Any] | None = None, **extra: Any) -> Response:
        token = extra.pop("token", ...)
        body = {"protocol": 1, "nodeType": node_type, "runId": "run_1", "nodeId": "n_1",
                "attempt": 1, "inputs": inputs or {}, "config": {}, "secrets": {}}
        body.update(extra)
        return self.request("POST", "/briarflow/execute", body, token=token)


@pytest.fixture
def serve_pack() -> Iterator[Any]:
    workers: list[Worker] = []

    def start(pack: Pack, token: str | None = None) -> Client:
        w = Worker(pack, host="127.0.0.1", port=0, token=token).start()
        workers.append(w)
        return Client(w, token)

    yield start
    for w in workers:
        w.stop()
