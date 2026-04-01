// Graph types matching the map JSON schema (consistent with maps/viz)

export type GraphNode = {
  id: string;
  kind: NodeKind;
  level: number;
  position: { x_m: number; y_m: number; z_m: number };
  max_pallet_height_m: number;
  max_pallet_mass_kg: number;
  x: number;
  y: number;
  row_index?: number;
  size_x_m: number;
  size_y_m: number;
  has_charger?: boolean;
  pallet_meta?: { travel: boolean };
  station_meta?: { station?: string; module?: string };
  computed?: {
    bot_occupancy_occlusions?: string[];
  };
};

export type GraphEdge = {
  id: string;
  a: string;
  b: string;
  axis: "x" | "y" | "z";
  distance_m: number;
  max_pallet_height_m?: number;
  is_safety_slow_zone?: boolean;
};

export type PhysicalColumn = {
  id: string;
  x_m: number;
  y_m: number;
  width_m: number;
  depth_m: number;
};

export type LayoutConfig = {
  upright_width_in: number;
  upright_gap_in: number;
  row_width_in: number;
  tray_width_in: number;
  tray_length_in: number;
  tray_spacing_in: number;
  vertical_clearance_in: number;
  pallet_mass_kg: number;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata?: {
    physical?: {
      layout?: LayoutConfig;
      columns?: PhysicalColumn[];
    };
  };
};

export const NODE_KINDS = [
  "AISLE_CELL",
  "PALLET_POSITION",
  "Z_COLUMN",
  "STATION_XY",
  "STATION_OP",
  "STATION_PEZ",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const KIND_COLORS: Record<NodeKind, string> = {
  AISLE_CELL: "#4dd0e1",
  PALLET_POSITION: "#ffca28",
  Z_COLUMN: "#ef5350",
  STATION_XY: "#66bb6a",
  STATION_OP: "#ab47bc",
  STATION_PEZ: "#ffa726",
};

// Three.js hex versions
export const KIND_HEX: Record<NodeKind, number> = {
  AISLE_CELL: 0x4dd0e1,
  PALLET_POSITION: 0xffca28,
  Z_COLUMN: 0xef5350,
  STATION_XY: 0x66bb6a,
  STATION_OP: 0xab47bc,
  STATION_PEZ: 0xffa726,
};
