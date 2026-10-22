# Briarflow

A strongly typed, graph-based framework for prompt construction and AI-result pipelines.
You build **flows** out of typed **nodes** (text templates, struct make/break, LLM calls, image
generators, your own Python or TypeScript nodes), connect them with edges the type checker
validates, and run them with streamed progress events. Library first; a REST + SSE server and a
visual editor (the studio) sit on top.

- **Typed end to end:** structs, enums, lists, optionals, media types and generics; every edge,
  constant and run input is checked, and errors say what is wrong, where, and how to fix it.
- **Library, server or studio:** the same flows run in-process (`createBriar`), over HTTP
  (`@briarflow/server` + `@briarflow/client`) or from the visual editor.
- **Pluggable:** node packs (`definePack`), storage (`ContextStore` / `MediaStore`), secrets,
  Python nodes through a worker.

## Quick start

### 1. As a library

```ts
import { createBriar } from "briarflow";
import { mockPack } from "@briarflow/nodes-mock";

const briar = createBriar({ packs: [mockPack] });

const ctx = await briar.contexts.create({ name: "Demo" });
const flow = ctx.flows.create("Poster");
flow.inputs.add("topic", "text");
flow.outputs.add("caption", "text");
flow.outputs.add("poster", "image");

const llm = flow.nodes.add("mock.llm");
const image = flow.nodes.add("mock.image");
flow.connect(flow.input.port("topic"), llm.port("prompt"));
flow.connect(llm.port("text"), image.port("prompt"));
flow.connect(llm.port("text"), flow.output.port("caption"));
flow.connect(image.port("image"), flow.output.port("poster"));
await ctx.save();

const run = await briar.run(flow.id, { topic: "a lighthouse at dusk" });
for await (const event of run.events()) console.log(event.type); // run.started, node.started, …
const result = await run.result;
console.log(result.status, result.outputs);                      // "succeeded", { caption, poster }
await briar.close();
```

Swap `mockPack` for a real provider, e.g. `anthropicPack()` from `@briarflow/nodes-anthropic`
with `secrets: envSecrets()` and `ANTHROPIC_API_KEY` set.

### 2. With Docker (server + studio)

```bash
docker build -t briarflow .
docker run -p 3000:3000 -v briarflow-data:/data briarflow
# with the Claude nodes:
docker run -p 3000:3000 -v briarflow-data:/data -e ANTHROPIC_API_KEY=sk-ant-... briarflow
```

Or `docker compose up --build`. Open <http://localhost:3000> for the studio; the API is at
`http://localhost:3000/api/v1` (see [REST API](docs/specs/rest-api.md)). Contexts live in SQLite
and media on disk under the `/data` volume.

> The server has no authentication of its own. Keep it on localhost or put it behind a proxy
> that authenticates; to embed it with your own `authorize` hook, use `@briarflow/server`
> directly.

### 3. Development

```bash
npm install
npm run dev:server        # API on http://localhost:3000 (data in apps/server/data)
npm run dev:studio        # studio on http://localhost:5173 (proxies /api to :3000)
npm run smoke             # end-to-end check against the running server
npm test                  # all Vitest suites
npm run typecheck
```

Requires Node ≥ 20.19. Python nodes need Python ≥ 3.10 (see the Python guide).

## Configuration (server)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `BRIAR_DATA_DIR` | `./data` relative to the working dir (`/data` in Docker) | `briarflow.db` (SQLite) and `media/` |
| `BRIAR_CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma list of allowed origins, or `off` |
| `BRIAR_STUDIO_DIR` | `apps/studio/dist` | Built studio to serve at `/` (`off` to disable) |
| `BRIAR_STUDIO_CONTEXT` | — | Context the studio opens first, by id or name; created at startup when missing |
| `BRIAR_STUDIO_FLOW` | — | Flow of that context to open first, by id or name; created when missing (needs `BRIAR_STUDIO_CONTEXT`) |
| `BRIAR_MOCK_NODES` | `true` | Offer the mock pack (fake LLM / image / 3D nodes) |
| `BRIAR_PYTHON_WORKER_URL`, `BRIAR_PYTHON_WORKER_TOKEN` | — | Load node packs from a Python worker |
| `ANTHROPIC_API_KEY` | — | Enables the `anthropic` pack (Claude nodes) |
| `BRIAR_LOG_LEVEL` | `info` | `debug` for request-level logs |

## Packages

| Package | What it is |
|---|---|
| [`briarflow`](packages/briarflow) | The facade: `createBriar()`, fluent authoring handles, runs, in-memory stores, `envSecrets()` |
| [`@briarflow/core`](packages/core) | Type system, documents, node definition API (`defineNode`, `definePack`), validation, JSON Schema |
| [`@briarflow/authoring`](packages/authoring) | The command set (create flows, types, nodes, edges…) with undo/redo |
| [`@briarflow/runtime`](packages/runtime) | Execution engine: scheduling, events, retries, timeouts, caching, cancellation |
| [`@briarflow/nodes-std`](packages/nodes-std) | Built-in nodes: inputs/outputs, struct make/break, text template, lists, variables |
| [`@briarflow/nodes-mock`](packages/nodes-mock) | Deterministic fake AI nodes for tests and demos |
| [`@briarflow/nodes-anthropic`](packages/nodes-anthropic) | Claude nodes: `anthropic.message`, `anthropic.structured` |
| [`@briarflow/storage-sqlite`](packages/storage-sqlite), [`@briarflow/storage-fs`](packages/storage-fs) | Context and media stores for Node |
| [`@briarflow/python`](packages/python) + [`python/`](python) | Python node SDK and the TypeScript bridge |
| [`@briarflow/server`](packages/server) | REST + SSE API as a Hono app (`createBriarApp`, `serve`) |
| [`@briarflow/client`](packages/client) | Typed client for the API, with resumable run event streams |
| [`@briarflow/editor`](packages/editor), [`@briarflow/editor-react`](packages/editor-react) | Headless editor store and the React Flow canvas |
| [`@briarflow/testing`](packages/testing) | `runNode`, conformance suites, fixtures |
| [`apps/server`](apps/server), [`apps/studio`](apps/studio) | The runnable service and the visual editor |

## Docs

- [Architecture](docs/ARCHITECTURE.md) · [Status](docs/STATUS.md) · [Phases](docs/PHASES.md) · [Decisions](docs/DECISIONS.md)
- Guides: [writing nodes](docs/guides/writing-nodes.md) · [Python nodes](docs/guides/python-nodes.md) · [writing a store](docs/guides/writing-a-store.md)
- Specs: [types](docs/specs/types.md) · [node API](docs/specs/node-api.md) · [commands](docs/specs/commands.md) · [runtime](docs/specs/runtime.md) · [REST API](docs/specs/rest-api.md) · [storage](docs/specs/storage.md) · [variables](docs/specs/variables.md) · [design system](docs/specs/design-system.md)
- Contributing: [AGENTS.md](AGENTS.md)
