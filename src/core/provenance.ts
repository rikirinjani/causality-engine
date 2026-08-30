import type { DomainId, RegionId, WorldState } from "./types.js";

/**
 * Structured causal provenance — a multi-parent DAG, not log strings.
 *
 * Every causally interesting change records a node whose parents are the nodes that
 * explain its inputs. Multiple contributing causes are preserved as multiple parents and
 * never collapsed into one opaque explanation.
 *
 * `provenanceRefs` maps a tracked quantity (e.g. `RF:stock:grain`) to the node id that
 * currently explains it, so the next derivation can cite its real inputs. That keeps the
 * graph bounded (one ref per quantity) while still producing full chains on query.
 *
 * Determinism: ids come from a counter in WorldState and every producer iterates in
 * sorted order, so the graph is byte-identical across replays.
 */

export type ProvenanceKind =
  | "intervention" // a submitted player/world action (a root cause)
  | "pressure" // causal pressure entering a region ledger
  | "resolution" // a quota resolution pass firing
  | "effect" // a direct state change (immediate effect or resolution output)
  | "derived"; // a recomputed quantity (price, patrol demand, income...)
export interface ProvenanceNode {
  id: string;
  tick: number;
  kind: ProvenanceKind;
  /** Stable machine-readable label, e.g. "grain_price", "faction_hostility". */
  label: string;
  regionId?: RegionId;
  domain?: DomainId;
  value?: number;
  /** Extra structured detail (action, targetId, pressure...). Never prose. */
  detail?: Record<string, string | number | boolean>;
  /** Multi-parent: all contributing causes are preserved. */
  parents: string[];
}

/** One quota threshold check — the record of a resolution decision. */
export interface ResolutionDecision {
  tick: number;
  regionId: RegionId;
  domain: DomainId;
  pressure: number;
  threshold: number;
  fired: boolean;
  origin: "primary" | "boundary" | "generated";
  /** Causal generation of the pressure that was checked (0 = player action). */
  generation: number;
  /** Net signed direction of the accumulated pressure. */
  netValence: number;
  /** True when opposing causes of comparable weight were present. */
  contested: boolean;
}

export const PROVENANCE_LIMIT = 4000;
export const RESOLUTION_LOG_LIMIT = 4000;

/** Append a node and return its id. */
export function record(state: WorldState, node: Omit<ProvenanceNode, "id">): string {
  const id = `p${++state.provenanceSeq}`;
  state.provenance.push({ id, ...node });
  if (state.provenance.length > PROVENANCE_LIMIT) {
    state.provenance.splice(0, state.provenance.length - PROVENANCE_LIMIT);
    // Truncation is recorded so an explanation drawn from a partial graph cannot claim
    // completeness (§17.7). Never silently forget that we forgot.
    state.historyTruncated = true;
  }
  return id;
}

/** Point a tracked quantity at the node that now explains it. */
export function setRef(state: WorldState, key: string, nodeId: string): void {
  state.provenanceRefs[key] = nodeId;
}

export function getRef(state: WorldState, key: string): string | undefined {
  return state.provenanceRefs[key];
}

export function clearRef(state: WorldState, key: string): void {
  delete state.provenanceRefs[key];
}

/** Resolve several quantity keys to node ids, dropping unexplained ones. Order preserved. */
export function refsOf(state: WorldState, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const id = state.provenanceRefs[k];
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

export function logDecision(state: WorldState, decision: ResolutionDecision): void {
  state.resolutionLog.push(decision);
  if (state.resolutionLog.length > RESOLUTION_LOG_LIMIT) {
    state.resolutionLog.splice(0, state.resolutionLog.length - RESOLUTION_LOG_LIMIT);
    state.historyTruncated = true;
  }
}

export interface RootCause {
  interventionId: string;
  action: string;
  targetId: string;
  location: RegionId;
  tick: number;
  nodeId: string;
}

export interface Explanation {
  /** The quantity asked about. */
  target: string;
  /** Whether any cause was found at all. */
  explained: boolean;
  /** Distinct originating interventions, sorted for stable output. */
  roots: RootCause[];
  /** Every node in the ancestor subgraph, nearest-first. */
  nodes: ProvenanceNode[];
  /** Ancestor paths from the queried node to each root (labels only). */
  paths: string[][];
  /**
   * True when the explanation may be missing ancestors because the provenance ring buffer
   * discarded them, or because a cited parent id is no longer present. An incomplete trace
   * must announce itself rather than look like a complete one (§17.7).
   */
  incomplete: boolean;
  /** Parent ids referenced by retained nodes but no longer in the graph. */
  danglingParents: string[];
}

/**
 * Walk a quantity's ancestry to its originating interventions.
 * Answers "why did X change?" with structure, not prose.
 */
export function explain(state: WorldState, quantityKey: string, maxNodes = 500): Explanation {
  const startId = state.provenanceRefs[quantityKey];
  const byId = new Map(state.provenance.map((n) => [n.id, n]));

  if (startId === undefined || !byId.has(startId)) {
    return {
      target: quantityKey,
      explained: false,
      roots: [],
      nodes: [],
      paths: [],
      // A ref pointing at an evicted node is a TRUNCATED explanation, not an unexplained
      // quantity. Reporting those identically would hide history loss.
      incomplete: startId !== undefined || state.historyTruncated,
      danglingParents: startId !== undefined && !byId.has(startId) ? [startId] : [],
    };
  }

  // breadth-first over parents; a node may be reached by several paths (multi-parent)
  const nodes: ProvenanceNode[] = [];
  const seen = new Set<string>();
  const dangling: string[] = [];
  const queue: string[] = [startId];
  while (queue.length > 0 && nodes.length < maxNodes) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) {
      if (!dangling.includes(id)) dangling.push(id);
      continue;
    }
    nodes.push(node);
    for (const p of node.parents) if (!seen.has(p)) queue.push(p);
  }

  const roots: RootCause[] = [];
  for (const n of nodes) {
    if (n.kind !== "intervention") continue;
    roots.push({
      interventionId: String(n.detail?.interventionId ?? n.id),
      action: String(n.detail?.action ?? n.label),
      targetId: String(n.detail?.targetId ?? ""),
      location: String(n.detail?.location ?? n.regionId ?? ""),
      tick: n.tick,
      nodeId: n.id,
    });
  }
  roots.sort((a, b) =>
    a.tick - b.tick ||
    (a.action < b.action ? -1 : a.action > b.action ? 1 : 0) ||
    (a.interventionId < b.interventionId ? -1 : a.interventionId > b.interventionId ? 1 : 0),
  );

  // enumerate label paths to roots (bounded; the DAG is shallow by construction)
  const paths: string[][] = [];
  const walk = (id: string, trail: string[], depth: number): void => {
    if (depth > 24 || paths.length > 64) return;
    const node = byId.get(id);
    if (!node) return;
    const next = [...trail, node.label];
    if (node.kind === "intervention" || node.parents.length === 0) {
      paths.push(next);
      return;
    }
    for (const p of node.parents) walk(p, next, depth + 1);
  };
  walk(startId, [], 0);

  return {
    target: quantityKey,
    explained: true,
    roots,
    nodes,
    paths,
    incomplete: dangling.length > 0 || nodes.length >= maxNodes,
    danglingParents: dangling,
  };
}

/** Quantity key helpers — one place, so producers and queries cannot drift. */
export const key = {
  stock: (regionId: RegionId, resource: string) => `${regionId}:stock:${resource}`,
  price: (regionId: RegionId, resource: string) => `${regionId}:price:${resource}`,
  priceShock: (regionId: RegionId, resource: string) => `${regionId}:priceShock:${resource}`,
  prodMod: (regionId: RegionId) => `${regionId}:grainProdMod`,
  infra: (regionId: RegionId, infraId: string) => `${regionId}:infra:${infraId}`,
  tradeBlocked: (regionId: RegionId) => `${regionId}:tradeBlocked`,
  hostility: (factionId: string) => `${factionId}:hostility`,
  income: (factionId: string) => `${factionId}:income`,
  patrolDemand: (regionId: RegionId) => `${regionId}:patrolDemand`,
  patrolling: (entityId: string) => `${entityId}:patrolling`,
  unrest: (regionId: RegionId) => `${regionId}:unrest`,
  population: (regionId: RegionId) => `${regionId}:population`,
  ledger: (regionId: RegionId, domain: DomainId) => `${regionId}:ledger:${domain}`,
  investment: (regionId: RegionId) => `${regionId}:tradeInvestment`,
  profitability: (regionId: RegionId) => `${regionId}:merchantProfitability`,
};
