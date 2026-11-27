import type { ForeignKeyRef } from "../catalog.js";

export interface ForeignKeyPath {
  tables: string[];
  bridges: string[];
  edges: [string, string][];
}

export function foreignKeyPath(
  endpoints: readonly string[],
  foreignKeys: ReadonlyMap<string, readonly ForeignKeyRef[]>,
  allowedTables: ReadonlySet<string>,
  maxTables = 6,
): ForeignKeyPath | null {
  const allowed = new Map([...allowedTables].map((table) => [table.toLowerCase(), table]));
  const anchors = [...new Set(endpoints.map((name) => allowed.get(name.toLowerCase())).filter((name): name is string => name !== undefined))].sort();
  if (anchors.length < 2 || anchors.length > maxTables) return null;
  const graph = new Map<string, Set<string>>();
  for (const [source, refs] of foreignKeys) {
    const from = allowed.get(source.toLowerCase());
    if (!from) continue;
    for (const ref of refs) {
      const to = allowed.get(ref.referencesTable.toLowerCase());
      if (!to || to === from) continue;
      if (!graph.has(from)) graph.set(from, new Set());
      if (!graph.has(to)) graph.set(to, new Set());
      graph.get(from)?.add(to);
      graph.get(to)?.add(from);
    }
  }
  const selected = new Set<string>([anchors[0] as string]);
  const edges = new Map<string, [string, string]>();
  for (const target of anchors.slice(1)) {
    if (selected.has(target)) continue;
    const queue = [...selected].sort().map((node) => [node]);
    const visited = new Set(selected);
    let path: string[] | undefined;
    while (queue.length > 0) {
      const currentPath = queue.shift() as string[];
      const current = currentPath[currentPath.length - 1] as string;
      if (current === target) {
        path = currentPath;
        break;
      }
      for (const neighbor of [...(graph.get(current) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push([...currentPath, neighbor]);
      }
    }
    if (!path) return null;
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1] as string;
      const b = path[index] as string;
      selected.add(a);
      selected.add(b);
      const sorted = [a, b].sort() as [string, string];
      edges.set(sorted.join("\u0000"), sorted);
    }
    if (selected.size > maxTables) return null;
  }
  const tables = [...selected].sort();
  const anchorSet = new Set(anchors);
  return {
    tables,
    bridges: tables.filter((table) => !anchorSet.has(table)),
    edges: [...edges.values()].sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000"))),
  };
}
