/**
 * Worker thread for parallel time-stepped simulation.
 * Each worker runs one (botCount, algorithm, shift) combination
 * and reports back the results.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { GraphData } from "../app/src/graph/types";
import { loadGraph } from "../app/src/graph/loader";
import type { SimConfig } from "../app/src/simulation/types";
import { DEFAULT_CONFIG } from "../app/src/simulation/types";
import { createInitialState, stepSimulation } from "../app/src/simulation/engine";
import { loadGraphIntoWasm } from "../app/src/simulation/wasm-bridge";

export type WorkerTask = {
  taskId: number;
  graphData: GraphData;
  baseConfig: SimConfig;
  botCount: number;
  algorithm: "no-collision" | "cooperative-astar";
  shiftIndex: number;
  palletCount: number;
};

export type WorkerResult = {
  taskId: number;
  botCount: number;
  algorithm: string;
  shiftIndex: number;
  avgCycleTimeS: number;
  throughputPerHour: number;
  avgUtilization: number;
  avgCollisionWaitPct: number;
  completedTasks: number;
  steps: number;
};

const task = workerData as WorkerTask;

// Initialize graph and pathfinding (JS fallback, no WASM in Node)
const graph = loadGraph(task.graphData);
const config: SimConfig = {
  ...task.baseConfig,
  botCount: task.botCount,
  algorithm: task.algorithm,
  shiftPalletCount: task.palletCount,
};

// Load graph into JS fallback pathfinder
loadGraphIntoWasm(task.graphData, config);

// Run the shift
let state = createInitialState(graph, config);
let safety = 0;
const maxSteps = config.shiftPalletCount * 500;

while (!state.shiftDone && safety < maxSteps) {
  state = stepSimulation(graph, state, config);
  safety++;
}

// Collect metrics
let totalCycleTime = 0;
let completedCount = 0;
for (const t of state.completedTasks) {
  if (t.completedAtStep !== null) {
    totalCycleTime += t.completedAtStep - t.createdAtStep;
    completedCount++;
  }
}

let totalUtilSum = 0;
let totalCollisionWaitSteps = 0;
let totalBusySteps = 0;
for (const bot of state.bots) {
  const busyPlusIdle = bot.totalBusySteps + bot.totalIdleSteps;
  if (busyPlusIdle > 0) {
    totalUtilSum += bot.totalBusySteps / busyPlusIdle;
  }
  totalCollisionWaitSteps += bot.totalCollisionWaitSteps;
  totalBusySteps += bot.totalBusySteps;
}

const avgCycleTimeS = completedCount > 0 ? totalCycleTime / completedCount : 0;
const timeHr = state.step / 3600;
const throughputPerHour = timeHr > 0 ? completedCount / timeHr : 0;
const avgUtilization = task.botCount > 0 ? totalUtilSum / task.botCount : 0;
const avgCollisionWaitPct = totalBusySteps > 0
  ? totalCollisionWaitSteps / (totalBusySteps + totalCollisionWaitSteps) : 0;

const result: WorkerResult = {
  taskId: task.taskId,
  botCount: task.botCount,
  algorithm: task.algorithm,
  shiftIndex: task.shiftIndex,
  avgCycleTimeS,
  throughputPerHour,
  avgUtilization,
  avgCollisionWaitPct,
  completedTasks: completedCount,
  steps: state.step,
};

parentPort!.postMessage(result);
