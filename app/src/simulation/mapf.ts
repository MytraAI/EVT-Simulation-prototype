/**
 * Cooperative A* (CA*) — Priority-based multi-agent pathfinding.
 *
 * Each bot plans through a space-time graph where states are (nodeId, timestep).
 * Higher-priority bots plan first and reserve (node, tick) pairs.
 * Lower-priority bots plan around those reservations.
 *
 * This is the simplest real MAPF algorithm and works well for small fleets
 * on structured warehouse graphs.
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SimConfig, Bot } from "./types";
import { singleSourceCosts } from "./wasm-bridge";

// A reservation table: maps "nodeId:tick" to the bot ID that reserved it
type ReservationTable = Map<string, number>;

function resKey(nodeId: string, tick: number): string {
  return `${nodeId}:${tick}`;
}

function isReserved(table: ReservationTable, nodeId: string, tick: number, selfBotId: number): boolean {
  const key = resKey(nodeId, tick);
  const owner = table.get(key);
  return owner !== undefined && owner !== selfBotId;
}

// Space-time A* state
type STNode = {
  nodeId: string;
  tick: number;
};

type STEntry = {
  node: STNode;
  g: number;    // cost so far (ticks)
  f: number;    // g + heuristic
  parent: STEntry | null;
};

/**
 * Compute how many ticks an edge takes (same logic as engine.ts).
 */
function edgeTicks(
  fromId: string,
  toId: string,
  prevAxis: string | null,
  graph: WarehouseGraph,
  config: SimConfig,
): number {
  const edge = graph.data.edges.find(
    (e) => (e.a === fromId && e.b === toId) || (e.b === fromId && e.a === toId),
  );
  if (!edge) return 1;

  let travelSeconds: number;
  if (edge.axis === "z") {
    const fromNode = graph.nodeMap.get(fromId);
    const toNode = graph.nodeMap.get(toId);
    if (fromNode && toNode) {
      const goingUp = toNode.position.z_m > fromNode.position.z_m;
      travelSeconds = edge.distance_m / (goingUp ? config.zUpSpeedMps : config.zDownSpeedMps);
    } else {
      travelSeconds = edge.distance_m / config.botSpeedMps;
    }
  } else {
    travelSeconds = edge.distance_m / config.botSpeedMps;
  }

  let turnSeconds = 0;
  if (prevAxis !== null && prevAxis !== edge.axis) {
    const prevXY = prevAxis === "x" || prevAxis === "y";
    const curXY = edge.axis === "x" || edge.axis === "y";
    turnSeconds = (prevXY && curXY) ? config.xyTurnTimeS : config.xyzTransitionTimeS;
  }

  return Math.max(1, Math.ceil(travelSeconds + turnSeconds));
}

/**
 * Get the axis of the edge between two nodes.
 */
function getEdgeAxis(graph: WarehouseGraph, fromId: string, toId: string): string | null {
  const edge = graph.data.edges.find(
    (e) => (e.a === fromId && e.b === toId) || (e.b === fromId && e.a === toId),
  );
  return edge?.axis ?? null;
}

/**
 * Space-Time A* for a single bot, respecting a reservation table.
 *
 * Returns an array of (nodeId, tick) pairs representing the plan,
 * or null if no path found.
 */
function spaceTimeAStar(
  startNodeId: string,
  targetNodeId: string,
  startTick: number,
  botId: number,
  graph: WarehouseGraph,
  config: SimConfig,
  reservations: ReservationTable,
  heuristic: Map<string, number>, // node -> estimated ticks to target
  blockedNodes: Set<string> | null, // pallet occlusion blocks
  maxSearchTicks: number = 200, // how far into the future to search
): { path: string[]; ticks: number } | null {
  const open: STEntry[] = [];
  const closed = new Set<string>();

  const h = (nodeId: string) => heuristic.get(nodeId) ?? 100;

  const startEntry: STEntry = {
    node: { nodeId: startNodeId, tick: startTick },
    g: 0,
    f: h(startNodeId),
    parent: null,
  };
  open.push(startEntry);

  let iterations = 0;
  const maxIter = 10000;

  while (open.length > 0 && iterations < maxIter) {
    iterations++;

    // Find lowest f in open (simple linear scan — fine for small graphs)
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open[bestIdx];
    open.splice(bestIdx, 1);

    const stKey = `${current.node.nodeId}:${current.node.tick}`;
    if (closed.has(stKey)) continue;
    closed.add(stKey);

    // Goal check
    if (current.node.nodeId === targetNodeId) {
      // Reconstruct path
      const path: string[] = [];
      let entry: STEntry | null = current;
      while (entry) {
        path.push(entry.node.nodeId);
        entry = entry.parent;
      }
      path.reverse();
      // Deduplicate consecutive same nodes (waits)
      const dedupedPath: string[] = [];
      for (const nodeId of path) {
        if (dedupedPath.length === 0 || dedupedPath[dedupedPath.length - 1] !== nodeId) {
          dedupedPath.push(nodeId);
        }
      }
      return { path: dedupedPath, ticks: current.node.tick - startTick };
    }

    // Don't search too far into the future
    if (current.node.tick - startTick > maxSearchTicks) continue;

    // Get the axis of how we arrived at current node (for turn detection)
    let prevAxis: string | null = null;
    if (current.parent) {
      prevAxis = getEdgeAxis(graph, current.parent.node.nodeId, current.node.nodeId);
    }

    // Action 1: Wait at current node
    const waitTick = current.node.tick + 1;
    const waitKey = `${current.node.nodeId}:${waitTick}`;
    if (!closed.has(waitKey) && !isReserved(reservations, current.node.nodeId, waitTick, botId)) {
      open.push({
        node: { nodeId: current.node.nodeId, tick: waitTick },
        g: current.g + 1,
        f: current.g + 1 + h(current.node.nodeId),
        parent: current,
      });
    }

    // Action 2: Move to adjacent nodes
    const neighbors = graph.adjacency.get(current.node.nodeId) ?? [];
    for (const { node: neighborId } of neighbors) {
      // Skip blocked nodes (pallet occlusions)
      if (blockedNodes && blockedNodes.has(neighborId) &&
          neighborId !== startNodeId && neighborId !== targetNodeId) {
        continue;
      }

      const travelTicks = edgeTicks(current.node.nodeId, neighborId, prevAxis, graph, config);
      const arrivalTick = current.node.tick + travelTicks;

      // Check if any tick along the way is reserved at the destination
      let reserved = false;
      for (let t = current.node.tick + 1; t <= arrivalTick; t++) {
        if (isReserved(reservations, neighborId, t, botId)) {
          reserved = true;
          break;
        }
      }
      if (reserved) continue;

      const neighborKey = `${neighborId}:${arrivalTick}`;
      if (closed.has(neighborKey)) continue;

      const newG = current.g + travelTicks;
      open.push({
        node: { nodeId: neighborId, tick: arrivalTick },
        g: newG,
        f: newG + h(neighborId),
        parent: current,
      });
    }
  }

  return null; // no path found
}

/**
 * Plan paths for all bots using Cooperative A*.
 *
 * Returns a map of botId -> planned path (node IDs).
 * Bots that have no task or are not traveling get no plan.
 */
export function cooperativePathPlan(
  bots: Bot[],
  graph: WarehouseGraph,
  config: SimConfig,
  currentTick: number,
  palletOcclusions: Set<string> | null,
  getTarget: (bot: Bot) => string | null,
  getIsCarrying: (bot: Bot) => boolean,
): Map<number, string[]> {
  const reservations: ReservationTable = new Map();
  const plans = new Map<number, string[]>();

  // Sort bots by priority: bots with tasks first, then by ID
  const sortedBots = [...bots].sort((a, b) => {
    const aHasTask = a.task ? 0 : 1;
    const bHasTask = b.task ? 0 : 1;
    if (aHasTask !== bHasTask) return aHasTask - bHasTask;
    return a.id - b.id;
  });

  // Pre-compute heuristics for each unique target
  const heuristicCache = new Map<string, Map<string, number>>();

  for (const bot of sortedBots) {
    const target = getTarget(bot);
    if (!target) continue;

    // Get or compute heuristic (reverse Dijkstra from target)
    let heuristic = heuristicCache.get(target);
    if (!heuristic) {
      const costs = singleSourceCosts(target);
      // Convert Dijkstra cost (seconds) to approximate ticks
      heuristic = new Map<string, number>();
      for (const [nodeId, cost] of costs) {
        heuristic.set(nodeId, Math.ceil(cost));
      }
      heuristicCache.set(target, heuristic);
    }

    const blocked = getIsCarrying(bot) ? palletOcclusions : null;

    const result = spaceTimeAStar(
      bot.currentNodeId,
      target,
      currentTick,
      bot.id,
      graph,
      config,
      reservations,
      heuristic,
      blocked,
    );

    if (result) {
      plans.set(bot.id, result.path);

      // Reserve the planned path in the reservation table
      let tick = currentTick;
      for (let i = 0; i < result.path.length; i++) {
        const nodeId = result.path[i];
        if (i > 0) {
          const prevAxis = i > 1 ? getEdgeAxis(graph, result.path[i - 2], result.path[i - 1]) : null;
          const travelTicks = edgeTicks(result.path[i - 1], nodeId, prevAxis, graph, config);
          // Reserve all intermediate ticks
          for (let t = tick + 1; t <= tick + travelTicks; t++) {
            reservations.set(resKey(nodeId, t), bot.id);
          }
          tick += travelTicks;
        }
        reservations.set(resKey(nodeId, tick), bot.id);
      }
    }
  }

  return plans;
}
