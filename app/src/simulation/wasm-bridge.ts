import type { GraphData, GraphEdge } from "../graph/types";
import type { SimConfig } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var wasmLoadGraph: (graphJSON: string, costParamsJSON: string) => WasmResult;
  // eslint-disable-next-line no-var
  var wasmFindPath: (sourceID: string, targetID: string) => WasmPathResult;
  // eslint-disable-next-line no-var
  var wasmFindPathBlocked: (sourceID: string, targetID: string, blockedJSON: string) => WasmPathResult;
  // eslint-disable-next-line no-var
  var wasmSingleSource: (sourceID: string) => Record<string, number>;
}

type WasmResult = { ok: boolean; error?: string; nodes?: number; edges?: number };
type WasmPathResult = { ok: boolean; error?: string; totalCost?: number; path?: string[] };

let wasmReady = false;
let wasmLoadPromise: Promise<void> | null = null;

// ─── JS Dijkstra fallback ───

type CostParams = {
  xyCostPerM: number;
  zUpCostPerM: number;
  zDownCostPerM: number;
  xyTurnCost: number;
  xyzTurnCost: number;
};

type AdjEntry = { node: string; edge: GraphEdge };

let jsFallbackReady = false;
let jsAdjacency: Map<string, AdjEntry[]> = new Map();
let jsNodeZMap: Map<string, number> = new Map(); // nodeId → z_m
let jsCostParams: CostParams = {
  xyCostPerM: 1,
  zUpCostPerM: 10,
  zDownCostPerM: 2,
  xyTurnCost: 2,
  xyzTurnCost: 3,
};

function jsEdgeCost(edge: GraphEdge, fromId: string, toId: string): number {
  if (edge.axis === "z") {
    const fromZ = jsNodeZMap.get(fromId) ?? 0;
    const toZ = jsNodeZMap.get(toId) ?? 0;
    const costPerM = toZ > fromZ ? jsCostParams.zUpCostPerM : jsCostParams.zDownCostPerM;
    return edge.distance_m * costPerM;
  }
  return edge.distance_m * jsCostParams.xyCostPerM;
}

function jsDijkstra(
  sourceID: string,
  targetID: string,
  blockedSet?: Set<string>,
): { totalCost: number; path: string[] } | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  dist.set(sourceID, 0);

  // Simple priority queue using sorted array (good enough for our graph sizes)
  const queue: { node: string; cost: number }[] = [{ node: sourceID, cost: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    // Find min cost node
    let minIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].cost < queue[minIdx].cost) minIdx = i;
    }
    const { node: u, cost: uCost } = queue[minIdx];
    queue.splice(minIdx, 1);

    if (visited.has(u)) continue;
    visited.add(u);

    if (u === targetID) {
      // Reconstruct path
      const path: string[] = [];
      let cur: string | undefined = targetID;
      while (cur !== undefined) {
        path.unshift(cur);
        cur = prev.get(cur);
      }
      return { totalCost: uCost, path };
    }

    const neighbors = jsAdjacency.get(u);
    if (!neighbors) continue;

    for (const { node: v, edge } of neighbors) {
      if (visited.has(v)) continue;
      if (blockedSet && blockedSet.has(v)) continue;

      const cost = uCost + jsEdgeCost(edge, u, v);
      const prevCost = dist.get(v);
      if (prevCost === undefined || cost < prevCost) {
        dist.set(v, cost);
        prev.set(v, u);
        queue.push({ node: v, cost });
      }
    }
  }

  return null; // no path
}

function jsSingleSourceCosts(sourceID: string): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(sourceID, 0);

  const queue: { node: string; cost: number }[] = [{ node: sourceID, cost: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].cost < queue[minIdx].cost) minIdx = i;
    }
    const { node: u, cost: uCost } = queue[minIdx];
    queue.splice(minIdx, 1);

    if (visited.has(u)) continue;
    visited.add(u);

    const neighbors = jsAdjacency.get(u);
    if (!neighbors) continue;

    for (const { node: v, edge } of neighbors) {
      if (visited.has(v)) continue;
      const cost = uCost + jsEdgeCost(edge, u, v);
      const prevCost = dist.get(v);
      if (prevCost === undefined || cost < prevCost) {
        dist.set(v, cost);
        queue.push({ node: v, cost });
      }
    }
  }

  return dist;
}

function loadGraphIntoJS(data: GraphData, config: SimConfig): void {
  jsAdjacency = new Map();
  jsNodeZMap = new Map();
  jsCostParams = {
    xyCostPerM: 1.0 / config.botSpeedMps,
    zUpCostPerM: 1.0 / config.zUpSpeedMps,
    zDownCostPerM: 1.0 / config.zDownSpeedMps,
    xyTurnCost: config.xyTurnTimeS,
    xyzTurnCost: config.xyzTransitionTimeS,
  };

  for (const node of data.nodes) {
    jsNodeZMap.set(node.id, node.position.z_m);
    if (!jsAdjacency.has(node.id)) {
      jsAdjacency.set(node.id, []);
    }
  }

  for (const edge of data.edges) {
    // Bidirectional
    if (!jsAdjacency.has(edge.a)) jsAdjacency.set(edge.a, []);
    if (!jsAdjacency.has(edge.b)) jsAdjacency.set(edge.b, []);
    jsAdjacency.get(edge.a)!.push({ node: edge.b, edge });
    jsAdjacency.get(edge.b)!.push({ node: edge.a, edge });
  }

  jsFallbackReady = true;
}

// ─── WASM init ───

export async function initWasm(): Promise<void> {
  if (wasmReady) return;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    try {
      const script = document.createElement("script");
      script.src = "/wasm_exec.js";
      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = reject;
        document.head.appendChild(script);
      });

      const go = new (globalThis as any).Go();
      const result = await WebAssembly.instantiateStreaming(
        fetch("/pathfinder.wasm"),
        go.importObject,
      );
      go.run(result.instance);
      wasmReady = true;
    } catch (e) {
      console.warn("WASM pathfinder not available, using JS fallback:", e);
      // JS fallback will be initialized via loadGraphIntoWasm
    }
  })();

  return wasmLoadPromise;
}

export function loadGraphIntoWasm(data: GraphData, config: SimConfig): void {
  // Always load JS fallback
  loadGraphIntoJS(data, config);

  if (!wasmReady) {
    console.warn("WASM not available, using JS Dijkstra fallback");
    return;
  }
  const costParams = JSON.stringify({
    xyCostPerM: 1.0 / config.botSpeedMps,
    zUpCostPerM: 1.0 / config.zUpSpeedMps,
    zDownCostPerM: 1.0 / config.zDownSpeedMps,
    xyTurnCost: config.xyTurnTimeS,
    xyzTurnCost: config.xyzTransitionTimeS,
  });
  const result = globalThis.wasmLoadGraph(JSON.stringify(data), costParams);
  if (!result.ok) {
    throw new Error(`WASM loadGraph failed: ${result.error}`);
  }
}

/**
 * Find path without blocked nodes (for empty bots).
 */
export function findPath(
  sourceID: string,
  targetID: string,
): { totalCost: number; path: string[] } | null {
  if (wasmReady) {
    const result = globalThis.wasmFindPath(sourceID, targetID);
    if (!result.ok) return null;
    return { totalCost: result.totalCost!, path: result.path! };
  }
  if (jsFallbackReady) {
    return jsDijkstra(sourceID, targetID);
  }
  throw new Error("Neither WASM nor JS fallback initialized");
}

/**
 * Find path avoiding blocked nodes (for bots carrying pallets).
 */
export function findPathBlocked(
  sourceID: string,
  targetID: string,
  blockedNodeIds: string[],
): { totalCost: number; path: string[] } | null {
  if (wasmReady) {
    const result = globalThis.wasmFindPathBlocked(
      sourceID,
      targetID,
      JSON.stringify(blockedNodeIds),
    );
    if (!result.ok) return null;
    return { totalCost: result.totalCost!, path: result.path! };
  }
  if (jsFallbackReady) {
    const blockedSet = new Set(blockedNodeIds);
    return jsDijkstra(sourceID, targetID, blockedSet);
  }
  throw new Error("Neither WASM nor JS fallback initialized");
}

export function singleSourceCosts(sourceID: string): Map<string, number> {
  if (wasmReady) {
    const raw = globalThis.wasmSingleSource(sourceID);
    return new Map(Object.entries(raw));
  }
  if (jsFallbackReady) {
    return jsSingleSourceCosts(sourceID);
  }
  throw new Error("Neither WASM nor JS fallback initialized");
}
