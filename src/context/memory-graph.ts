import type { CompactionArchive } from "../session.ts";

export type MemoryNodeKind = "archive" | "summary" | "patch" | "file" | "command" | "topic" | "fact";
export type MemoryEdgeKind = "summarizes" | "derivedFrom" | "mentionsFile" | "ranCommand" | "hasTopic" | "statesFact" | "patched";

export interface MemoryNode {
  id: string;
  kind: MemoryNodeKind;
  text: string;
  valid: boolean;
  at: number;
  meta?: Record<string, string>;
}

export interface MemoryEdge {
  from: string;
  to: string;
  kind: MemoryEdgeKind;
}

export interface MemoryGraph {
  nodes: Map<string, MemoryNode>;
  edges: MemoryEdge[];
}

const STOP = new Set("the a an to is it of and or in on for with that this when should into from via was were are been compacted earlier turns".split(" "));

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function terms(s: string): string[] {
  const out = new Set<string>();
  for (const part of s.split(/[^A-Za-z0-9_/.-]+/)) {
    for (const w of part.match(/[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) ?? []) {
      const lw = w.toLowerCase();
      if (lw.length >= 3 && !STOP.has(lw)) out.add(lw);
    }
  }
  return [...out];
}

function nodeId(kind: MemoryNodeKind, archiveId: string, text: string): string {
  return `${kind}:${archiveId}:${norm(text).replace(/[^a-z0-9_.\/-]+/g, "-").slice(0, 120)}`;
}

function addNode(graph: MemoryGraph, node: MemoryNode): string {
  const existing = graph.nodes.get(node.id);
  if (!existing) graph.nodes.set(node.id, node);
  return node.id;
}

function addEdge(graph: MemoryGraph, from: string, to: string, kind: MemoryEdgeKind): void {
  if (!from || !to || from === to) return;
  if (!graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) graph.edges.push({ from, to, kind });
}

function addTextNode(
  graph: MemoryGraph,
  archive: CompactionArchive,
  kind: Exclude<MemoryNodeKind, "archive" | "summary" | "patch">,
  text: string,
  edge: MemoryEdgeKind,
  from: string,
  meta?: Record<string, string>,
): void {
  const clean = text.trim();
  if (!clean) return;
  const id = addNode(graph, { id: nodeId(kind, archive.id, clean), kind, text: clean, valid: true, at: archive.at, meta });
  addEdge(graph, from, id, edge);
}

export function buildMemoryGraph(archives: CompactionArchive[] = []): MemoryGraph {
  const graph: MemoryGraph = { nodes: new Map(), edges: [] };
  for (const archive of archives) {
    const archiveId = addNode(graph, {
      id: `archive:${archive.id}`,
      kind: "archive",
      text: `Archive ${archive.id}: turns ${archive.turns.start}-${archive.turns.end}`,
      valid: true,
      at: archive.at,
      meta: { start: String(archive.turns.start), end: String(archive.turns.end) },
    });

    const source = archive.summary?.trim()
      ? addNode(graph, {
          id: `summary:${archive.id}`,
          kind: "summary",
          text: archive.summary.trim(),
          valid: archive.verification?.ok ?? true,
          at: archive.at,
        })
      : archiveId;
    if (source !== archiveId) addEdge(graph, source, archiveId, "summarizes");

    const structured = archive.structured;
    for (const f of structured?.files ?? []) {
      addTextNode(graph, archive, "file", f.path, "mentionsFile", source, f.change ? { change: f.change } : undefined);
    }
    for (const c of structured?.commands ?? []) {
      addTextNode(graph, archive, "command", c.command, "ranCommand", source, c.outcome ? { outcome: c.outcome } : undefined);
    }
    for (const fact of structured?.facts ?? []) addTextNode(graph, archive, "fact", fact, "statesFact", source);
    for (const topic of structured?.topics ?? []) {
      const title = topic.title || topic.notes.join(" ");
      addTextNode(graph, archive, "topic", title, "hasTopic", source);
      for (const file of topic.files ?? []) addTextNode(graph, archive, "file", file, "mentionsFile", source, { topic: title });
      for (const note of topic.notes ?? []) addTextNode(graph, archive, "fact", note, "statesFact", source, { topic: title });
    }

    const patch = archive.verification?.patch ?? [];
    if (patch.length) {
      const patchId = addNode(graph, {
        id: `patch:${archive.id}`,
        kind: "patch",
        text: patch.join("\n"),
        valid: true,
        at: archive.at,
      });
      addEdge(graph, patchId, source, "patched");
    }
    for (const file of archive.verification?.missingFiles ?? []) addTextNode(graph, archive, "file", file, "mentionsFile", source, { source: "verification" });
    for (const command of archive.verification?.missingCommands ?? []) addTextNode(graph, archive, "command", command, "ranCommand", source, { source: "verification" });
    for (const failure of archive.verification?.missingFailures ?? []) addTextNode(graph, archive, "fact", failure, "statesFact", source, { source: "verification" });
    for (const constraint of archive.verification?.missingConstraints ?? []) addTextNode(graph, archive, "fact", constraint, "statesFact", source, { source: "verification" });
  }
  return graph;
}

export function memoryGraphArchiveBoost(queryTerms: string[], archive: CompactionArchive): number {
  return Math.min(8, memoryGraphArchiveEvidence(queryTerms, archive).reduce((s, e) => s + e.weight, 0));
}

export interface MemoryGraphEvidence {
  label: string;
  weight: number;
}

export function memoryGraphArchiveEvidence(queryTerms: string[], archive: CompactionArchive): MemoryGraphEvidence[] {
  if (!queryTerms.length) return [];
  const graph = buildMemoryGraph([archive]);
  const q = new Set(queryTerms.flatMap((t) => [norm(t), ...terms(t)]));
  const sourceIds = new Set([`archive:${archive.id}`, `summary:${archive.id}`, `patch:${archive.id}`]);
  const evidence = new Map<string, MemoryGraphEvidence>();
  for (const edge of graph.edges) {
    if (!sourceIds.has(edge.from) && !sourceIds.has(edge.to)) continue;
    const candidate = sourceIds.has(edge.to) ? edge.from : edge.to;
    const node = graph.nodes.get(candidate);
    if (!node || sourceIds.has(node.id)) continue;
    const nt = terms([node.text, ...Object.values(node.meta ?? {})].join(" "));
    const hits = nt.filter((t) => q.has(t)).length;
    if (!hits) continue;
    const weight =
      node.kind === "file" ? 2.5 :
      node.kind === "command" ? 2 :
      node.kind === "topic" ? 1.8 :
      node.kind === "fact" ? 1.2 :
      0.8;
    const score = Math.min(3, hits) * weight;
    const label = `${node.kind}: ${node.text}`;
    const prev = evidence.get(label);
    evidence.set(label, { label, weight: Math.min(8, (prev?.weight ?? 0) + score) });
  }
  return [...evidence.values()].sort((a, b) => b.weight - a.weight).slice(0, 5);
}
