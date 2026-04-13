/**
 * Discrete Event Simulation (DES) engine for headless bot-count
 * and throughput analysis.
 *
 * Key differences from the time-stepped engine:
 * - Events on a priority queue, jumps between events (no idle ticks)
 * - Float-time seconds instead of integer ticks
 * - No collision modeling — station queues are the contention model
 * - Reuses WASM pathfinding for travel cost calculation
 * - Supports PIPO (full pallet) and PICO (case-out with partial returns)
 * - Configurable bot wait at station
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SimConfig, SkuInfo } from "./types";
import {
  EventQueue,
  type DESConfig,
  type DESEvent,
  type DESBot,
  type DESTask,
  type DESPallet,
  type DESStation,
  type DESShiftResult,
  type JobType,
  type PickTimeDistribution,
} from "./des-types";
import { samplePickTime } from "./pick-time-dist";
import { findPath, findPathBlocked, singleSourceCosts } from "./wasm-bridge";
import { computeBlockedNodesForCarrying, computePathDistanceM, generateSkuCatalog, pickSkuForOrder } from "./shared-utils";
import { buildLevelMaxMass, selectInductionPosition } from "./position-selector";

// ─── Internal state for a single DES shift run ───

type DESState = {
  time: number;
  queue: EventQueue;
  bots: DESBot[];
  tasks: Map<number, DESTask>;
  pendingTasks: DESTask[]; // unassigned tasks waiting for a bot
  completedTasks: DESTask[];
  pallets: Map<string, DESPallet>;
  stations: Map<string, DESStation>;
  skuCatalog: SkuInfo[];
  taskCounter: number;
  tasksGenerated: number;
  graph: WarehouseGraph;
  simConfig: SimConfig;
  desConfig: DESConfig;
  pickDist: PickTimeDistribution | null;
  shiftEndTime: number;
  // Tracking
  botWaitTimes: number[]; // per-task bot wait at station
  stationWaitTimes: number[]; // per-task station queue wait
  cycleTimes: number[]; // per-task total cycle time
};

// ─── Path finding helpers ───

function findPathForBot(
  fromId: string,
  toId: string,
  isCarrying: boolean,
  graph: WarehouseGraph,
  pallets: Map<string, unknown>,
): { totalCost: number; path: string[] } | null {
  if (isCarrying) {
    const blocked = computeBlockedNodesForCarrying(graph, pallets);
    return findPathBlocked(fromId, toId, blocked);
  }
  return findPath(fromId, toId);
}

function getTravelCost(
  fromId: string,
  toId: string,
  isCarrying: boolean,
  state: DESState,
): { costS: number; distanceM: number } | null {
  const result = findPathForBot(fromId, toId, isCarrying, state.graph, state.pallets);
  if (!result) return null;
  const distanceM = computePathDistanceM(result.path, state.graph);
  return { costS: result.totalCost, distanceM };
}

// ─── Task generation ───

function createDESTask(state: DESState): DESTask | null {
  const stationOps = state.graph.data.nodes.filter((n) => n.kind === "STATION_OP");
  if (stationOps.length === 0) return null;

  const station = stationOps[Math.floor(Math.random() * stationOps.length)];
  const skuInfo = pickSkuForOrder(state.skuCatalog);

  // Determine job type: PIPO or PICO based on config
  let jobType: JobType = state.desConfig.jobType;
  if (state.desConfig.jobType === "PICO") {
    // Use picoMixRatio to determine if this specific task is PICO or PIPO
    jobType = Math.random() < state.desConfig.picoMixRatio ? "PICO" : "PIPO";
  }

  // Determine induction vs retrieval (50/50 mixed)
  const wantInduction = Math.random() < 0.5;

  const pendingInductPositions = new Set<string>();
  const pendingRetrievePositions = new Set<string>();
  for (const [, t] of state.tasks) {
    if (t.type === "INDUCTION") pendingInductPositions.add(t.positionNodeId);
    else pendingRetrievePositions.add(t.positionNodeId);
  }
  for (const t of state.pendingTasks) {
    if (t.type === "INDUCTION") pendingInductPositions.add(t.positionNodeId);
    else pendingRetrievePositions.add(t.positionNodeId);
  }

  if (wantInduction) {
    const levelMaxMass = buildLevelMaxMass(state.graph);
    // Build a minimal SimState-like object for the position selector
    const simStateLike = {
      pallets: state.pallets as unknown as Map<string, { sku: string; weightKg: number; heightM: number; placedAtStep: number }>,
      skuCatalog: state.skuCatalog,
    };
    const targetId = selectInductionPosition(
      state.graph,
      simStateLike as any,
      skuInfo.weightKg,
      skuInfo.heightM,
      levelMaxMass,
      pendingInductPositions,
      skuInfo.velocity,
    );
    if (targetId === null) {
      // Try retrieval instead
      return createRetrievalTask(state, station.id, skuInfo, pendingRetrievePositions, jobType);
    }
    return {
      id: state.taskCounter++,
      jobType,
      type: "INDUCTION",
      sku: skuInfo.sku,
      stationNodeId: station.id,
      positionNodeId: targetId,
      createdAt: state.time,
      assignedBotId: null,
      assignedAt: null,
      completedAt: null,
      travelDistanceM: 0,
      pickTimeS: 0,
      casesTotal: jobType === "PICO" ? state.desConfig.casesPerPallet : 1,
      casesRemaining: jobType === "PICO" ? state.desConfig.casesPerPallet : 1,
      isPartialReturn: false,
    };
  } else {
    return createRetrievalTask(state, station.id, skuInfo, pendingRetrievePositions, jobType);
  }
}

function createRetrievalTask(
  state: DESState,
  stationNodeId: string,
  skuInfo: SkuInfo,
  pendingRetrievePositions: Set<string>,
  jobType: JobType,
): DESTask | null {
  const available = Array.from(state.pallets.entries()).filter(
    ([id]) => !pendingRetrievePositions.has(id),
  );
  if (available.length === 0) return null;

  const matching = available.filter(([, p]) => p.sku === skuInfo.sku);
  const [targetId, pallet] = matching.length > 0
    ? matching[Math.floor(Math.random() * matching.length)]
    : available[Math.floor(Math.random() * available.length)];

  return {
    id: state.taskCounter++,
    jobType,
    type: "RETRIEVAL",
    sku: pallet.sku,
    stationNodeId,
    positionNodeId: targetId,
    createdAt: state.time,
    assignedBotId: null,
    assignedAt: null,
    completedAt: null,
    travelDistanceM: 0,
    pickTimeS: 0,
    casesTotal: pallet.casesTotal,
    casesRemaining: pallet.casesRemaining,
    isPartialReturn: false,
  };
}

// ─── Dispatch: nearest-first ───

function dispatchTask(state: DESState, task: DESTask): void {
  const idleBots = state.bots.filter((b) => b.state === "IDLE");
  if (idleBots.length === 0) {
    state.pendingTasks.push(task);
    return;
  }

  // Find nearest idle bot using singleSourceCosts from the pickup location
  const pickupNodeId = task.type === "INDUCTION"
    ? task.stationNodeId
    : task.positionNodeId;

  let bestBot: DESBot | null = null;
  let bestCost = Infinity;

  // Use singleSourceCosts for efficiency (one Dijkstra from pickup, look up all bots)
  try {
    const costs = singleSourceCosts(pickupNodeId);
    for (const bot of idleBots) {
      const cost = costs.get(bot.currentNodeId);
      if (cost !== undefined && cost < bestCost) {
        bestCost = cost;
        bestBot = bot;
      }
    }
  } catch {
    // Fallback: individual findPath calls
    for (const bot of idleBots) {
      const result = findPath(bot.currentNodeId, pickupNodeId);
      if (result && result.totalCost < bestCost) {
        bestCost = result.totalCost;
        bestBot = bot;
      }
    }
  }

  if (!bestBot) {
    state.pendingTasks.push(task);
    return;
  }

  assignTaskToBot(state, bestBot, task, bestCost);
}

function assignTaskToBot(
  state: DESState,
  bot: DESBot,
  task: DESTask,
  travelCostS: number,
): void {
  // Record idle time
  bot.totalIdleTime += state.time - bot.lastStateChangeTime;
  bot.state = "TRAVELING";
  bot.taskId = task.id;
  bot.lastStateChangeTime = state.time;
  task.assignedBotId = bot.id;
  task.assignedAt = state.time;
  state.tasks.set(task.id, task);

  // Compute distance for the pickup leg
  const pickupNodeId = task.type === "INDUCTION"
    ? task.stationNodeId
    : task.positionNodeId;
  const pathResult = findPathForBot(bot.currentNodeId, pickupNodeId, false, state.graph, state.pallets);
  if (pathResult) {
    task.travelDistanceM += computePathDistanceM(pathResult.path, state.graph);
  }

  // Schedule arrival at pickup
  state.queue.push({
    time: state.time + travelCostS,
    type: "BOT_ARRIVES",
    botId: bot.id,
    taskId: task.id,
    nodeId: pickupNodeId,
  });
}

function tryDispatchPending(state: DESState): void {
  // Try to dispatch pending tasks to any newly idle bots
  while (state.pendingTasks.length > 0) {
    const idleBots = state.bots.filter((b) => b.state === "IDLE");
    if (idleBots.length === 0) break;

    const task = state.pendingTasks.shift()!;
    dispatchTask(state, task);
    // If it went back to pending, stop
    if (state.pendingTasks.length > 0 && state.pendingTasks[state.pendingTasks.length - 1] === task) {
      break;
    }
  }
}

// ─── Station helpers ───

function getOrCreateStation(state: DESState, nodeId: string): DESStation {
  let station = state.stations.get(nodeId);
  if (!station) {
    station = {
      nodeId,
      botQueue: [],
      currentBotId: null,
      busyUntil: 0,
      totalBusyTime: 0,
      totalIdleTime: 0,
      tasksProcessed: 0,
      lastEventTime: 0,
    };
    state.stations.set(nodeId, station);
  }
  return station;
}

function enterStation(
  state: DESState,
  bot: DESBot,
  task: DESTask,
  station: DESStation,
  isPickup: boolean,
): void {
  const stationWaitStart = state.time;

  if (station.currentBotId === null) {
    // Station is free — begin operation immediately
    station.totalIdleTime += state.time - station.lastEventTime;
    station.currentBotId = bot.id;
    station.lastEventTime = state.time;
    beginStationOperation(state, bot, task, station, isPickup);
  } else {
    // Station is busy — queue the bot
    station.botQueue.push(bot.id);
    bot.state = "WAITING_AT_STATION";
    bot.lastStateChangeTime = state.time;
    // Station wait time will be recorded when the bot eventually enters
  }
}

function beginStationOperation(
  state: DESState,
  bot: DESBot,
  task: DESTask,
  station: DESStation,
  isPickup: boolean,
): void {
  bot.state = "OPERATING";
  bot.lastStateChangeTime = state.time;

  let operationTimeS: number;

  if (isPickup) {
    if (task.type === "INDUCTION") {
      // Picking up from station (pallet load onto bot)
      operationTimeS = state.simConfig.stationPickTimeS;
    } else {
      // Picking up from position (bot picks from rack)
      operationTimeS = state.simConfig.positionPickTimeS;
    }
  } else {
    // Drop-off phase
    if (task.type === "INDUCTION") {
      // Placing at position (bot places in rack)
      operationTimeS = state.simConfig.positionDropTimeS;
    } else {
      // Dropping at station
      // For PICO: this is where cases get picked — use variable pick time
      if (task.jobType === "PICO" && state.pickDist) {
        const pallet = state.pallets.get(task.positionNodeId);
        const storageType = pallet?.storageType ?? "default";
        operationTimeS = samplePickTime(
          state.pickDist,
          storageType,
          state.desConfig.casesPerPick,
        );
      } else if (task.jobType === "PICO") {
        // No distribution loaded — use a formula: base + per-case time
        operationTimeS = state.simConfig.stationDropTimeS +
          state.desConfig.casesPerPick * 3; // 3s per case default
      } else {
        operationTimeS = state.simConfig.stationDropTimeS;
      }
    }
    task.pickTimeS = operationTimeS;
  }

  // For botWaitAtStation=false on drop-off (PICO at station):
  // Bot drops and leaves immediately, station processes independently
  if (!state.desConfig.botWaitAtStation && !isPickup && task.type === "RETRIEVAL") {
    // Free the bot immediately
    state.queue.push({
      time: state.time,
      type: "BOT_FREED",
      botId: bot.id,
      taskId: task.id,
    });

    // Schedule the station finishing independently
    const eventType = isPickup ? "PICK_COMPLETE" as const : "PLACE_COMPLETE" as const;
    state.queue.push({
      time: state.time + operationTimeS,
      type: eventType,
      botId: bot.id, // original bot, for task reference
      taskId: task.id,
      stationId: station.nodeId,
    });
    return;
  }

  // Normal case: bot waits for operation
  const eventType = isPickup ? "PICK_COMPLETE" as const : "PLACE_COMPLETE" as const;
  state.queue.push({
    time: state.time + operationTimeS,
    type: eventType,
    botId: bot.id,
    taskId: task.id,
    stationId: station.nodeId,
  });
}

function releaseStation(state: DESState, station: DESStation): void {
  station.totalBusyTime += state.time - station.lastEventTime;
  station.lastEventTime = state.time;
  station.currentBotId = null;
  station.tasksProcessed++;

  // Process next bot in queue
  if (station.botQueue.length > 0) {
    const nextBotId = station.botQueue.shift()!;
    const nextBot = state.bots[nextBotId];
    if (nextBot && nextBot.taskId !== null) {
      const nextTask = state.tasks.get(nextBot.taskId);
      if (nextTask) {
        // Record station wait time
        const waitTime = state.time - nextBot.lastStateChangeTime;
        state.stationWaitTimes.push(waitTime);
        nextBot.totalWaitTime += waitTime;

        station.currentBotId = nextBot.id;
        // Determine if this is pickup or dropoff
        const isPickup = isAtPickupLocation(nextBot, nextTask);
        beginStationOperation(state, nextBot, nextTask, station, isPickup);
      }
    }
  }
}

function isAtPickupLocation(bot: DESBot, task: DESTask): boolean {
  // The bot is at pickup if it hasn't completed the pickup phase yet
  // We track this by whether the task has a non-zero travel distance
  // (after pickup, distance gets added for the dropoff leg)
  // Simpler: check bot's current node vs task nodes
  if (task.type === "INDUCTION") {
    return bot.currentNodeId === task.stationNodeId;
  }
  return bot.currentNodeId === task.positionNodeId;
}

// ─── Event handlers ───

function handleShiftStart(state: DESState): void {
  // Generate initial tasks
  const initialBatch = Math.min(state.bots.length * 2, 20);
  for (let i = 0; i < initialBatch; i++) {
    const task = createDESTask(state);
    if (task) {
      state.tasksGenerated++;
      dispatchTask(state, task);
    }
  }
  // Schedule ongoing task generation
  scheduleNextTaskGeneration(state);
}

function scheduleNextTaskGeneration(state: DESState): void {
  const nextTime = state.time + state.desConfig.taskInterarrivalS;
  if (nextTime < state.shiftEndTime) {
    state.queue.push({ time: nextTime, type: "TASK_GENERATED" });
  }
}

function handleTaskGenerated(state: DESState): void {
  const task = createDESTask(state);
  if (task) {
    state.tasksGenerated++;
    dispatchTask(state, task);
  }
  scheduleNextTaskGeneration(state);
}

function handleBotArrives(state: DESState, event: DESEvent): void {
  const bot = state.bots[event.botId!];
  const task = state.tasks.get(event.taskId!);
  if (!bot || !task) return;

  bot.totalTravelTime += state.time - bot.lastStateChangeTime;
  bot.currentNodeId = event.nodeId!;
  bot.lastStateChangeTime = state.time;

  // Determine if arriving at pickup or dropoff
  const isPickup = isAtPickupLocation(bot, task);

  // Enter station or position — use station queue model for STATION_OP nodes
  const nodeKind = state.graph.nodeMap.get(event.nodeId!)?.kind;
  if (nodeKind === "STATION_OP") {
    const station = getOrCreateStation(state, event.nodeId!);
    enterStation(state, bot, task, station, isPickup);
  } else {
    // Position node — no queue, operate immediately
    bot.state = "OPERATING";
    const opTime = isPickup
      ? state.simConfig.positionPickTimeS
      : state.simConfig.positionDropTimeS;

    const eventType = isPickup ? "PICK_COMPLETE" as const : "PLACE_COMPLETE" as const;
    state.queue.push({
      time: state.time + opTime,
      type: eventType,
      botId: bot.id,
      taskId: task.id,
      nodeId: event.nodeId,
    });
  }
}

function handlePickComplete(state: DESState, event: DESEvent): void {
  const bot = state.bots[event.botId!];
  const task = state.tasks.get(event.taskId!);
  if (!bot || !task) return;

  bot.totalBusyTime += state.time - bot.lastStateChangeTime;
  bot.lastStateChangeTime = state.time;

  // Release station if at one
  if (event.stationId) {
    const station = state.stations.get(event.stationId);
    if (station) releaseStation(state, station);
  }

  // Now travel to dropoff
  const dropoffNodeId = task.type === "INDUCTION"
    ? task.positionNodeId
    : task.stationNodeId;

  const travel = getTravelCost(bot.currentNodeId, dropoffNodeId, true, state);
  if (!travel) {
    // Can't find path — complete task as-is
    completeTask(state, bot, task);
    return;
  }

  task.travelDistanceM += travel.distanceM;
  bot.state = "TRAVELING";
  bot.lastStateChangeTime = state.time;

  state.queue.push({
    time: state.time + travel.costS,
    type: "BOT_ARRIVES",
    botId: bot.id,
    taskId: task.id,
    nodeId: dropoffNodeId,
  });
}

function handlePlaceComplete(state: DESState, event: DESEvent): void {
  const bot = state.bots[event.botId!];
  const task = state.tasks.get(event.taskId!);
  if (!task) return;

  // Release station if at one
  if (event.stationId) {
    const station = state.stations.get(event.stationId);
    if (station) releaseStation(state, station);
  }

  // Update pallet state
  if (task.type === "INDUCTION") {
    // Place pallet at position
    const skuInfo = state.skuCatalog.find((s) => s.sku === task.sku);
    state.pallets.set(task.positionNodeId, {
      sku: task.sku,
      weightKg: skuInfo?.weightKg ?? 500,
      heightM: skuInfo?.heightM ?? 1.0,
      placedAt: state.time,
      casesTotal: task.casesTotal,
      casesRemaining: task.casesRemaining,
      storageType: "default",
      velocity: skuInfo?.velocity ?? "medium",
    });
  } else {
    // Retrieval: update or remove pallet
    if (task.jobType === "PICO") {
      // PICO: deduct cases picked
      const pallet = state.pallets.get(task.positionNodeId);
      if (pallet) {
        const newRemaining = pallet.casesRemaining - state.desConfig.casesPerPick;
        if (newRemaining > 0) {
          // Partial pick — return pallet to storage
          state.pallets.set(task.positionNodeId, {
            ...pallet,
            casesRemaining: newRemaining,
          });
        } else {
          // Pallet depleted — remove
          state.pallets.delete(task.positionNodeId);
        }
      }
    } else {
      // PIPO: remove entire pallet
      state.pallets.delete(task.positionNodeId);
    }
  }

  // If botWaitAtStation=false, the bot may already be freed
  if (bot) {
    completeTask(state, bot, task);
  } else {
    // Bot was freed earlier — just record task completion
    task.completedAt = state.time;
    state.completedTasks.push(task);
    state.tasks.delete(task.id);
    const cycleTime = task.completedAt - task.createdAt;
    state.cycleTimes.push(cycleTime);
  }
}

function handleBotFreed(state: DESState, event: DESEvent): void {
  const bot = state.bots[event.botId!];
  if (!bot) return;

  bot.totalBusyTime += state.time - bot.lastStateChangeTime;
  bot.state = "IDLE";
  bot.taskId = null;
  bot.tasksCompleted++;
  bot.lastStateChangeTime = state.time;

  tryDispatchPending(state);
}

function completeTask(state: DESState, bot: DESBot, task: DESTask): void {
  bot.totalBusyTime += state.time - bot.lastStateChangeTime;
  bot.state = "IDLE";
  bot.taskId = null;
  bot.tasksCompleted++;
  bot.totalDistanceM += task.travelDistanceM;
  bot.lastStateChangeTime = state.time;

  task.completedAt = state.time;
  state.completedTasks.push(task);
  state.tasks.delete(task.id);

  const cycleTime = task.completedAt - task.createdAt;
  state.cycleTimes.push(cycleTime);

  tryDispatchPending(state);
}

// ─── Main event loop ───

function processEvent(state: DESState, event: DESEvent): void {
  state.time = event.time;

  switch (event.type) {
    case "SHIFT_START":
      handleShiftStart(state);
      break;
    case "TASK_GENERATED":
      handleTaskGenerated(state);
      break;
    case "TASK_DISPATCHED":
      // Handled inline by dispatchTask
      break;
    case "BOT_ARRIVES":
      handleBotArrives(state, event);
      break;
    case "PICK_COMPLETE":
      handlePickComplete(state, event);
      break;
    case "PLACE_COMPLETE":
      handlePlaceComplete(state, event);
      break;
    case "BOT_FREED":
      handleBotFreed(state, event);
      break;
    case "SHIFT_END":
      // Handled by the main loop exit condition
      break;
  }
}

// ─── Public API ───

export function runDESShift(
  graph: WarehouseGraph,
  simConfig: SimConfig,
  desConfig: DESConfig,
  pickDist: PickTimeDistribution | null = null,
  shiftIndex: number = 0,
  existingPallets?: Map<string, DESPallet>,
): DESShiftResult {
  const aisles = graph.data.nodes.filter((n) => n.kind === "AISLE_CELL");
  const stationOps = graph.data.nodes.filter((n) => n.kind === "STATION_OP");
  const palletPositions = graph.data.nodes.filter((n) => n.kind === "PALLET_POSITION");
  const startNodes = aisles.length > 0 ? aisles : stationOps.length > 0 ? stationOps : graph.data.nodes;

  // Initialize bots
  const bots: DESBot[] = [];
  for (let i = 0; i < simConfig.botCount; i++) {
    const startNode = startNodes[i % startNodes.length];
    bots.push({
      id: i,
      state: "IDLE",
      currentNodeId: startNode.id,
      taskId: null,
      busyUntil: 0,
      totalIdleTime: 0,
      totalBusyTime: 0,
      totalTravelTime: 0,
      totalWaitTime: 0,
      tasksCompleted: 0,
      totalDistanceM: 0,
      lastStateChangeTime: 0,
    });
  }

  // Initialize pallets
  const pallets = new Map<string, DESPallet>();
  if (existingPallets) {
    for (const [k, v] of existingPallets) pallets.set(k, { ...v });
  } else {
    const fillCount = Math.floor(palletPositions.length * simConfig.initialFillPct);
    const shuffled = [...palletPositions].sort(() => Math.random() - 0.5);
    const skuCatalog = generateSkuCatalog(simConfig.skuCount);
    for (let i = 0; i < fillCount; i++) {
      const skuInfo = pickSkuForOrder(skuCatalog);
      pallets.set(shuffled[i].id, {
        sku: skuInfo.sku,
        weightKg: skuInfo.weightKg,
        heightM: skuInfo.heightM,
        placedAt: 0,
        casesTotal: desConfig.jobType === "PICO" ? desConfig.casesPerPallet : 1,
        casesRemaining: desConfig.jobType === "PICO" ? desConfig.casesPerPallet : 1,
        storageType: "default",
        velocity: skuInfo.velocity,
      });
    }
  }

  const state: DESState = {
    time: 0,
    queue: new EventQueue(),
    bots,
    tasks: new Map(),
    pendingTasks: [],
    completedTasks: [],
    pallets,
    stations: new Map(),
    skuCatalog: generateSkuCatalog(simConfig.skuCount),
    taskCounter: 0,
    tasksGenerated: 0,
    graph,
    simConfig,
    desConfig,
    pickDist,
    shiftEndTime: desConfig.shiftDurationS,
    botWaitTimes: [],
    stationWaitTimes: [],
    cycleTimes: [],
  };

  // Schedule shift boundaries
  state.queue.push({ time: 0, type: "SHIFT_START" });
  state.queue.push({ time: desConfig.shiftDurationS, type: "SHIFT_END" });

  // Main loop
  let safetyCounter = 0;
  const maxEvents = 1_000_000;
  while (state.queue.size > 0 && safetyCounter < maxEvents) {
    const event = state.queue.peek();
    if (!event || event.time > state.shiftEndTime) break;

    processEvent(state, state.queue.pop()!);
    safetyCounter++;
  }

  // Finalize bot stats — account for remaining idle time
  for (const bot of state.bots) {
    if (bot.state === "IDLE") {
      bot.totalIdleTime += state.time - bot.lastStateChangeTime;
    }
  }

  // Finalize station stats
  for (const [, station] of state.stations) {
    if (station.currentBotId === null) {
      station.totalIdleTime += state.time - station.lastEventTime;
    } else {
      station.totalBusyTime += state.time - station.lastEventTime;
    }
  }

  // Compute metrics
  const durationS = state.time;
  const durationHr = durationS / 3600;
  const tasksCompleted = state.completedTasks.length;

  const avgBotUtil = bots.length > 0
    ? bots.reduce((sum, b) => {
        const total = b.totalBusyTime + b.totalTravelTime + b.totalIdleTime + b.totalWaitTime;
        return sum + (total > 0 ? (b.totalBusyTime + b.totalTravelTime) / total : 0);
      }, 0) / bots.length
    : 0;

  const stationList = Array.from(state.stations.values());
  const avgStationUtil = stationList.length > 0
    ? stationList.reduce((sum, s) => {
        const total = s.totalBusyTime + s.totalIdleTime;
        return sum + (total > 0 ? s.totalBusyTime / total : 0);
      }, 0) / stationList.length
    : 0;

  const cycleTimes = state.cycleTimes.sort((a, b) => a - b);
  const avgCycleTime = cycleTimes.length > 0
    ? cycleTimes.reduce((s, v) => s + v, 0) / cycleTimes.length
    : 0;
  const p95CycleTime = cycleTimes.length > 0
    ? cycleTimes[Math.floor(cycleTimes.length * 0.95)]
    : 0;

  const botWaits = state.botWaitTimes;
  const stationWaits = state.stationWaitTimes;

  return {
    shiftIndex,
    durationS,
    tasksCompleted,
    inductionsCompleted: state.completedTasks.filter((t) => t.type === "INDUCTION").length,
    retrievalsCompleted: state.completedTasks.filter((t) => t.type === "RETRIEVAL").length,
    throughputPerHour: durationHr > 0 ? tasksCompleted / durationHr : 0,
    botUtilPct: avgBotUtil * 100,
    stationUtilPct: avgStationUtil * 100,
    avgCycleTimeS: avgCycleTime,
    p95CycleTimeS: p95CycleTime,
    avgBotQueueWaitS: botWaits.length > 0
      ? botWaits.reduce((s, v) => s + v, 0) / botWaits.length : 0,
    maxBotQueueWaitS: botWaits.length > 0 ? Math.max(...botWaits) : 0,
    avgStationQueueWaitS: stationWaits.length > 0
      ? stationWaits.reduce((s, v) => s + v, 0) / stationWaits.length : 0,
    maxStationQueueWaitS: stationWaits.length > 0 ? Math.max(...stationWaits) : 0,
    cycleTimes,
  };
}
