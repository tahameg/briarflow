/**
 * Internal graph helpers: reachability and cycles (deterministic, node order = input order).
 */

/** Adjacency list: node id → successor ids (in edge order, unique). */
export type Adjacency = Map<string, string[]>;

export function buildAdjacency(nodeIds: readonly string[], edges: readonly { from: string; to: string }[]): Adjacency {
  const adj: Adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    const list = adj.get(e.from);
    if (!list || !adj.has(e.to)) continue;
    if (!list.includes(e.to)) list.push(e.to);
  }
  return adj;
}

/** For every node, the set of nodes reachable by a path of length ≥ 1. */
export function reachability(adj: Adjacency): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const start of adj.keys()) {
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of adj.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    out.set(start, seen);
  }
  return out;
}

/**
 * One cycle per strongly connected component that contains a cycle, as a node path
 * `[a, b, …, a]` starting at the component's first node in input order.
 */
export function findCycles(adj: Adjacency): string[][] {
  const order = [...adj.keys()];
  const reach = reachability(adj);
  const done = new Set<string>();
  const cycles: string[][] = [];
  for (const start of order) {
    if (done.has(start) || !reach.get(start)?.has(start)) continue;
    const component = order.filter((id) => id === start || (reach.get(start)?.has(id) && reach.get(id)?.has(start)));
    component.forEach((id) => done.add(id));
    const inComponent = new Set(component);
    // BFS for the shortest path start → … → start inside the component.
    const prev = new Map<string, string>();
    const queue = [start];
    const visited = new Set<string>();
    let found = false;
    while (queue.length > 0 && !found) {
      const id = queue.shift() as string;
      for (const next of adj.get(id) ?? []) {
        if (!inComponent.has(next)) continue;
        if (next === start) {
          prev.set("\u0000end", id);
          found = true;
          break;
        }
        if (visited.has(next)) continue;
        visited.add(next);
        prev.set(next, id);
        queue.push(next);
      }
    }
    const path = [start];
    let cur = prev.get("\u0000end");
    while (cur !== undefined && cur !== start) {
      path.unshift(cur);
      cur = prev.get(cur);
    }
    path.unshift(start);
    cycles.push(path);
  }
  return cycles;
}
