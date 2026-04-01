import type { GraphData, GraphNode, GraphEdge } from "./types";

export type WarehouseGraph = {
  data: GraphData;
  nodeMap: Map<string, GraphNode>;
  adjacency: Map<string, { node: string; edge: GraphEdge }[]>;
  levels: number[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
};

export function loadGraph(data: GraphData): WarehouseGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const node of data.nodes) {
    nodeMap.set(node.id, node);
  }

  // Build adjacency list (undirected)
  const adjacency = new Map<string, { node: string; edge: GraphEdge }[]>();
  for (const node of data.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of data.edges) {
    adjacency.get(edge.a)?.push({ node: edge.b, edge });
    adjacency.get(edge.b)?.push({ node: edge.a, edge });
  }

  // Compute levels and bounds
  const levelSet = new Set<number>();
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;

  for (const node of data.nodes) {
    levelSet.add(node.level);
    const { x_m, y_m, z_m } = node.position;
    if (x_m < minX) minX = x_m;
    if (x_m > maxX) maxX = x_m;
    if (y_m < minY) minY = y_m;
    if (y_m > maxY) maxY = y_m;
    if (z_m < minZ) minZ = z_m;
    if (z_m > maxZ) maxZ = z_m;
  }

  const levels = Array.from(levelSet).sort((a, b) => a - b);

  return {
    data,
    nodeMap,
    adjacency,
    levels,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  };
}

export async function loadGraphFromFile(file: File): Promise<GraphData> {
  const text = await file.text();
  return JSON.parse(text) as GraphData;
}
