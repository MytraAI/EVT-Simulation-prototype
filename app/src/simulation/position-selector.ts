/**
 * Smart position selector for pallet induction.
 *
 * Scoring priorities:
 * 1. Weight-level enforcement: fill ground level first (heaviest capacity),
 *    then level 1, 2, etc. Heavy pallets MUST go low.
 * 2. Velocity-aisle proximity: high velocity SKUs go closest to aisles,
 *    medium further back, low deepest.
 * 3. Blocker minimization: avoid positions that block existing pallets.
 * 4. Radial balance: keep weight balanced left/right, front/back.
 * 5. Level balance: even fill across levels.
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SimState, Velocity } from "./types";

// Per-level max mass: synthetic decay from base (matches RL repo).
// Ground = 4000 lbs (~1814 kg), Level 1 = 3000 lbs (~1360 kg),
// Level 2 = 2000 lbs (~907 kg), Level 3 = 1000 lbs (~454 kg)
// We use lbs internally for the weight limits per the user's spec,
// but since the JSON uses kg we convert: 1 lb = 0.4536 kg
const LEVEL_MAX_LBS = [4000, 3000, 2000, 1000];
const LBS_TO_KG = 0.4536;

export function buildLevelMaxMass(graph: WarehouseGraph): Map<number, number> {
  const levels = new Set<number>();
  for (const node of graph.data.nodes) {
    if (node.kind === "PALLET_POSITION") levels.add(node.level);
  }

  const sorted = Array.from(levels).sort((a, b) => a - b);
  const result = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const maxLbs = i < LEVEL_MAX_LBS.length
      ? LEVEL_MAX_LBS[i]
      : LEVEL_MAX_LBS[LEVEL_MAX_LBS.length - 1];
    result.set(sorted[i], maxLbs * LBS_TO_KG);
  }
  return result;
}

/**
 * Compute how close a position is to an aisle.
 * Uses bot_occupancy_occlusions — positions adjacent to aisle cells are "close".
 * Returns 0 for aisle-adjacent, higher for deeper positions.
 */
function aisleProximity(
  nodeId: string,
  graph: WarehouseGraph,
): number {
  // Check direct adjacency first
  const neighbors = graph.adjacency.get(nodeId) ?? [];
  for (const { node } of neighbors) {
    const n = graph.nodeMap.get(node);
    if (n && n.kind === "AISLE_CELL") return 0; // directly adjacent to aisle
  }

  // Check 2-hop
  for (const { node } of neighbors) {
    const hop2 = graph.adjacency.get(node) ?? [];
    for (const { node: n2 } of hop2) {
      const nn = graph.nodeMap.get(n2);
      if (nn && nn.kind === "AISLE_CELL") return 1;
    }
  }

  return 2; // deep position
}

type PositionScore = {
  nodeId: string;
  score: number;
};

/**
 * Select the best position for inducting a pallet.
 */
export function selectInductionPosition(
  graph: WarehouseGraph,
  state: SimState,
  palletWeightKg: number,
  levelMaxMass: Map<number, number>,
  pendingInductPositions: Set<string>,
  palletVelocity: Velocity = "medium",
): string | null {
  const candidates = graph.data.nodes.filter(
    (n) =>
      n.kind === "PALLET_POSITION" &&
      !state.pallets.has(n.id) &&
      !pendingInductPositions.has(n.id),
  );

  if (candidates.length === 0) return null;

  // Pre-compute current state
  const levelStats = computeLevelStats(graph, state);
  const radialStats = computeRadialStats(graph, state);
  const blockerCounts = computeBlockerExposure(graph, state);

  // Sort levels bottom-up
  const sortedLevels = Array.from(levelStats.keys()).sort((a, b) => a - b);

  const scored: PositionScore[] = [];

  for (const node of candidates) {
    let score = 0;

    const maxMass = levelMaxMass.get(node.level) ?? 1000;

    // --- 1. Weight-level enforcement (0-50 pts) ---
    // Hard constraint: pallet must not exceed level capacity
    if (palletWeightKg > maxMass) {
      score -= 100; // severe penalty, effectively eliminates
    } else {
      // Prefer lower levels for heavier pallets (bottom-up filling)
      // Level index: 0 = ground, 1 = first floor, etc.
      const levelIdx = sortedLevels.indexOf(node.level);
      const levelCount = sortedLevels.length;
      // Heavy pallets get bonus for being on low levels
      const weightRatio = palletWeightKg / maxMass;
      const levelPreference = 1 - (levelIdx / Math.max(1, levelCount - 1));
      // Heavy pallets (high ratio) strongly prefer low levels
      score += levelPreference * weightRatio * 50;
    }

    // --- 2. Bottom-up fill order (0-30 pts) ---
    // Fill lower levels first before moving up
    const levelIdx = sortedLevels.indexOf(node.level);
    const ls = levelStats.get(node.level);
    if (ls) {
      const levelFillRate = ls.occupied / Math.max(1, ls.total);
      // Only allow upper levels when lower levels are substantially filled
      const lowerLevelsFull = sortedLevels
        .slice(0, levelIdx)
        .every((lv) => {
          const lower = levelStats.get(lv);
          return lower ? lower.occupied / Math.max(1, lower.total) > 0.7 : true;
        });

      if (levelIdx === 0) {
        score += 30; // ground level always preferred
      } else if (lowerLevelsFull) {
        score += 30 - levelIdx * 5; // slight penalty per level up
      } else {
        score -= 20; // penalty for going up when lower levels have space
      }
    }

    // --- 3. Velocity-aisle proximity (0-25 pts) ---
    const depth = aisleProximity(node.id, graph);
    const velocityScore = {
      high: depth === 0 ? 25 : depth === 1 ? 10 : 0,    // high vel MUST be near aisle
      medium: depth === 0 ? 15 : depth === 1 ? 20 : 10,  // medium slightly deeper ok
      low: depth === 0 ? 5 : depth === 1 ? 15 : 25,      // low vel goes deep
    };
    score += velocityScore[palletVelocity];

    // --- 4. Blocker minimization (0-20 pts) ---
    const blockersCreated = blockerCounts.get(node.id) ?? 0;
    score += Math.max(0, 20 - blockersCreated * 7);

    // --- 5. Radial balance (0-15 pts) ---
    const cx = radialStats.centerX;
    const cy = radialStats.centerY;
    const isLeft = node.position.x_m < cx;
    const isFront = node.position.y_m < cy;

    const xBalance = isLeft
      ? radialStats.rightWeight - radialStats.leftWeight
      : radialStats.leftWeight - radialStats.rightWeight;
    const yBalance = isFront
      ? radialStats.backWeight - radialStats.frontWeight
      : radialStats.frontWeight - radialStats.backWeight;

    score += Math.min(15, Math.max(0, (xBalance + yBalance) * 0.005));

    scored.push({ nodeId: node.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.nodeId ?? null;
}

// --- Helper functions ---

type LevelStat = { total: number; occupied: number; totalWeightKg: number };

function computeLevelStats(
  graph: WarehouseGraph,
  state: SimState,
): Map<number, LevelStat> {
  const stats = new Map<number, LevelStat>();
  for (const node of graph.data.nodes) {
    if (node.kind !== "PALLET_POSITION") continue;
    if (!stats.has(node.level)) {
      stats.set(node.level, { total: 0, occupied: 0, totalWeightKg: 0 });
    }
    const ls = stats.get(node.level)!;
    ls.total++;
    const pallet = state.pallets.get(node.id);
    if (pallet) {
      ls.occupied++;
      ls.totalWeightKg += pallet.weightKg;
    }
  }
  return stats;
}

type RadialStats = {
  centerX: number;
  centerY: number;
  leftWeight: number;
  rightWeight: number;
  frontWeight: number;
  backWeight: number;
};

function computeRadialStats(
  graph: WarehouseGraph,
  state: SimState,
): RadialStats {
  const b = graph.bounds;
  const centerX = (b.minX + b.maxX) / 2;
  const centerY = (b.minY + b.maxY) / 2;

  let leftWeight = 0,
    rightWeight = 0,
    frontWeight = 0,
    backWeight = 0;

  for (const node of graph.data.nodes) {
    if (node.kind !== "PALLET_POSITION") continue;
    const pallet = state.pallets.get(node.id);
    if (!pallet) continue;

    if (node.position.x_m < centerX) leftWeight += pallet.weightKg;
    else rightWeight += pallet.weightKg;
    if (node.position.y_m < centerY) frontWeight += pallet.weightKg;
    else backWeight += pallet.weightKg;
  }

  return { centerX, centerY, leftWeight, rightWeight, frontWeight, backWeight };
}

function computeBlockerExposure(
  graph: WarehouseGraph,
  state: SimState,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.data.nodes) {
    if (node.kind !== "PALLET_POSITION") continue;
    if (state.pallets.has(node.id)) continue;

    let blockerCount = 0;
    const occlusions = node.computed?.bot_occupancy_occlusions ?? [];
    for (const occludedId of occlusions) {
      if (state.pallets.has(occludedId)) blockerCount++;
    }
    counts.set(node.id, blockerCount);
  }
  return counts;
}

// --- Balance metrics for display ---

export type BalanceMetrics = {
  levelWeights: {
    level: number;
    weightKg: number;
    maxKg: number;
    maxPerPositionKg: number;
    fillPct: number;
    count: number;
  }[];
  radialImbalance: number;
  leftWeight: number;
  rightWeight: number;
  frontWeight: number;
  backWeight: number;
  weightLevelScore: number;
};

export function computeBalanceMetrics(
  graph: WarehouseGraph,
  state: SimState,
  levelMaxMass: Map<number, number>,
): BalanceMetrics {
  const levelStats = computeLevelStats(graph, state);
  const radial = computeRadialStats(graph, state);

  const levelWeights: BalanceMetrics["levelWeights"] = [];
  for (const [level, ls] of levelStats) {
    const maxPerPos = levelMaxMass.get(level) ?? 1000;
    levelWeights.push({
      level,
      weightKg: ls.totalWeightKg,
      maxKg: maxPerPos * ls.total,
      maxPerPositionKg: maxPerPos,
      fillPct: ls.occupied / Math.max(1, ls.total),
      count: ls.occupied,
    });
  }
  levelWeights.sort((a, b) => a.level - b.level);

  const totalWeight =
    radial.leftWeight + radial.rightWeight + radial.frontWeight + radial.backWeight;
  const xImbalance =
    totalWeight > 0
      ? Math.abs(radial.leftWeight - radial.rightWeight) / (totalWeight / 2)
      : 0;
  const yImbalance =
    totalWeight > 0
      ? Math.abs(radial.frontWeight - radial.backWeight) / (totalWeight / 2)
      : 0;
  const radialImbalance = Math.min(1, (xImbalance + yImbalance) / 2);

  // Weight-level score: 1 - (weight/level_max)^2
  let wlSum = 0, wlCount = 0;
  for (const [nodeId, pallet] of state.pallets) {
    const node = graph.nodeMap.get(nodeId);
    if (!node || node.kind !== "PALLET_POSITION") continue;
    const maxMass = levelMaxMass.get(node.level) ?? 1000;
    const ratio = pallet.weightKg / Math.max(maxMass, 1);
    wlSum += Math.max(0, 1 - ratio * ratio);
    wlCount++;
  }
  const weightLevelScore = wlCount > 0 ? wlSum / wlCount : 1;

  return {
    levelWeights,
    radialImbalance,
    leftWeight: radial.leftWeight,
    rightWeight: radial.rightWeight,
    frontWeight: radial.frontWeight,
    backWeight: radial.backWeight,
    weightLevelScore,
  };
}
