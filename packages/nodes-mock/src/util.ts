/**
 * Internal helpers of the mock pack.
 */
import { canonicalJson, sha256Hex } from "@briarflow/core";

/**
 * `hash(x)` of node-api.md §10: lowercase sha-256 hex of the UTF-8 canonical JSON of `x`.
 *
 * @example
 * ```ts
 * await mockHash({ prompt: "a cat", seed: 0 });
 * ```
 */
export function mockHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** Waits `ms`, rejecting with the signal's reason when it aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** First `n` code points of a string. */
export function firstChars(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Escapes text for XML content and attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

/** `#rrggbb` from 6 hex digits of a hash. */
export function color(hex: string, offset: number): string {
  return `#${hex.slice(offset, offset + 6).padEnd(6, "0")}`;
}

/** Deterministic SVG image. */
export function mockSvg(prompt: string, width: number, height: number, hex: string): string {
  const rects: string[] = [];
  for (let i = 0; i < 3; i++) {
    const h = hex.slice(8 + i * 12, 20 + i * 12).padEnd(12, "0");
    const x = Math.floor((parseInt(h.slice(0, 2), 16) / 256) * width * 0.7);
    const y = Math.floor((parseInt(h.slice(2, 4), 16) / 256) * height * 0.7);
    const w = Math.max(1, Math.floor(((parseInt(h.slice(4, 6), 16) % 128) / 256 + 0.1) * width));
    const hh = Math.max(1, Math.floor(((parseInt(h.slice(6, 8), 16) % 128) / 256 + 0.1) * height));
    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${color(h, 6)}" fill-opacity="0.75"/>`);
  }
  const fontSize = Math.max(8, Math.floor(Math.min(width, height) / 20));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${color(hex, 0)}"/>` +
    rects.join("") +
    `<text x="${Math.floor(width / 2)}" y="${Math.floor(height / 2)}" font-family="sans-serif" font-size="${fontSize}" text-anchor="middle" fill="#ffffff">` +
    escapeXml(firstChars(prompt, 60)) +
    `</text></svg>`
  );
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Minimal glTF 2.0 JSON cube with an embedded buffer and a base color from the hash. */
export function mockGltf(hex: string): string {
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]);
  const bytes = new Uint8Array(positions.byteLength + indices.byteLength);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength);
  const channel = (i: number) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000;
  const gltf = {
    asset: { version: "2.0", generator: "briarflow mock.model3d" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [channel(0), channel(2), channel(4), 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${base64(bytes)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };
  return JSON.stringify(gltf);
}

/** A silent mono 8-bit WAV of `samples` samples at 8 kHz. */
export function silentWav(samples = 800): Uint8Array {
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}
