/**
 * @briarflow/python — run Python Briarflow nodes from a TypeScript engine (Node only).
 * Protocol: docs/specs/python-protocol.md.
 *
 * @example
 * ```ts
 * import { spawnPythonWorker } from "@briarflow/python";
 * const worker = await spawnPythonWorker({ args: ["my_nodes.py"] });
 * const pack = await worker.pack();
 * // A Python pack is a normal NodePack: pass it to the facade, which also closes it on briar.close().
 * const briar = createBriar({ packs: [pack] });
 * ```
 */
export { PROTOCOL_VERSION, pythonPack } from "./bridge.js";
export type { PythonManifest, PythonNodePack, PythonPackOptions } from "./bridge.js";
export { PythonBridgeError } from "./errors.js";
export { MAX_MEDIA_OUT_BYTES } from "./media.js";
export type { MediaServerOptions } from "./media-server.js";
export { spawnPythonWorker } from "./worker.js";
export type { PythonWorker, PythonWorkerStatus, SpawnPythonWorkerOptions } from "./worker.js";
