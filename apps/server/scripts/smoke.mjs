#!/usr/bin/env node
// End-to-end smoke test against a running Briarflow server, using only the REST + SSE API.
//
//   node apps/server/scripts/smoke.mjs [baseUrl] [--keep]   (default http://127.0.0.1:3000)
//
// --keep leaves the created context in place (to open it in the studio).
//
// Creates a context, builds a "Portrait" flow with commands (Character struct → struct.break →
// text.template → mock.llm → mock.image → outputs), runs it, follows the SSE event stream,
// fetches the result and downloads the generated image. Exits 1 on the first failure.

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const base = (args.find((a) => !a.startsWith("--")) ?? process.env.BRIAR_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const api = `${base}/api/v1`;

function fail(message, detail) {
  console.error(`✗ ${message}`);
  if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function call(method, path, body, expected) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text === "" ? undefined : JSON.parse(text);
  if (!expected.includes(res.status)) fail(`${method} ${path} answered ${res.status}, expected ${expected.join("/")}`, json);
  return json;
}

/** Reads an SSE response into events until the stream ends. */
async function readEvents(res) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  return events;
}

const started = Date.now();
const health = await fetch(`${base}/health`).catch((err) => fail(`No server at ${base}: ${err.message}`));
if (!health.ok) fail(`GET /health answered ${health.status}`);
console.log(`✓ server up at ${base}`);

const ctx = await call("POST", "/contexts", { name: `Smoke ${new Date().toISOString()}` }, [201]);
console.log(`✓ created context ${ctx.id}`);

const commands = [
  { op: "type.defineEnum", scope: { kind: "global" }, id: "ty_style", name: "ArtStyle", members: ["anime", "pixel", "oil"] },
  {
    op: "type.defineStruct",
    scope: { kind: "global" },
    id: "ty_char",
    name: "Character",
    fields: [
      { name: "name", type: "text" },
      { name: "role", type: "text" },
      { name: "style", type: "ArtStyle" },
    ],
  },
  { op: "flow.create", name: "Portrait", inputNodeId: "n_in", outputNodeId: "n_out" },
];
const created = await call("POST", `/contexts/${ctx.id}/commands`, { baseRevision: ctx.revision, commands }, [200]);
const flowId = created.created[2].flowId;
const flowCommands = [
  { op: "flow.input.add", flowId, name: "character", type: "Character" },
  { op: "flow.output.add", flowId, name: "description", type: "text" },
  { op: "flow.output.add", flowId, name: "portrait", type: "image" },
  { op: "node.add", flowId, id: "n_brk", type: "briar.struct.break", position: { x: 200, y: 0 }, config: { typeId: "ty_char" } },
  { op: "node.add", flowId, id: "n_tpl", type: "text.template", position: { x: 420, y: 0 }, config: { template: "Describe {name}, a {role}, drawn in {style} style." } },
  { op: "node.add", flowId, id: "n_llm", type: "mock.llm", position: { x: 640, y: 0 } },
  { op: "node.add", flowId, id: "n_img", type: "mock.image", position: { x: 860, y: 0 } },
  { op: "edge.connect", flowId, from: { node: "n_in", port: "character" }, to: { node: "n_brk", port: "value" } },
  { op: "edge.connect", flowId, from: { node: "n_brk", port: "name" }, to: { node: "n_tpl", port: "name" } },
  { op: "edge.connect", flowId, from: { node: "n_brk", port: "role" }, to: { node: "n_tpl", port: "role" } },
  { op: "edge.connect", flowId, from: { node: "n_brk", port: "style" }, to: { node: "n_tpl", port: "style" } },
  { op: "edge.connect", flowId, from: { node: "n_tpl", port: "text" }, to: { node: "n_llm", port: "prompt" } },
  { op: "edge.connect", flowId, from: { node: "n_llm", port: "text" }, to: { node: "n_img", port: "prompt" } },
  { op: "edge.connect", flowId, from: { node: "n_llm", port: "text" }, to: { node: "n_out", port: "description" } },
  { op: "edge.connect", flowId, from: { node: "n_img", port: "image" }, to: { node: "n_out", port: "portrait" } },
];
const built = await call("POST", `/contexts/${ctx.id}/commands`, { baseRevision: created.revision, commands: flowCommands }, [200]);
if (built.diagnostics.some((d) => d.severity === "error")) fail("the built flow has errors", built.diagnostics);
console.log(`✓ built flow ${flowId} with ${commands.length + flowCommands.length} commands (revision ${built.revision}, ${built.diagnostics.length} diagnostics)`);

const info = await call("GET", `/flows/${flowId}`, undefined, [200]);
console.log(`✓ flow signature inputs: ${Object.keys(info.signature.inputs?.properties ?? {}).join(", ")}`);

const inputs = { character: { name: "Mira", role: "sky pirate", style: "oil" } };
const started202 = await call("POST", `/flows/${flowId}/runs`, { inputs }, [202]);
console.log(`✓ started run ${started202.runId}`);

const sse = await fetch(`${api}/runs/${started202.runId}/events`);
if (sse.status !== 200 || !(sse.headers.get("content-type") ?? "").startsWith("text/event-stream")) fail(`SSE answered ${sse.status}`);
const events = await readEvents(sse);
const seqs = events.map((e) => e.seq);
if (seqs.some((s, i) => s !== i)) fail("event seq is not gap-free", seqs);
const last = events.at(-1);
if (last?.type !== "run.completed") fail("the stream did not end with run.completed", events.map((e) => e.type));
console.log(`✓ ${events.length} SSE events: ${[...new Set(events.map((e) => e.type))].join(", ")}`);

const run = await call("GET", `/runs/${started202.runId}`, undefined, [200]);
if (run.status !== "succeeded") fail(`run ${run.status}`, run.result?.error);
const { description, portrait } = run.result.outputs;
console.log(`✓ run succeeded; description: ${JSON.stringify(String(description).slice(0, 80))}…`);

const mediaId = String(portrait?.uri ?? "").replace(/^briar-media:\/\//, "");
const image = await fetch(`${api}/media/${mediaId}`);
if (!image.ok) fail(`GET /media/${mediaId} answered ${image.status}`);
const bytes = new Uint8Array(await image.arrayBuffer());
if (bytes.length === 0 || bytes.length !== portrait.bytes) fail(`image size ${bytes.length} does not match the ref (${portrait.bytes})`);
console.log(`✓ downloaded portrait ${mediaId.slice(0, 12)}… (${image.headers.get("content-type")}, ${bytes.length} bytes)`);

if (keep) {
  console.log(`✓ kept context ${ctx.id} (open it in the studio)`);
} else {
  await call("DELETE", `/contexts/${ctx.id}`, undefined, [204]);
  console.log(`✓ deleted context ${ctx.id}`);
}
console.log(`SMOKE OK in ${Date.now() - started} ms`);
