/**
 * Discrete Event Simulation (DES) types.
 *
 * These types power the headless DES engine used for bot-count sweeps
 * and throughput analysis. They live alongside the existing time-stepped
 * simulation types and share graph/config types.
 */

import type { Velocity } from "./types";

// ─── Event system ───

export type DESEventType =
  | "SHIFT_START"
  | "SHIFT_END"
  | "TASK_GENERATED"
  | "TASK_DISPATCHED"
  | "BOT_ARRIVES"
  | "PICK_COMPLETE"
  | "PLACE_COMPLETE"
  | "BOT_FREED";

export type DESEvent = {
  time: number; // seconds (float)
  type: DESEventType;
  botId?: number;
  taskId?: number;
  nodeId?: string;
  stationId?: string;
};

/**
 * Binary min-heap priority queue for DES events.
 * Keyed on event.time with FIFO tie-breaking via sequence counter.
 */
export class EventQueue {
  private heap: { event: DESEvent; seq: number }[] = [];
  private seqCounter = 0;

  push(event: DESEvent): void {
    const entry = { event, seq: this.seqCounter++ };
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  pop(): DESEvent | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0].event;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  peek(): DESEvent | undefined {
    return this.heap[0]?.event;
  }

  get size(): number {
    return this.heap.length;
  }

  clear(): void {
    this.heap = [];
    this.seqCounter = 0;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private less(a: number, b: number): boolean {
    const ea = this.heap[a];
    const eb = this.heap[b];
    if (ea.event.time !== eb.event.time) return ea.event.time < eb.event.time;
    return ea.seq < eb.seq; // FIFO tie-break
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = tmp;
  }
}

// ─── Job types ───

export type JobType = "PIPO" | "PICO";

export type DESTask = {
  id: number;
  jobType: JobType;
  type: "INDUCTION" | "RETRIEVAL";
  sku: string;
  stationNodeId: string;
  positionNodeId: string;
  createdAt: number; // sim seconds
  assignedBotId: number | null;
  assignedAt: number | null;
  completedAt: number | null;
  travelDistanceM: number;
  pickTimeS: number; // sampled or fixed
  // PICO tracking
  casesTotal: number; // total cases on pallet (1 for PIPO)
  casesRemaining: number; // remaining after pick
  isPartialReturn: boolean; // true if returning partially-picked pallet to storage
};

// ─── Pallet ───

export type DESPallet = {
  sku: string;
  weightKg: number;
  heightM: number;
  placedAt: number; // sim seconds
  casesTotal: number;
  casesRemaining: number;
  storageType: string;
  velocity: Velocity;
};

// ─── Station ───

export type DESStation = {
  nodeId: string;
  botQueue: number[]; // botIds waiting
  currentBotId: number | null;
  busyUntil: number; // sim time when current op finishes
  totalBusyTime: number;
  totalIdleTime: number;
  tasksProcessed: number;
  lastEventTime: number; // for idle time tracking
};

// ─── Bot ───

export type DESBotState = "IDLE" | "TRAVELING" | "WAITING_AT_STATION" | "OPERATING";

export type DESBot = {
  id: number;
  state: DESBotState;
  currentNodeId: string;
  taskId: number | null;
  busyUntil: number;
  // Aggregate stats
  totalIdleTime: number;
  totalBusyTime: number;
  totalTravelTime: number;
  totalWaitTime: number;
  tasksCompleted: number;
  totalDistanceM: number;
  lastStateChangeTime: number; // for computing durations
};

// ─── Configuration ───

export type DESConfig = {
  jobType: JobType;
  picoMixRatio: number; // 0-1, fraction of tasks that are PICO (rest are PIPO)
  botWaitAtStation: boolean;
  shiftDurationS: number; // e.g. 28800 for 8hr
  taskInterarrivalS: number; // mean time between task generations
  casesPerPallet: number; // for PICO pallets, how many cases per pallet
  casesPerPick: number; // how many cases picked per station visit
  // Sweep config
  sweepMinBots: number;
  sweepMaxBots: number;
  sweepStepBots: number;
  sweepShiftsPerPoint: number;
};

export const DEFAULT_DES_CONFIG: DESConfig = {
  jobType: "PIPO",
  picoMixRatio: 0.5,
  botWaitAtStation: true,
  shiftDurationS: 28800, // 8 hours
  taskInterarrivalS: 30,
  casesPerPallet: 24,
  casesPerPick: 4,
  sweepMinBots: 1,
  sweepMaxBots: 20,
  sweepStepBots: 1,
  sweepShiftsPerPoint: 3,
};

// ─── Pick time distribution ───

export type PickTimeBucket = {
  storageType: string;
  quantityBucket: string; // e.g. "1-5", "6-10"
  samples: number[]; // empirical pick times in seconds
};

export type PickTimeDistribution = {
  buckets: PickTimeBucket[];
};

// ─── Output metrics ───

export type DESShiftResult = {
  shiftIndex: number;
  durationS: number;
  tasksCompleted: number;
  inductionsCompleted: number;
  retrievalsCompleted: number;
  throughputPerHour: number;
  botUtilPct: number;
  stationUtilPct: number;
  avgCycleTimeS: number;
  p95CycleTimeS: number;
  avgBotQueueWaitS: number;
  maxBotQueueWaitS: number;
  avgStationQueueWaitS: number;
  maxStationQueueWaitS: number;
  cycleTimes: number[]; // raw cycle times for aggregation
};

export type DESSweepPoint = {
  botCount: number;
  shiftResults: DESShiftResult[];
  // Aggregates across shifts
  avgThroughputPerHour: number;
  avgBotUtilPct: number;
  avgStationUtilPct: number;
  avgCycleTimeS: number;
  p95CycleTimeS: number;
  avgBotQueueWaitS: number;
  maxBotQueueWaitS: number;
  p95BotQueueWaitS: number;
  avgStationQueueWaitS: number;
  maxStationQueueWaitS: number;
  totalPalletsProcessed: number;
};
