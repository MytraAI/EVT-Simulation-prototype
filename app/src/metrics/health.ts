import type { WarehouseGraph } from "../graph/loader";
import type { SimState } from "../simulation/types";

export type HealthMetrics = {
  weightLevelScore: number;
  utilizationBalance: number;
  fillRate: number;
  avgRetrievalCostDistance: number;
  avgRetrievalCostBlockers: number;
};

export function computeHealthMetrics(
  graph: WarehouseGraph,
  state: SimState,
): HealthMetrics {
  const palletNodes = graph.data.nodes.filter(
    (n) => n.kind === "PALLET_POSITION",
  );
  const totalPositions = palletNodes.length;
  const occupiedCount = state.pallets.size;

  const fillRate = totalPositions > 0 ? occupiedCount / totalPositions : 0;

  // Weight-level score using actual pallet weights
  let weightLevelSum = 0;
  let weightLevelCount = 0;
  for (const [nodeId, pallet] of state.pallets) {
    const node = graph.nodeMap.get(nodeId);
    if (node && node.kind === "PALLET_POSITION") {
      const maxForLevel = node.max_pallet_mass_kg;
      if (maxForLevel > 0) {
        const ratio = pallet.weightKg / maxForLevel;
        weightLevelSum += 1 - ratio * ratio;
        weightLevelCount++;
      }
    }
  }
  const weightLevelScore =
    weightLevelCount > 0 ? weightLevelSum / weightLevelCount : 1;

  // Utilization balance across levels
  const levelCounts = new Map<number, { total: number; occupied: number }>();
  for (const node of palletNodes) {
    if (!levelCounts.has(node.level)) {
      levelCounts.set(node.level, { total: 0, occupied: 0 });
    }
    const lc = levelCounts.get(node.level)!;
    lc.total++;
    if (state.pallets.has(node.id)) {
      lc.occupied++;
    }
  }

  let balanceScore = 1;
  if (levelCounts.size > 1) {
    const fills: number[] = [];
    for (const lc of levelCounts.values()) {
      fills.push(lc.total > 0 ? lc.occupied / lc.total : 0);
    }
    const mean = fills.reduce((a, b) => a + b, 0) / fills.length;
    const variance =
      fills.reduce((sum, f) => sum + (f - mean) ** 2, 0) / fills.length;
    balanceScore = Math.max(0, 1 - variance * 4);
  }

  const retrievals = state.completedTasks.filter(
    (t) => t.type === "RETRIEVAL",
  );
  const avgRetrievalCostDistance =
    retrievals.length > 0
      ? retrievals.reduce((sum, t) => sum + t.travelDistanceM, 0) /
        retrievals.length
      : 0;
  const avgRetrievalCostBlockers =
    retrievals.length > 0
      ? retrievals.reduce((sum, t) => sum + t.blockerPenalty, 0) /
        retrievals.length
      : 0;

  return {
    weightLevelScore,
    utilizationBalance: balanceScore,
    fillRate,
    avgRetrievalCostDistance,
    avgRetrievalCostBlockers,
  };
}
