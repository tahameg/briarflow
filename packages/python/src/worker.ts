import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { isMainThread } from "node:worker_threads";
import { NodeError, noopLogger } from "@briarflow/core";
import type { Logger } from "@briarflow/core";
import { fetchManifest, manifestToPack } from "./bridge.js";
import type { Connection, PythonManifest, PythonNodePack, WorkerTarget } from "./bridge.js";
import { PythonBridgeError } from "./errors.js";

const READY_LINE = /^briarflow-worker ready port=(\d+)\s*$/;
const STDERR_TAIL = 20;
const MAX_RESTART_DELAY_MS = 10_000;

/** Options of {@link spawnPythonWorker} (python-protocol.md §3.2). */
export interface SpawnPythonWorkerOptions {
  /** Default `"python3"` (`"python"` on Windows). */
  command?: string;
  /** E.g. `["-m", "my_nodes"]` or `["my_nodes.py"]`. */
  args: string[];
  cwd?: string;
  /** Merged over `process.env`. */
  env?: Record<string, string>;
  /** Default `"127.0.0.1"`. */
  host?: string;
  /** Default `"auto"` (the worker binds a free port and reports it on stdout). */
  port?: number | "auto";
  /** Default: a random 32-byte hex token; `false` = no token. */
  token?: string | false;
  /** Default 20 000. */
  readyTimeoutMs?: number;
  /** Default `"on-failure"`. */
  restart?: "never" | "on-failure" | "always";
  /** Default 5 within `restartWindowMs`. */
  maxRestarts?: number;
  /** Default 60 000. */
  restartWindowMs?: number;
  /** Default 500, doubled per consecutive restart, max 10 000. */
  restartDelayMs?: number;
  /** Default 5 000. */
  shutdownTimeoutMs?: number;
  /** stdout → info, stderr → warn, one call per line, data `{ source: "python" }`. */
  logger?: Logger;
}

/** Lifecycle state of a spawned worker. */
export type PythonWorkerStatus = "starting" | "ready" | "restarting" | "stopped" | "failed";

/** A Python worker process managed by the bridge. */
export interface PythonWorker {
  /** Current base URL (may change after a restart). */
  readonly url: string;
  readonly status: PythonWorkerStatus;
  /** The worker's pack; stays valid across restarts (it always targets the current url). */
  pack(): Promise<PythonNodePack>;
  restart(): Promise<void>;
  /** Idempotent. SIGTERM, then SIGKILL after `shutdownTimeoutMs`. */
  stop(): Promise<void>;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

const live = new Set<ManagedWorker>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", () => {
    for (const worker of live) worker.killNow();
  });
  if (!isMainThread) return;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      for (const worker of live) worker.killNow();
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, handler);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, handler);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

class ManagedWorker implements PythonWorker {
  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: Record<string, string>;
  readonly #host: string;
  readonly #port: number | "auto";
  readonly #token: string | undefined;
  readonly #readyTimeoutMs: number;
  readonly #restartPolicy: "never" | "on-failure" | "always";
  readonly #maxRestarts: number;
  readonly #restartWindowMs: number;
  readonly #restartDelayMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #logger: Logger;

  #status: PythonWorkerStatus = "starting";
  #url = "";
  #child: ChildProcess | undefined;
  #lost = new AbortController();
  #waiters: Waiter[] = [];
  #restartTimes: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #stopPromise: Promise<void> | undefined;
  #pack: Promise<PythonNodePack> | undefined;
  #manifest: PythonManifest | undefined;

  constructor(options: SpawnPythonWorkerOptions) {
    this.#command = options.command ?? (process.platform === "win32" ? "python" : "python3");
    this.#args = options.args;
    this.#cwd = options.cwd;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? "auto";
    this.#token = options.token === false ? undefined : (options.token ?? randomBytes(32).toString("hex"));
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    this.#restartPolicy = options.restart ?? "on-failure";
    this.#maxRestarts = options.maxRestarts ?? 5;
    this.#restartWindowMs = options.restartWindowMs ?? 60_000;
    this.#restartDelayMs = options.restartDelayMs ?? 500;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.#logger = options.logger ?? noopLogger;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    this.#env = {
      PYTHONUNBUFFERED: "1",
      ...env,
      ...options.env,
      BRIARFLOW_HOST: this.#host,
      BRIARFLOW_PORT: this.#port === "auto" ? "0" : String(this.#port),
      BRIARFLOW_TOKEN: this.#token ?? "",
    };
  }

  get url(): string {
    return this.#url;
  }

  get status(): PythonWorkerStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    live.add(this);
    installExitHooks();
    try {
      await this.#launch();
      this.#setStatus("ready");
    } catch (err) {
      if (this.#status !== "stopped") this.#setStatus("failed");
      live.delete(this);
      throw err;
    }
  }

  pack(): Promise<PythonNodePack> {
    this.#pack ??= (async () => {
      await this.#waitReady();
      const manifest = await fetchManifest(this.#url, { token: this.#token });
      this.#manifest = manifest;
      return manifestToPack(manifest, this.connection());
    })();
    this.#pack.catch(() => {
      this.#pack = undefined;
    });
    return this.#pack;
  }

  /** Connection that follows restarts. @internal */
  connection(): Connection {
    return {
      token: this.#token,
      fetch: (...args) => globalThis.fetch(...args),
      acquire: (signal) => this.#acquire(signal),
    };
  }

  async restart(): Promise<void> {
    if (this.#status === "stopped") {
      throw new PythonBridgeError("python.worker_exited", "The Python worker was stopped; spawn a new one instead of restarting it.");
    }
    clearTimeout(this.#restartTimer);
    this.#setStatus("restarting");
    const child = this.#child;
    this.#child = undefined;
    this.#lost.abort(new Error("restart"));
    if (child) await this.#terminate(child);
    try {
      await this.#launch();
      this.#setStatus("ready");
      void this.#checkManifest();
    } catch (err) {
      if ((this.#status as PythonWorkerStatus) !== "stopped") this.#setStatus("failed");
      throw err;
    }
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      clearTimeout(this.#restartTimer);
      this.#setStatus("stopped");
      live.delete(this);
      const child = this.#child;
      this.#child = undefined;
      this.#lost.abort(new Error("stopped"));
      if (child) await this.#terminate(child);
      const pack = await this.#pack?.catch(() => undefined);
      await pack?.close();
    })();
    return this.#stopPromise;
  }

  /** Synchronous best-effort kill (process exit hooks). */
  killNow(): void {
    const child = this.#child;
    if (child && !hasExited(child)) child.kill("SIGKILL");
  }

  // ------------------------------------------------------------------ internals

  #setStatus(status: PythonWorkerStatus): void {
    this.#status = status;
    if (status === "ready") {
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const w of waiters) w.resolve();
    } else if (status === "failed" || status === "stopped") {
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const w of waiters) w.reject(this.#exitError());
    }
  }

  #exitError(): NodeError {
    const final = this.#status === "failed" || this.#status === "stopped";
    return new NodeError(
      "python.worker_exited",
      final
        ? `The Python worker (${this.#command} ${this.#args.join(" ")}) is ${this.#status === "failed" ? "down and will not be restarted" : "stopped"}. Check its log output.`
        : `The Python worker (${this.#command} ${this.#args.join(" ")}) exited during the execution; it is being restarted.`,
      { retryable: !final },
    );
  }

  #waitReady(signal?: AbortSignal): Promise<void> {
    if (this.#status === "ready") return Promise.resolve();
    if (this.#status === "failed" || this.#status === "stopped") return Promise.reject(this.#exitError());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      const onAbort = (): void => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new NodeError("node.cancelled", "The execution was cancelled while waiting for the Python worker.", { cause: signal?.reason }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  async #acquire(signal: AbortSignal): Promise<WorkerTarget> {
    await this.#waitReady(signal);
    return { url: this.#url, lost: this.#lost.signal, lostError: () => this.#exitError() };
  }

  async #terminate(child: ChildProcess): Promise<void> {
    if (hasExited(child)) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, this.#shutdownTimeoutMs)) return;
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }

  #launch(): Promise<void> {
    const child = spawn(this.#command, this.#args, {
      ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
      env: this.#env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#lost = new AbortController();
    const stderrTail: string[] = [];
    let ready = false;

    createInterface({ input: child.stderr! }).on("line", (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
      this.#logger.warn(line, { source: "python" });
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const describe = `${this.#command} ${this.#args.join(" ")}`;
      const fail = (reason: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (!hasExited(child)) child.kill("SIGKILL");
        if (this.#child === child) this.#child = undefined;
        const tail = stderrTail.length > 0 ? `\nLast stderr lines:\n${stderrTail.join("\n")}` : "";
        reject(
          new PythonBridgeError("python.worker_not_ready", `Python worker "${describe}" ${reason}.${tail}`, {
            details: { command: this.#command, args: this.#args, stderr: [...stderrTail] },
            ...(cause !== undefined ? { cause } : {}),
          }),
        );
      };
      const deadline = setTimeout(
        () => fail(`did not become ready within ${this.#readyTimeoutMs} ms (it must print "briarflow-worker ready port=<n>" and answer /briarflow/health)`),
        this.#readyTimeoutMs,
      );

      createInterface({ input: child.stdout! }).on("line", (line) => {
        const match = ready ? null : READY_LINE.exec(line);
        if (match === null) {
          this.#logger.info(line, { source: "python" });
          return;
        }
        ready = true;
        const host = this.#host === "0.0.0.0" ? "127.0.0.1" : this.#host === "::" ? "::1" : this.#host;
        this.#url = `http://${host.includes(":") ? `[${host}]` : host}:${match[1]}`;
        void this.#pollHealth(() => settled).then(
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve();
          },
          (err: unknown) => fail("did not answer GET /briarflow/health", err),
        );
      });

      child.once("error", (err) => fail(`could not be started: ${err.message}`, err));
      child.once("exit", (code, signal) => {
        if (!settled) {
          // let the last stderr lines arrive before reporting
          const report = (): void => fail(`exited (${signal ?? `code ${code}`}) before it was ready`);
          child.once("close", report);
          setTimeout(report, 200);
          return;
        }
        this.#onExit(child, code, signal);
      });
    });
  }

  async #pollHealth(cancelled: () => boolean): Promise<void> {
    const headers: Record<string, string> = this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
    let lastError: unknown = new Error("cancelled");
    while (!cancelled()) {
      let status = 0;
      try {
        const res = await fetch(`${this.#url}/briarflow/health`, { headers, signal: AbortSignal.timeout(2_000) });
        status = res.status;
        const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
        if (res.ok && body?.ok === true) return;
        lastError = new Error(`health answered HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      if (status === 401) throw new Error("the worker rejected the bearer token (HTTP 401)");
      await sleep(100);
    }
    throw lastError;
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return; // stopped or replaced on purpose
    this.#child = undefined;
    const how = signal ?? `code ${code}`;
    const clean = code === 0 && signal === null;
    const restart = this.#restartPolicy === "always" || (this.#restartPolicy === "on-failure" && !clean);
    if (!restart) {
      this.#logger.error(`Python worker exited (${how}); restart policy "${this.#restartPolicy}" does not restart it.`, { source: "python" });
      this.#setStatus(clean ? "stopped" : "failed");
      live.delete(this);
      this.#lost.abort(new Error("exited"));
      return;
    }
    this.#logger.warn(`Python worker exited unexpectedly (${how}); restarting.`, { source: "python" });
    this.#scheduleRestart();
    this.#lost.abort(new Error("exited"));
  }

  #scheduleRestart(): void {
    const now = Date.now();
    this.#restartTimes = this.#restartTimes.filter((at) => now - at < this.#restartWindowMs);
    if (this.#restartTimes.length >= this.#maxRestarts) {
      this.#logger.error(
        `Python worker restarted ${this.#restartTimes.length} times within ${this.#restartWindowMs} ms; giving up.`,
        { source: "python" },
      );
      this.#setStatus("failed");
      live.delete(this);
      return;
    }
    const delay = Math.min(this.#restartDelayMs * 2 ** this.#restartTimes.length, MAX_RESTART_DELAY_MS);
    this.#restartTimes.push(now);
    this.#setStatus("restarting");
    this.#restartTimer = setTimeout(() => {
      if (this.#status !== "restarting") return;
      this.#launch().then(
        () => {
          if (this.#status !== "restarting") return;
          this.#setStatus("ready");
          void this.#checkManifest();
        },
        (err: unknown) => {
          if (this.#status !== "restarting") return;
          this.#logger.error(err instanceof Error ? err.message : String(err), { source: "python" });
          this.#scheduleRestart();
        },
      );
    }, delay);
  }

  async #checkManifest(): Promise<void> {
    const before = this.#manifest;
    if (before === undefined) return;
    try {
      const after = await fetchManifest(this.#url, { token: this.#token });
      if (after.pack.name !== before.pack.name || after.pack.version !== before.pack.version) {
        this.#logger.error(
          `Restarted Python worker serves pack ${after.pack.name}@${after.pack.version}, but the bridge loaded ${before.pack.name}@${before.pack.version}. Keeping the old node set; restart the engine to load the new pack.`,
          { source: "python" },
        );
      }
    } catch (err) {
      this.#logger.error(`Could not read the restarted Python worker's manifest: ${err instanceof Error ? err.message : String(err)}`, {
        source: "python",
      });
    }
  }
}

/**
 * Starts a Python worker process, waits until it is ready and keeps it running according to
 * the restart policy.
 *
 * @example
 * ```ts
 * const worker = await spawnPythonWorker({ command: "python3", args: ["my_nodes.py"] });
 * const briar = createBriar({ packs: [stdPack, await worker.pack()] });
 * // on shutdown: await worker.stop();
 * ```
 */
export async function spawnPythonWorker(options: SpawnPythonWorkerOptions): Promise<PythonWorker> {
  const worker = new ManagedWorker(options);
  await worker.start();
  return worker;
}
