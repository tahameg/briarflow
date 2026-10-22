import json
import socket
import threading
import time

from briarflow import Cancelled, ExecContext, node, pack

observed = threading.Event()
raised = threading.Event()
started = threading.Event()
progress_stopped = threading.Event()


@node
def loop(steps: int, *, ctx: ExecContext) -> int:
    started.set()
    for i in range(steps):
        if ctx.cancelled:
            observed.set()
            break
        time.sleep(0.02)
    try:
        ctx.progress(0.9, "after cancel")
    except Cancelled:
        raised.set()
        raise
    return steps


@node
def progress_loop(steps: int, *, ctx: ExecContext) -> int:
    try:
        for i in range(steps):
            ctx.progress(i / steps)  # raises Cancelled once the client is gone
            time.sleep(0.02)
    finally:
        progress_stopped.set()
    return steps


cancel_pack = pack("cancel", "0.1.0", [loop, progress_loop])


def _open_execute(port: int, node_type: str, inputs: dict) -> socket.socket:
    body = json.dumps({"protocol": 1, "nodeType": node_type, "inputs": inputs}).encode()
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(
        b"POST /briarflow/execute HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    return sock


def test_client_disconnect_sets_cancelled_and_progress_raises(serve_pack) -> None:
    client = serve_pack(cancel_pack)
    sock = _open_execute(client.worker.port, "cancel.loop", {"steps": 500})
    head = sock.recv(4096)
    assert b"200 OK" in head and b"application/x-ndjson" in head
    assert started.wait(2)
    sock.close()  # the bridge aborts the request
    assert observed.wait(3), "ctx.cancelled never became True"
    assert raised.wait(3), "ctx.progress did not raise Cancelled after cancellation"
    # worker is still healthy
    assert client.get("/briarflow/health").status == 200


def test_progress_loop_stops_early(serve_pack) -> None:
    client = serve_pack(cancel_pack)
    sock = _open_execute(client.worker.port, "cancel.progressLoop", {"steps": 1000})
    data = b""
    while b"progress" not in data:
        data += sock.recv(4096)
    sock.close()
    # the node would need ~20 s to finish; Cancelled from ctx.progress must stop it early
    assert progress_stopped.wait(3), "node kept running after the client disconnected"
