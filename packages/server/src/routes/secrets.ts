/**
 * The vault and settings (docs/specs/secrets.md, settings.md). Secret values go in and never
 * come out: no route returns one.
 */
import { BriarError, isValidSecretName } from "@briarflow/core";
import type { Env } from "hono";
import { isObject, readJson } from "../body.js";
import type { RouteKit } from "../kit.js";

function secretName(raw: string | undefined): string {
  const name = raw ?? "";
  if (!isValidSecretName(name)) {
    throw new BriarError("request.invalid_id", `"${name}" is not a valid secret name in the path.`, { details: { param: "name", value: name } });
  }
  return name;
}

function invalidBody(message: string): BriarError {
  return new BriarError("request.invalid_body", message);
}

export function registerSecretRoutes<E extends Env>(kit: RouteKit<E>): void {
  const { app, briar, base } = kit;

  app.get(
    `${base}/secrets`,
    kit.handle(async (c) => {
      await kit.authorize(c, "secrets.list", {});
      return c.json({ items: await briar.vault.list() });
    }),
  );

  app.post(
    `${base}/secrets`,
    kit.handle(async (c) => {
      await kit.authorize(c, "secrets.write", {});
      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      if (!isObject(body)) throw invalidBody('Send { "name", "kind", "value" }.');
      const info = await briar.vault.create({ name: body["name"] as string, kind: body["kind"] as never, value: body["value"] as string });
      return c.json(info, 201);
    }),
  );

  app.post(
    `${base}/secrets/:name`,
    kit.handle(async (c) => {
      const name = secretName(c.req.param("name"));
      await kit.authorize(c, "secrets.write", {});
      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      if (!isObject(body) || typeof body["value"] !== "string") throw invalidBody('Send { "value" } with the new value.');
      return c.json(await briar.vault.update(name, body["value"]));
    }),
  );

  app.delete(
    `${base}/secrets/:name`,
    kit.handle(async (c) => {
      const name = secretName(c.req.param("name"));
      await kit.authorize(c, "secrets.write", {});
      await briar.vault.delete(name);
      return new Response(null, { status: 204 });
    }),
  );

  app.get(
    `${base}/settings`,
    kit.handle(async (c) => {
      await kit.authorize(c, "settings.read", {});
      return c.json(await briar.settings.info());
    }),
  );

  app.post(
    `${base}/settings`,
    kit.handle(async (c) => {
      await kit.authorize(c, "settings.write", {});
      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      if (!isObject(body) || typeof body["key"] !== "string") throw invalidBody('Send { "key", "value" }; a null value clears the setting.');
      await briar.settings.set(body["key"], body["value"]);
      return c.json(await briar.settings.info());
    }),
  );
}
