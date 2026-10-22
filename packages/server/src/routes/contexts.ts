/**
 * Context routes (rest-api.md §3 "Contexts").
 */
import type { Command } from "@briarflow/authoring";
import { BriarError, isValidId, type ContextDocument, type ContextListQuery } from "@briarflow/core";
import type { Context, Env } from "hono";
import { isObject, readJson } from "../body.js";
import { invalidBody, invalidQuery } from "../errors.js";
import { checkPathId, type RouteKit } from "../kit.js";

const MAX_LIMIT = 200;
const MAX_COMMANDS = 1000;

function contextNotFound(contextId: string): BriarError {
  return new BriarError("context.not_found", `Context "${contextId}" does not exist. Check the id, or list contexts with GET /contexts.`, {
    details: { contextId },
  });
}

/** Loads a context or throws `context.not_found`. */
async function loadContext<E extends Env>(kit: RouteKit<E>, contextId: string): Promise<ContextDocument> {
  const doc = await kit.briar.store.load(contextId);
  if (!doc) throw contextNotFound(contextId);
  return doc;
}

export function registerContextRoutes<E extends Env>(kit: RouteKit<E>): void {
  const { app, briar, base } = kit;

  app.get(
    `${base}/contexts`,
    kit.handle(async (c) => {
      await kit.authorize(c, "contexts.list", {});
      const query: ContextListQuery = {};
      const limit = c.req.query("limit");
      if (limit !== undefined) {
        if (!/^\d+$/.test(limit) || Number(limit) < 1) throw invalidQuery("limit", limit, "must be a whole number >= 1");
        query.limit = Math.min(Number(limit), MAX_LIMIT);
      }
      const cursor = c.req.query("cursor");
      if (cursor !== undefined && cursor !== "") query.cursor = cursor;
      const search = c.req.query("search");
      if (search !== undefined && search !== "") query.search = search;
      const page = await briar.contexts.list(query);
      return c.json(page.nextCursor === undefined ? { items: page.items } : { items: page.items, nextCursor: page.nextCursor });
    }),
  );

  app.post(
    `${base}/contexts`,
    kit.handle(async (c) => {
      await kit.authorize(c, "contexts.create", {});
      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      const input = parseCreateBody(body);
      const handle = await briar.contexts.create(input);
      c.header("Location", `${base}/contexts/${handle.id}`);
      return c.json(handle.doc, 201);
    }),
  );

  app.get(
    `${base}/contexts/:contextId`,
    kit.handle(async (c) => {
      const contextId = checkPathId("context", "contextId", c.req.param("contextId"));
      const doc = await loadContext(kit, contextId);
      await kit.authorize(c, "contexts.read", { contextId });
      c.header("ETag", `"${doc.revision}"`);
      return c.json(doc);
    }),
  );

  app.delete(
    `${base}/contexts/:contextId`,
    kit.handle(async (c) => {
      const contextId = checkPathId("context", "contextId", c.req.param("contextId"));
      await loadContext(kit, contextId);
      await kit.authorize(c, "contexts.delete", { contextId });
      if (!(await briar.contexts.delete(contextId))) throw contextNotFound(contextId);
      return c.body(null, 204);
    }),
  );

  app.post(
    `${base}/contexts/:contextId/commands`,
    kit.handle(async (c) => {
      const contextId = checkPathId("context", "contextId", c.req.param("contextId"));
      await loadContext(kit, contextId);
      await kit.authorize(c, "contexts.edit", { contextId });
      const request = parseCommandsBody(await readJson(c.req.raw, kit.maxBodyBytes));
      const result = await briar.applyCommands(contextId, request);
      return c.json({ revision: result.revision, changed: result.changed, created: result.created, diagnostics: result.diagnostics });
    }),
  );

  app.get(
    `${base}/contexts/:contextId/diagnostics`,
    kit.handle(async (c: Context<E>) => {
      const contextId = checkPathId("context", "contextId", c.req.param("contextId"));
      await loadContext(kit, contextId);
      await kit.authorize(c, "contexts.read", { contextId });
      return c.json(await briar.diagnostics(contextId));
    }),
  );
}

function parseCreateBody(body: unknown): { name: string; description?: string; id?: string } {
  if (!isObject(body)) throw invalidBody([{ path: "", problem: 'must be a JSON object like { "name": "Marketing" }' }]);
  const problems: { path: string; problem: string }[] = [];
  const { name, description, id } = body;
  if (typeof name !== "string") problems.push({ path: "name", problem: "must be a string" });
  else if (name.trim().length < 1 || name.trim().length > 120) problems.push({ path: "name", problem: "must be 1–120 characters long" });
  if (description !== undefined && typeof description !== "string") problems.push({ path: "description", problem: "must be a string" });
  if (id !== undefined && (typeof id !== "string" || !isValidId("context", id))) {
    problems.push({ path: "id", problem: 'must be a context id like "ctx_marketing" (letters, digits, _ and -)' });
  }
  if (problems.length > 0) throw invalidBody(problems);
  const input: { name: string; description?: string; id?: string } = { name: name as string };
  if (typeof description === "string") input.description = description;
  if (typeof id === "string") input.id = id;
  return input;
}

function parseCommandsBody(body: unknown): { baseRevision: number; commands: Command[] } {
  if (!isObject(body)) throw invalidBody([{ path: "", problem: "must be a JSON object { baseRevision, commands }" }]);
  const problems: { path: string; problem: string }[] = [];
  const { baseRevision, commands } = body;
  if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    problems.push({ path: "baseRevision", problem: "must be a whole number >= 0 (the revision your commands are based on)" });
  }
  if (!Array.isArray(commands)) problems.push({ path: "commands", problem: "must be an array of commands" });
  else if (commands.length === 0) problems.push({ path: "commands", problem: "must contain at least one command" });
  else if (commands.length > MAX_COMMANDS) problems.push({ path: "commands", problem: `must contain at most ${MAX_COMMANDS} commands; split the batch` });
  if (problems.length > 0) throw invalidBody(problems);
  return { baseRevision: baseRevision as number, commands: commands as Command[] };
}
