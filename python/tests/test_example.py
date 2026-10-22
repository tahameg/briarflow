import hashlib
import base64
import struct
import zlib

import imaging_nodes


def test_example_manifest_types() -> None:
    m = imaging_nodes.imaging.manifest()
    assert [n["type"] for n in m["nodes"]] == [
        "imaging.uppercase", "imaging.solidImage", "imaging.imageInfo", "imaging.repeat",
        "imaging.countSlowly", "imaging.sign"]
    assert [t["id"] for t in m["types"]] == ["imaging.Swatch", "imaging.Color"]


def test_example_nodes_end_to_end(serve_pack) -> None:
    c = serve_pack(imaging_nodes.imaging)
    assert c.execute("imaging.uppercase", {"text": "briar"}).lines[-1]["outputs"] == {"result": "BRIAR"}

    lines = c.execute("imaging.solidImage", {"swatch": {"color": "briar", "width": 3, "height": 2}}).lines
    assert [line["type"] for line in lines] == ["progress", "progress", "log", "result"]
    media = lines[-1]["outputs"]["result"]["$media"]
    assert media["mime"] == "image/png" and media["filename"] == "briar.png"
    assert media["meta"] == {"width": 3, "height": 2}
    png = base64.b64decode(media["base64"])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    assert (width, height) == (3, 2)
    idat_len = struct.unpack(">I", png[33:37])[0]
    raw = zlib.decompress(png[41:41 + idat_len])
    assert raw[:4] == b"\x00" + bytes((155, 93, 229))

    err = c.execute("imaging.repeat", {"text": "x", "times": 0}).lines[-1]
    assert err["code"] == "imaging.nothing_to_repeat"
    assert c.execute("imaging.repeat", {"text": "x", "times": 3}).lines[-1]["outputs"] == {"result": "x x x"}

    ref = {"uri": "briar-media://m_1", "mime": "image/png", "bytes": 10}
    info = c.execute("imaging.imageInfo", {"image": ref}).lines[-1]["outputs"]
    assert info == {"image": ref, "mime": "image/png", "bytes": 10, "is_png": False}

    lines = c.execute("imaging.countSlowly", {"steps": 3, "delay_ms": 0}).lines
    assert [line["type"] for line in lines] == ["progress"] * 3 + ["result"]
    assert lines[-1]["outputs"] == {"result": 3}

    signed = c.execute("imaging.sign", {"text": "hi"}, secrets={"IMAGING_KEY": "k"}).lines[-1]
    assert signed["outputs"] == {"result": hashlib.sha256(b"khi").hexdigest()}
