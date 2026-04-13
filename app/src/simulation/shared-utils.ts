/**
 * Shared utilities used by both the time-stepped engine and the DES engine.
 * Extracted from engine.ts to avoid duplication.
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SkuInfo, Velocity } from "./types";
import type { HeightClass } from "./types";

const SKU_PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9A6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#a9a9a9",
  "#e6beff", "#1ce6ff", "#ff34ff", "#ff4a46", "#008941",
  "#006fa6", "#a30059", "#ffdbe5", "#7a4900", "#0000a6",
];

type HeightClassDef = {
  heightClass: HeightClass;
  heightRange: [number, number];
  weightRange: [number, number];
};

const HEIGHT_CLASSES: HeightClassDef[] = [
  { heightClass: "tall",   heightRange: [1.2, 1.8],  weightRange: [700, 1200] },
  { heightClass: "medium", heightRange: [0.6, 1.2],  weightRange: [350, 700] },
  { heightClass: "short",  heightRange: [0.2, 0.45], weightRange: [100, 350] },
];

/**
 * Compute nodes that are blocked for pallet-carrying bots.
 * When a pallet occupies a position, its bot_occupancy_occlusions
 * list nodes that a carrying bot cannot traverse.
 */
export function computeBlockedNodesForCarrying(
  graph: WarehouseGraph,
  pallets: Map<string, unknown>,
): string[] {
  const blocked = new Set<string>();
  for (const [posId] of pallets) {
    const node = graph.nodeMap.get(posId);
    if (!node) continue;
    const occlusions = node.computed?.bot_occupancy_occlusions ?? [];
    for (const occId of occlusions) {
      blocked.add(occId);
    }
  }
  return Array.from(blocked);
}

/**
 * Compute actual distance in meters for a path (sum of edge distance_m).
 */
export function computePathDistanceM(path: string[], graph: WarehouseGraph): number {
  let dist = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = graph.data.edges.find(
      (e) =>
        (e.a === path[i] && e.b === path[i + 1]) ||
        (e.b === path[i] && e.a === path[i + 1]),
    );
    if (edge) dist += edge.distance_m;
  }
  return dist;
}

/**
 * Generate a catalog of SKUs with velocity and height class assignments.
 */
export function generateSkuCatalog(count: number): SkuInfo[] {
  const skus: SkuInfo[] = [];
  const third = Math.max(1, Math.floor(count / 3));

  for (let i = 0; i < count; i++) {
    let velocity: Velocity;
    if (i < third) velocity = "high";
    else if (i < third * 2) velocity = "medium";
    else velocity = "low";

    let hcDef: HeightClassDef;
    if (velocity === "high") {
      hcDef = Math.random() < 0.6 ? HEIGHT_CLASSES[0] : HEIGHT_CLASSES[1];
    } else if (velocity === "medium") {
      const r = Math.random();
      hcDef = r < 0.33 ? HEIGHT_CLASSES[0] : r < 0.66 ? HEIGHT_CLASSES[1] : HEIGHT_CLASSES[2];
    } else {
      hcDef = Math.random() < 0.5 ? HEIGHT_CLASSES[0] : HEIGHT_CLASSES[2];
    }

    const [minH, maxH] = hcDef.heightRange;
    const [minW, maxW] = hcDef.weightRange;

    skus.push({
      sku: `SKU-${String(i + 1).padStart(3, "0")}`,
      color: SKU_PALETTE[i % SKU_PALETTE.length],
      weightKg: minW + Math.random() * (maxW - minW),
      heightM: minH + Math.random() * (maxH - minH),
      velocity,
      heightClass: hcDef.heightClass,
    });
  }
  return skus;
}

/**
 * Pick a SKU for a new order.
 * Priority by velocity class: 5:3:1 ratio (high:medium:low).
 */
export function pickSkuForOrder(catalog: SkuInfo[]): SkuInfo {
  const high = catalog.filter((s) => s.velocity === "high");
  const medium = catalog.filter((s) => s.velocity === "medium");
  const low = catalog.filter((s) => s.velocity === "low");

  const r = Math.random() * 9;
  let pool: SkuInfo[];
  if (r < 5 && high.length > 0) pool = high;
  else if (r < 8 && medium.length > 0) pool = medium;
  else if (low.length > 0) pool = low;
  else pool = catalog;

  return pool[Math.floor(Math.random() * pool.length)];
}
