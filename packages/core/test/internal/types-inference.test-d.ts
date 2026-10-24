/**
 * Compile-time checks for `t`, `cfg`, `defineStruct`/`defineEnum` and `defineNode` inference
 * (docs/specs/node-api.md §3). Checked by `npm run typecheck` (tsconfig.json includes
 * packages/*\/test/**); not executed by Vitest (`*.test-d.ts` is outside the test glob), so the
 * stubbed functions are never called.
 */
import { expectTypeOf } from "vitest";
import {
  cfg,
  defineEnum,
  defineNode,
  defineStruct,
  t,
  variant,
  type AnyNodeDefinition,
  type ConfigOf,
  type InputsOf,
  type MediaRef,
  type NodeDefinition,
  type OutputsOf,
  type TypeRef,
  type TypeSpec,
  type UnknownValue,
  type ValueOf,
} from "@briarflow/core";

export function typeInferenceChecks(): void {
  // --- t builder -------------------------------------------------------------------------
  expectTypeOf(t.text()).toEqualTypeOf<TypeSpec<string>>();
  expectTypeOf(t.int({ min: 0 })).toEqualTypeOf<TypeSpec<number>>();
  expectTypeOf(t.boolean()).toEqualTypeOf<TypeSpec<boolean>>();
  expectTypeOf(t.image({ formats: ["png"] })).toEqualTypeOf<TypeSpec<MediaRef>>();
  expectTypeOf(t.list(t.image())).toEqualTypeOf<TypeSpec<readonly MediaRef[]>>();
  expectTypeOf(t.optional(t.int())).toEqualTypeOf<TypeSpec<number | null>>();
  expectTypeOf(t.list(t.optional(t.text()))).toEqualTypeOf<TypeSpec<readonly (string | null)[]>>();
  expectTypeOf(t.ref("openai.ChatMessage")).toEqualTypeOf<TypeSpec<UnknownValue>>();
  expectTypeOf(t.var("T")).toEqualTypeOf<TypeSpec<UnknownValue>>();
  expectTypeOf<ValueOf<TypeSpec<string>>>().toEqualTypeOf<string>();
  // A spec is not assignable to a spec of another value type.
  expectTypeOf<TypeSpec<string>>().not.toMatchTypeOf<TypeSpec<number>>();
  expectTypeOf<TypeSpec<string>>().toMatchTypeOf<TypeSpec<unknown>>();

  // --- pack types --------------------------------------------------------------------------
  const Role = defineEnum("Role", ["system", "user", { value: "assistant", label: "AI" }]);
  expectTypeOf<ValueOf<typeof Role>>().toEqualTypeOf<"system" | "user" | "assistant">();

  const ChatMessage = defineStruct("ChatMessage", {
    role: t.ref(Role),
    content: t.text(),
    name: { type: t.optional(t.text()), description: "Optional speaker name" },
  });
  expectTypeOf<ValueOf<typeof ChatMessage>>().toEqualTypeOf<{
    role: "system" | "user" | "assistant";
    content: string;
    name: string | null;
  }>();
  expectTypeOf(t.ref(ChatMessage)).toEqualTypeOf<TypeSpec<{ role: "system" | "user" | "assistant"; content: string; name: string | null }>>();

  // --- defineNode: inputs, outputs, return checks (node-api.md §3) -------------------------
  const def = defineNode({
    type: "demo.x",
    inputs: { a: t.text(), b: { type: t.optional(t.int()), default: null }, c: t.list(t.image()) },
    outputs: { out: t.text() },
    run({ inputs, ctx }) {
      expectTypeOf(inputs.a).toEqualTypeOf<string>();
      expectTypeOf(inputs.b).toEqualTypeOf<number | null>();
      expectTypeOf(inputs.c).toEqualTypeOf<readonly MediaRef[]>();
      expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
      return { out: "ok" };
    },
  });
  expectTypeOf<InputsOf<typeof def>>().toEqualTypeOf<{ readonly a: string; readonly b: number | null; readonly c: readonly MediaRef[] }>();
  expectTypeOf<OutputsOf<typeof def>>().toEqualTypeOf<{ readonly out: string }>();
  expectTypeOf(def).toMatchTypeOf<AnyNodeDefinition>();

  // Async run and typed pack-struct outputs.
  const chat = defineNode({
    type: "demo.chat",
    inputs: { messages: t.list(t.ref(ChatMessage)) },
    outputs: { reply: t.ref(ChatMessage), usage: t.optional(t.int()) },
    async run({ inputs }) {
      const last = inputs.messages[inputs.messages.length - 1];
      expectTypeOf(last).toEqualTypeOf<{ role: "system" | "user" | "assistant"; content: string; name: string | null } | undefined>();
      // `usage` is nullable, so it may be omitted.
      return { reply: { role: "assistant", content: last?.content ?? "", name: null } };
    },
  });
  expectTypeOf(chat).toMatchTypeOf<AnyNodeDefinition>();

  defineNode({
    type: "demo.missing",
    outputs: { out: t.text() },
    // @ts-expect-error a required output is missing
    run: () => ({}),
  });

  defineNode({
    type: "demo.wrong",
    outputs: { out: t.text() },
    // @ts-expect-error wrong output type
    run: () => ({ out: 42 }),
  });

  // @ts-expect-error undeclared output port
  defineNode({
    type: "demo.extra",
    outputs: { out: t.text() },
    run: () => ({ out: "ok", extra: 1 }),
  });

  // Enum literals inside nested struct/list outputs keep their literal types.
  defineNode({
    type: "demo.nested",
    outputs: { msg: t.ref(ChatMessage), roles: t.list(t.ref(Role)) },
    run: () => ({ msg: { role: "user", content: "hi", name: null }, roles: ["system", "user"] }),
  });

  defineNode({
    type: "demo.input_typo",
    inputs: { text: t.text() },
    outputs: { out: t.text() },
    run({ inputs }) {
      // @ts-expect-error unknown input
      void inputs.txt;
      return { out: inputs.text };
    },
  });

  // --- config --------------------------------------------------------------------------------
  const rounding = defineNode({
    type: "demo.round",
    config: {
      mode: cfg.choice(["round", "floor", "ceil"], { default: "round" }),
      label: cfg.text({ optional: true }),
      typeId: cfg.typeId({ kind: "struct" }),
      shape: cfg.type(),
    },
    inputs: { value: t.float() },
    outputs: { value: t.int() },
    run({ inputs, config }) {
      expectTypeOf(config.mode).toEqualTypeOf<"round" | "floor" | "ceil">();
      expectTypeOf(config.label).toEqualTypeOf<string | undefined>();
      expectTypeOf(config.typeId).toEqualTypeOf<string>();
      expectTypeOf(config.shape).toEqualTypeOf<TypeRef>();
      return { value: Math.round(inputs.value) };
    },
  });
  expectTypeOf<ConfigOf<typeof rounding>["mode"]>().toEqualTypeOf<"round" | "floor" | "ceil">();

  // --- dynamic ports: no static inputs → Record<string, unknown> ------------------------------
  const structMake = defineNode({
    type: "demo.struct.make",
    config: { typeId: cfg.typeId({ kind: "struct" }) },
    outputs: { value: t.var("S") },
    resolvePorts({ config, scope }) {
      expectTypeOf(config.typeId).toEqualTypeOf<string>();
      const decl = scope.resolveType(config.typeId);
      if (!decl || decl.kind !== "struct") {
        return { error: { code: "config.unknown_ref", message: "Pick a struct type for this node." } };
      }
      const inputs = Object.fromEntries(decl.fields.map((f) => [f.name, { type: t.fromRef(f.type) }]));
      return { inputs, outputs: { value: t.fromRef({ kind: "named", id: decl.id }) } };
    },
    run({ inputs }) {
      expectTypeOf(inputs).toEqualTypeOf<Readonly<Record<string, UnknownValue>>>();
      return { value: { ...inputs } };
    },
  });
  expectTypeOf(structMake).toMatchTypeOf<NodeDefinition>();

  // Variants: each one types its own run.
  const shared = { prompt: t.text() };
  const image = defineNode({
    type: "demo.image",
    variants: {
      title: "Model",
      options: {
        fast: variant({
          inputs: shared,
          outputs: { image: t.image() },
          run({ inputs }) {
            expectTypeOf(inputs.prompt).toEqualTypeOf<string>();
            return { image: { uri: "x", mime: "image/png" } };
          },
        }),
        best: variant({
          config: { steps: cfg.int({ default: 20 }) },
          inputs: { ...shared, negative: t.optional(t.text()) },
          outputs: { image: t.image(), seed: t.int() },
          run({ inputs, config }) {
            expectTypeOf(inputs.negative).toEqualTypeOf<string | null>();
            expectTypeOf(config.steps).toEqualTypeOf<number>();
            return { image: { uri: "x", mime: "image/png" }, seed: 1 };
          },
        }),
        wrong: variant({
          outputs: { out: t.text() },
          // @ts-expect-error wrong output type in a variant
          run: () => ({ out: 42 }),
        }),
      },
    },
  });
  expectTypeOf(image).toMatchTypeOf<AnyNodeDefinition>();

  // A node with variants declares no shape of its own.
  // @ts-expect-error inputs belong on the variants
  defineNode({
    type: "demo.mixed",
    inputs: { a: t.text() },
    variants: { options: {} },
  });

  // Packs accept heterogeneous definitions.
  const nodes: AnyNodeDefinition[] = [def, chat, rounding, structMake, image];
  void nodes;
}
