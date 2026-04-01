export type ShiftMode = "fill-drain" | "mixed" | "pure-induct" | "pure-retrieve";

// Pathfinding / collision algorithm
// - "no-collision": bots ignore each other, no blocking. Fast baseline estimate.
// - "soft-collision": bots wait up to N ticks when blocked, then phase through. Realistic-ish.
// - "strict": full blocking, bots wait forever. Requires MAPF solver (Director) to avoid deadlocks.
// - "cooperative-astar": Cooperative A* with space-time reservations. Basic MAPF.
export type Algorithm = "no-collision" | "soft-collision" | "cooperative-astar" | "strict";

export type SimConfig = {
  botCount: number;
  algorithm: Algorithm;
  softCollisionWaitTicks: number; // max ticks to wait before phasing through (soft-collision mode)

  // Bot movement
  botSpeedMps: number;
  zUpSpeedMps: number;
  zDownSpeedMps: number;
  xyTurnTimeS: number;
  xyzTransitionTimeS: number;

  // Station times
  stationPickTimeS: number;
  stationDropTimeS: number;

  // Position times
  positionPickTimeS: number;
  positionDropTimeS: number;

  initialFillPct: number;
  skuCount: number;

  // Shift config
  shiftMode: ShiftMode;
  shiftPalletCount: number;

  // Multi-shift eval
  evalShiftCount: number;
};

export const DEFAULT_CONFIG: SimConfig = {
  botCount: 5,
  algorithm: "soft-collision",
  softCollisionWaitTicks: 5,
  botSpeedMps: 1.0,
  zUpSpeedMps: 0.1,
  zDownSpeedMps: 0.5,
  xyTurnTimeS: 2,
  xyzTransitionTimeS: 3,
  stationPickTimeS: 8,
  stationDropTimeS: 6,
  positionPickTimeS: 4,
  positionDropTimeS: 5,
  initialFillPct: 0.0,
  skuCount: 20,
  shiftMode: "mixed",
  shiftPalletCount: 100,
  evalShiftCount: 5,
};

export type BotState =
  | "IDLE"
  | "TRAVELING_TO_PICKUP"
  | "EDGE_WAIT"            // waiting out remaining ticks for current edge traversal
  | "PICKING"
  | "TRAVELING_TO_DROPOFF"
  | "EDGE_WAIT_DROP"       // same but during dropoff leg
  | "PLACING";

export type Bot = {
  id: number;
  state: BotState;
  currentNodeId: string;
  prevNodeId: string;
  path: string[];
  pathIndex: number;
  task: Task | null;
  stepsRemaining: number;
  moveProgress: number;
  edgeWaitTicks: number;
  collisionWaitTicks: number; // ticks spent waiting for another bot (soft-collision)
  totalIdleSteps: number;
  totalBusySteps: number;
  totalCollisionWaitSteps: number;
  tasksCompleted: number;
  totalDistanceM: number;
};

export type TaskType = "INDUCTION" | "RETRIEVAL";

export type Pallet = {
  sku: string;
  weightKg: number;
  heightM: number;
  placedAtStep: number;
};

export type Task = {
  id: number;
  type: TaskType;
  sku: string;
  stationNodeId: string;
  positionNodeId: string;
  assignedBotId: number | null;
  createdAtStep: number;
  completedAtStep: number | null;
  travelDistanceM: number;
  blockerPenalty: number;
};

export type ShiftResult = {
  shiftIndex: number;
  steps: number;
  completed: number;
  inductions: number;
  retrievals: number;
  palletsPerHour: number;
  avgBotUtilization: number;
};

export type SimState = {
  step: number;
  bots: Bot[];
  tasks: Task[];
  completedTasks: Task[];
  pallets: Map<string, Pallet>;
  botPositions: Map<string, number>;
  skuCatalog: SkuInfo[];
  eventLog: EventLogEntry[];

  shiftTasksGenerated: number;
  shiftPhase: "fill" | "drain" | "done";
  shiftDone: boolean;

  evalResults: ShiftResult[];
  evalRunning: boolean;
  currentShiftIndex: number;
};

export type Velocity = "high" | "medium" | "low";
export type HeightClass = "tall" | "medium" | "short";

export type SkuInfo = {
  sku: string;
  color: string;
  weightKg: number;
  heightM: number;
  velocity: Velocity;
  heightClass: HeightClass;
};

export type EventLogEntry = {
  step: number;
  type: TaskType;
  sku: string;
  botId: number;
  stationId: string;
  positionId: string;
  status: "assigned" | "completed";
};
