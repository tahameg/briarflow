/**
 * Conformance of the facade's in-memory stores (storage.md §3).
 */
import { describeContextStore, describeMediaStore } from "@briarflow/testing";
import { MemoryContextStore, MemoryMediaStore } from "briarflow";

describeContextStore("MemoryContextStore", () => {
  const store = new MemoryContextStore();
  return { store }; // writeRaw is picked up from the store (REQ-17)
});

describeMediaStore("MemoryMediaStore", () => ({ store: new MemoryMediaStore() }));
