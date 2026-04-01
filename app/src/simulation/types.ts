export type ShiftMode = "fill-drain" | "mixed" | "pure-induct" | "pure-retrieve";

export type SimConfig = {
  botCount: number;

  // Bot movement
  botSpeedMps: number;        // horizontal travel speed (m/s)
  zUpSpeedMps: number;        // vertical up speed (m/s) — typically much slower
  zDownSpeedMps: number;      // vertical down speed (m/s)
  xyTurnTimeS: number;        // time to turn within XY plane (seconds)
  xyzTransitionTimeS: number; // time to transition between XY and Z movement (seconds)

  // Station times (at the operator station)
  stationPickTimeS: number;   // operator loads pallet onto bot (induction start)
  stationDropTimeS: number;   // operator unloads pallet from bot (retrieval end)

  // Position times (at the pallet rack position)
  positionPickTimeS: number;  // bot picks pallet from rack (retrieval start)
  positionDropTimeS: number;  // bot places pallet into rack (induction end)

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
  botSpeedMps: 1.0,        // 1 m/s horizontal
  zUpSpeedMps: 0.1,         // 0.1 m/s going up (10x slower than horizontal)
  zDownSpeedMps: 0.5,       // 0.5 m/s going down (2x slower than horizontal)
  xyTurnTimeS: 2,           // 2 seconds to turn in XY
  xyzTransitionTimeS: 3,    // 3 seconds to switch between XY and Z
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
  stepsRemaining: number;   // ticks left for current operation (pick/place/edge)
  moveProgress: number;     // 0-1 for rendering interpolation
  edgeWaitTicks: number;    // remaining ticks for current edge traversal
  totalIdleSteps: number;
  totalBusySteps: number;
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

export type SkuInfo = {
  sku: string;
  color: string;
  weightKg: number;
  heightM: number;
  velocity: Velocity;
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
