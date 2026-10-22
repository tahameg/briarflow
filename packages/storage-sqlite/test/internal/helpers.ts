/**
 * Helpers for the internal store tests. The ContextStore conformance checks (storage.md §3)
 * run from `test/conformance.test.ts` via `describeContextStore` in `@briarflow/testing`
 * (REQ-15: the former per-package copy of those checks was removed).
 */
import { createContextDocument, createFlowDocument, isBriarError } from "@briarflow/core";
import type { ContextDocument, FlowDocument } from "@briarflow/core";

export interface DocOptions {
  name?: string;
  description?: string;
  revision?: number;
  updatedAt?: string;
  flows?: { id: string; name: string }[];
}

let counter = 0;

export function makeDoc(id: string, options: DocOptions = {}): ContextDocument {
  const doc = createContextDocument({ id, name: options.name ?? `Context ${id}` });
  const flows: FlowDocument[] = (options.flows ?? []).map((f) =>
    createFlowDocument({ id: f.id, name: f.name, inputNodeId: `n_in${++counter}`, outputNodeId: `n_out${counter}` }),
  );
  const out: ContextDocument = {
    ...doc,
    revision: options.revision ?? 1,
    updatedAt: options.updatedAt ?? "2026-10-21T10:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    flows,
  };
  if (options.description !== undefined) out.description = options.description;
  return out;
}

export async function caught(p: Promise<unknown>): Promise<{ code: string; details: unknown; message: string }> {
  try {
    await p;
  } catch (err) {
    if (isBriarError(err)) return err as { code: string; details: unknown; message: string };
    throw err;
  }
  throw new Error("expected a rejection");
}
