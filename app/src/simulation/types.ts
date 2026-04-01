export type ShiftMode = "fill-drain" | "mixed" | "pure-induct" | "pure-retrieve";

export type SimConfig = {
  botCount: number;
  botSpeedMps: number;

  // Station times (at the operator station)
  stationPickTimeS: number;  // time for operator to load pallet onto bot at station (induction)
  stationDropTimeS: number;  // time for operator to unload pallet from bot at station (retrieval)

  // Position times (at the pallet position in the rack)
  positionPickTimeS: number; // time for bot to pick pallet from rack position (retrieval)
  positionDropTimeS: number; // time for bot to place pallet into rack position (induction)

  xyCostPerM: number;
  zUpCostPerM: number;
  zDownCostPerM: number;
  xyTurnCost: number;
  xyzTurnCost: number;
  zUpTravelMultiplier: number;
  zDownTravelMultiplier: number;
  initialFillPct: number;
  skuCount: number;

  // Shift config
  shiftMode: ShiftMode;
  shiftPalletCount: number;

  // Multi-shift eval
  evalShiftCount: number; // number of shifts in a full eval run
};

export const DEFAULT_CONFIG: SimConfig = {
  botCount: 5,
  botSpeedMps: 1.0,
  stationPickTimeS: 8,
  stationDropTimeS: 6,
  positionPickTimeS: 4,
  positionDropTimeS: 5,
  xyCostPerM: 1.0,
  zUpCostPerM: 3.0,
  zDownCostPerM: 2.0,
  xyTurnCost: 2.0,
  xyzTurnCost: 3.0,
  zUpTravelMultiplier: 10,
  zDownTravelMultiplier: 2,
  initialFillPct: 0.0,
  skuCount: 20,
  shiftMode: "mixed",
  shiftPalletCount: 100,
  evalShiftCount: 5,
};

export type BotState =
  | "IDLE"
  | "TRAVELING_TO_PICKUP"
  | "TRAVELING_Z_WAIT"
  | "PICKING"
  | "TRAVELING_TO_DROPOFF"
  | "TRAVELING_Z_WAIT_DROP"
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
  zWaitTicks: number;
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

  // Shift tracking
  shiftTasksGenerated: number;
  shiftPhase: "fill" | "drain" | "done";
  shiftDone: boolean;

  // Multi-shift eval
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
