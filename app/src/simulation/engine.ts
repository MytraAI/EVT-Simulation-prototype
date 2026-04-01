import type { WarehouseGraph } from "../graph/loader";
import type {
  SimConfig,
  SimState,
  Bot,
  Task,
  Pallet,
  SkuInfo,
  EventLogEntry,
  Velocity,
} from "./types";
import { findPath, findPathBlocked } from "./wasm-bridge";
import { buildLevelMaxMass, selectInductionPosition } from "./position-selector";

/**
 * Compute nodes that are blocked for pallet-carrying bots.
 * When a pallet occupies a position, its bot_occupancy_occlusions
 * list nodes that a carrying bot cannot traverse.
 */
function computeBlockedNodesForCarrying(
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
 * Find a path, using blocked pathfinding if the bot is/will be carrying a pallet.
 */
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

const SKU_PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9A6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#a9a9a9",
  "#e6beff", "#1ce6ff", "#ff34ff", "#ff4a46", "#008941",
  "#006fa6", "#a30059", "#ffdbe5", "#7a4900", "#0000a6",
];

function generateSkuCatalog(count: number): SkuInfo[] {
  const skus: SkuInfo[] = [];
  const third = Math.max(1, Math.floor(count / 3));
  for (let i = 0; i < count; i++) {
    let velocity: Velocity;
    if (i < third) velocity = "high";
    else if (i < third * 2) velocity = "medium";
    else velocity = "low";

    let weightKg: number;
    if (velocity === "high") {
      weightKg = 600 + Math.random() * 400;
    } else if (velocity === "low") {
      weightKg = Math.random() < 0.5 ? 600 + Math.random() * 400 : 200 + Math.random() * 300;
    } else {
      weightKg = 200 + Math.random() * 800;
    }

    skus.push({
      sku: `SKU-${String(i + 1).padStart(3, "0")}`,
      color: SKU_PALETTE[i % SKU_PALETTE.length],
      weightKg,
      heightM: 0.5 + Math.random() * 1.3,
      velocity,
    });
  }
  return skus;
}

function pickSkuForOrder(catalog: SkuInfo[]): SkuInfo {
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

/**
 * Compute actual distance in meters for a path (sum of edge distance_m).
 */
function computePathDistanceM(path: string[], graph: WarehouseGraph): number {
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
 * How many ticks (seconds) does it take to traverse one edge?
 * XY: distance / botSpeedMps
 * Z-up: distance / zUpSpeedMps
 * Z-down: distance / zDownSpeedMps
 * All rounded up, minimum 1 tick.
 */
function edgeTravelTicks(
  fromId: string,
  toId: string,
  graph: WarehouseGraph,
  config: SimConfig,
): number {
  const edge = graph.data.edges.find(
    (e) =>
      (e.a === fromId && e.b === toId) ||
      (e.b === fromId && e.a === toId),
  );
  if (!edge) return 1;

  if (edge.axis === "z") {
    const fromNode = graph.nodeMap.get(fromId);
    const toNode = graph.nodeMap.get(toId);
    if (fromNode && toNode) {
      const goingUp = toNode.position.z_m > fromNode.position.z_m;
      const speed = goingUp ? config.zUpSpeedMps : config.zDownSpeedMps;
      return Math.max(1, Math.ceil(edge.distance_m / speed));
    }
  }

  return Math.max(1, Math.ceil(edge.distance_m / config.botSpeedMps));
}

/**
 * Check if a bot should wait at its current node due to collision.
 * Returns true if the bot should NOT move this tick.
 *
 * - "no-collision": never blocked, bots share nodes freely
 * - "soft-collision": blocked up to softCollisionWaitTicks, then phases through
 * - "strict": always blocked (requires MAPF solver like Director)
 */
function shouldWaitForCollision(
  nextNodeId: string,
  bot: Bot,
  botPositions: Map<string, number>,
  config: SimConfig,
): boolean {
  if (config.algorithm === "no-collision") return false;

  const occupyingBotId = botPositions.get(nextNodeId);
  if (occupyingBotId === undefined || occupyingBotId === bot.id) return false;

  // Node is occupied by another bot
  if (config.algorithm === "strict") return true;

  // soft-collision: wait up to N ticks, then phase through
  return bot.collisionWaitTicks < config.softCollisionWaitTicks;
}

// ─── State creation ───

export function createInitialState(
  graph: WarehouseGraph,
  config: SimConfig,
): SimState {
  const aisles = graph.data.nodes.filter((n) => n.kind === "AISLE_CELL");
  const stationOps = graph.data.nodes.filter((n) => n.kind === "STATION_OP");
  const palletPositions = graph.data.nodes.filter(
    (n) => n.kind === "PALLET_POSITION",
  );

  const startNodes =
    aisles.length > 0 ? aisles : stationOps.length > 0 ? stationOps : graph.data.nodes;

  const bots: Bot[] = [];
  for (let i = 0; i < config.botCount; i++) {
    const startNode = startNodes[i % startNodes.length];
    bots.push({
      id: i,
      state: "IDLE",
      currentNodeId: startNode.id,
      prevNodeId: startNode.id,
      path: [],
      pathIndex: 0,
      task: null,
      stepsRemaining: 0,
      moveProgress: 1,
      edgeWaitTicks: 0,
      collisionWaitTicks: 0,
      totalIdleSteps: 0,
      totalBusySteps: 0,
      totalCollisionWaitSteps: 0,
      tasksCompleted: 0,
      totalDistanceM: 0,
    });
  }

  const skuCatalog = generateSkuCatalog(config.skuCount);

  const pallets = new Map<string, Pallet>();
  const fillCount = Math.floor(palletPositions.length * config.initialFillPct);
  const shuffled = [...palletPositions].sort(() => Math.random() - 0.5);
  for (let i = 0; i < fillCount; i++) {
    const skuInfo = pickSkuForOrder(skuCatalog);
    pallets.set(shuffled[i].id, {
      sku: skuInfo.sku,
      weightKg: skuInfo.weightKg,
      heightM: skuInfo.heightM,
      placedAtStep: 0,
    });
  }

  let shiftPhase: "fill" | "drain" | "done" = "fill";
  if (config.shiftMode === "pure-retrieve") shiftPhase = "drain";

  return {
    step: 0,
    bots,
    tasks: [],
    completedTasks: [],
    pallets,
    botPositions: new Map(bots.map((b) => [b.currentNodeId, b.id])),
    skuCatalog,
    eventLog: [],
    shiftTasksGenerated: 0,
    shiftPhase,
    shiftDone: false,
    evalResults: [],
    evalRunning: false,
    currentShiftIndex: 0,
  };
}

// ─── Task generation ───

let taskCounter = 0;

function generateShiftTask(
  graph: WarehouseGraph,
  state: SimState,
  config: SimConfig,
): { task: Task | null; newPhase: "fill" | "drain" | "done" } {
  const stationOps = graph.data.nodes.filter((n) => n.kind === "STATION_OP");
  if (stationOps.length === 0) return { task: null, newPhase: state.shiftPhase };

  const totalTarget = config.shiftPalletCount;
  const generated = state.shiftTasksGenerated;
  if (generated >= totalTarget) return { task: null, newPhase: "done" };

  const station = stationOps[Math.floor(Math.random() * stationOps.length)];
  const skuInfo = pickSkuForOrder(state.skuCatalog);

  let wantInduction: boolean;
  switch (config.shiftMode) {
    case "pure-induct": wantInduction = true; break;
    case "pure-retrieve": wantInduction = false; break;
    case "fill-drain": {
      const half = Math.ceil(totalTarget / 2);
      wantInduction = state.shiftPhase === "fill" && generated < half;
      break;
    }
    case "mixed":
    default:
      wantInduction = Math.random() < 0.5;
      break;
  }

  const pendingInductPositions = new Set(
    state.tasks.filter((t) => t.type === "INDUCTION").map((t) => t.positionNodeId),
  );
  const pendingRetrievePositions = new Set(
    state.tasks.filter((t) => t.type === "RETRIEVAL").map((t) => t.positionNodeId),
  );

  if (wantInduction) {
    const levelMaxMass = buildLevelMaxMass(graph);
    const targetId = selectInductionPosition(
      graph, state, skuInfo.weightKg, levelMaxMass, pendingInductPositions, skuInfo.velocity,
    );
    if (targetId === null) {
      if (config.shiftMode === "mixed") {
        return tryRetrieve(state, graph, station, skuInfo, pendingRetrievePositions);
      }
      return { task: null, newPhase: state.shiftPhase };
    }
    return {
      task: {
        id: taskCounter++, type: "INDUCTION", sku: skuInfo.sku,
        stationNodeId: station.id, positionNodeId: targetId,
        assignedBotId: null, createdAtStep: state.step,
        completedAtStep: null, travelDistanceM: 0, blockerPenalty: 0,
      },
      newPhase: config.shiftMode === "fill-drain" && generated + 1 >= Math.ceil(totalTarget / 2)
        ? "drain" : state.shiftPhase,
    };
  } else {
    return tryRetrieve(state, graph, station, skuInfo, pendingRetrievePositions);
  }
}

function tryRetrieve(
  state: SimState,
  graph: WarehouseGraph,
  station: { id: string },
  skuInfo: SkuInfo,
  pendingRetrievePositions: Set<string>,
): { task: Task | null; newPhase: "fill" | "drain" | "done" } {
  const available = Array.from(state.pallets.entries()).filter(
    ([id]) => !pendingRetrievePositions.has(id),
  );
  if (available.length === 0) return { task: null, newPhase: state.shiftPhase };

  const matching = available.filter(([, p]) => p.sku === skuInfo.sku);
  const [targetId] = matching.length > 0
    ? matching[Math.floor(Math.random() * matching.length)]
    : available[Math.floor(Math.random() * available.length)];

  return {
    task: {
      id: taskCounter++, type: "RETRIEVAL", sku: state.pallets.get(targetId)!.sku,
      stationNodeId: station.id, positionNodeId: targetId,
      assignedBotId: null, createdAtStep: state.step,
      completedAtStep: null, travelDistanceM: 0, blockerPenalty: 0,
    },
    newPhase: state.shiftPhase,
  };
}

// ─── Bot movement ───

/**
 * Attempt to move bot one node along path. Returns true if arrived at end.
 * Collision handling depends on config.algorithm.
 */
function moveBotAlongPath(
  bot: Bot,
  graph: WarehouseGraph,
  config: SimConfig,
  botPositions: Map<string, number>,
): boolean {
  if (bot.pathIndex >= bot.path.length - 1) return true;

  const nextNodeId = bot.path[bot.pathIndex + 1];

  // Check collision
  if (shouldWaitForCollision(nextNodeId, bot, botPositions, config)) {
    bot.collisionWaitTicks++;
    bot.totalCollisionWaitSteps++;
    return false; // wait this tick
  }

  // Moving — reset collision counter
  bot.collisionWaitTicks = 0;

  const ticks = edgeTravelTicks(bot.currentNodeId, nextNodeId, graph, config);

  bot.prevNodeId = bot.currentNodeId;
  bot.pathIndex++;
  bot.currentNodeId = bot.path[bot.pathIndex];
  bot.moveProgress = 0;

  if (ticks > 1) {
    bot.edgeWaitTicks = ticks - 1;
  }

  // Track actual distance
  const edge = graph.data.edges.find(
    (e) =>
      (e.a === bot.prevNodeId && e.b === bot.currentNodeId) ||
      (e.b === bot.prevNodeId && e.a === bot.currentNodeId),
  );
  if (edge) bot.totalDistanceM += edge.distance_m;

  return bot.pathIndex >= bot.path.length - 1;
}

// ─── Simulation step ───

export function stepSimulation(
  graph: WarehouseGraph,
  state: SimState,
  config: SimConfig,
): SimState {
  if (state.shiftDone) return state;

  // Each tick = 1 second of sim time
  const newStep = state.step + 1;

  const pallets = new Map(state.pallets);
  let tasks = [...state.tasks];
  let completedTasks = [...state.completedTasks];
  const eventLog = [...state.eventLog];
  const botPositions = new Map(state.botPositions);
  let shiftTasksGenerated = state.shiftTasksGenerated;
  let shiftPhase = state.shiftPhase;
  let shiftDone: boolean = state.shiftDone;

  // Generate tasks
  const idleBots = state.bots.filter((b) => b.state === "IDLE").length;
  const unassignedTasks = tasks.filter((t) => t.assignedBotId === null).length;

  if (!shiftDone && unassignedTasks < idleBots + 2 && shiftTasksGenerated < config.shiftPalletCount) {
    const { task, newPhase } = generateShiftTask(
      graph,
      { ...state, pallets, tasks, shiftTasksGenerated, shiftPhase } as SimState,
      config,
    );
    if (task) {
      tasks.push(task);
      shiftTasksGenerated++;
      shiftPhase = newPhase;
    }
  }

  if (shiftTasksGenerated >= config.shiftPalletCount && tasks.length === 0) {
    shiftDone = true;
  }

  // Update each bot
  const updatedBots = state.bots.map((bot) => {
    const b = { ...bot };

    // Advance rendering interpolation
    if (b.moveProgress < 1) {
      b.moveProgress = Math.min(1, b.moveProgress + 0.3);
    }

    // Handle edge-wait (slow edges: Z traversal, long XY edges)
    if (b.state === "EDGE_WAIT" || b.state === "EDGE_WAIT_DROP") {
      b.totalBusySteps++;
      b.edgeWaitTicks--;
      if (b.edgeWaitTicks <= 0) {
        // Resume traveling
        const travelState = b.state === "EDGE_WAIT"
          ? "TRAVELING_TO_PICKUP" as const
          : "TRAVELING_TO_DROPOFF" as const;

        // Check if we've already arrived at destination
        if (b.pathIndex >= b.path.length - 1) {
          if (travelState === "TRAVELING_TO_PICKUP") {
            b.state = "PICKING";
            b.stepsRemaining = b.task?.type === "INDUCTION"
              ? config.stationPickTimeS
              : config.positionPickTimeS;
          } else {
            b.state = "PLACING";
            b.stepsRemaining = b.task?.type === "INDUCTION"
              ? config.positionDropTimeS
              : config.stationDropTimeS;
          }
        } else {
          b.state = travelState;
        }
      }
      return b;
    }

    switch (b.state) {
      case "IDLE": {
        b.totalIdleSteps++;
        const unassigned = tasks.find((t) => t.assignedBotId === null);
        if (unassigned) {
          unassigned.assignedBotId = b.id;
          b.task = { ...unassigned };

          const pickupTarget = unassigned.type === "INDUCTION"
            ? unassigned.stationNodeId
            : unassigned.positionNodeId;

          // Not carrying yet — use normal pathfinding
          const pathResult = findPathForBot(b.currentNodeId, pickupTarget, false, graph, pallets);
          if (pathResult) {
            b.path = pathResult.path;
            b.pathIndex = 0;
            b.state = "TRAVELING_TO_PICKUP";
            b.task.travelDistanceM += computePathDistanceM(pathResult.path, graph);

            eventLog.push({
              step: newStep, type: unassigned.type, sku: unassigned.sku,
              botId: b.id, stationId: unassigned.stationNodeId,
              positionId: unassigned.positionNodeId, status: "assigned",
            });
          }
        }
        break;
      }

      case "TRAVELING_TO_PICKUP": {
        b.totalBusySteps++;
        botPositions.delete(b.currentNodeId);
        const arrived = moveBotAlongPath(b, graph, config, botPositions);
        botPositions.set(b.currentNodeId, b.id);

        if (b.edgeWaitTicks > 0) {
          b.state = "EDGE_WAIT";
          return b;
        }

        if (arrived) {
          b.state = "PICKING";
          b.stepsRemaining = b.task?.type === "INDUCTION"
            ? config.stationPickTimeS
            : config.positionPickTimeS;
        }
        break;
      }

      case "PICKING": {
        b.totalBusySteps++;
        b.stepsRemaining--;
        if (b.stepsRemaining <= 0 && b.task) {
          const dropoffTarget = b.task.type === "INDUCTION"
            ? b.task.positionNodeId
            : b.task.stationNodeId;

          // Carrying pallet — use blocked pathfinding to avoid occluded nodes
          const pathResult = findPathForBot(b.currentNodeId, dropoffTarget, true, graph, pallets);
          if (pathResult) {
            b.path = pathResult.path;
            b.pathIndex = 0;
            b.state = "TRAVELING_TO_DROPOFF";
            b.task.travelDistanceM += computePathDistanceM(pathResult.path, graph);
          } else {
            b.state = "IDLE";
            b.task = null;
          }
        }
        break;
      }

      case "TRAVELING_TO_DROPOFF": {
        b.totalBusySteps++;
        botPositions.delete(b.currentNodeId);
        const arrived = moveBotAlongPath(b, graph, config, botPositions);
        botPositions.set(b.currentNodeId, b.id);

        if (b.edgeWaitTicks > 0) {
          b.state = "EDGE_WAIT_DROP";
          return b;
        }

        if (arrived) {
          b.state = "PLACING";
          b.stepsRemaining = b.task?.type === "INDUCTION"
            ? config.positionDropTimeS
            : config.stationDropTimeS;
        }
        break;
      }

      case "PLACING": {
        b.totalBusySteps++;
        b.stepsRemaining--;
        if (b.stepsRemaining <= 0 && b.task) {
          if (b.task.type === "INDUCTION") {
            const skuInfo = state.skuCatalog.find((s) => s.sku === b.task!.sku);
            pallets.set(b.task.positionNodeId, {
              sku: b.task.sku,
              weightKg: skuInfo?.weightKg ?? 500,
              heightM: skuInfo?.heightM ?? 1.0,
              placedAtStep: newStep,
            });
          } else {
            pallets.delete(b.task.positionNodeId);
          }

          b.task.completedAtStep = newStep;
          completedTasks.push(b.task);
          tasks = tasks.filter((t) => t.id !== b.task!.id);

          eventLog.push({
            step: newStep, type: b.task.type, sku: b.task.sku,
            botId: b.id, stationId: b.task.stationNodeId,
            positionId: b.task.positionNodeId, status: "completed",
          });

          b.tasksCompleted++;
          b.state = "IDLE";
          b.task = null;
        }
        break;
      }
    }

    return b;
  });

  const trimmedLog = eventLog.length > 200 ? eventLog.slice(eventLog.length - 200) : eventLog;

  return {
    step: newStep, bots: updatedBots, tasks, completedTasks, pallets, botPositions,
    skuCatalog: state.skuCatalog, eventLog: trimmedLog,
    shiftTasksGenerated, shiftPhase, shiftDone,
    evalResults: state.evalResults, evalRunning: state.evalRunning,
    currentShiftIndex: state.currentShiftIndex,
  };
}

// ─── Multi-shift eval ───

export function runMultiShiftEval(
  graph: WarehouseGraph,
  config: SimConfig,
): SimState {
  const results: import("./types").ShiftResult[] = [];
  let carryPallets: Map<string, Pallet> | null = null;

  for (let i = 0; i < config.evalShiftCount; i++) {
    let state = createInitialState(graph, config);
    if (carryPallets) state = { ...state, pallets: new Map(carryPallets) };
    state = { ...state, evalRunning: true, currentShiftIndex: i, evalResults: results };

    let safety = 0;
    const maxSteps = config.shiftPalletCount * 500;
    while (!state.shiftDone && safety < maxSteps) {
      state = stepSimulation(graph, state, config);
      safety++;
    }

    const inductions = state.completedTasks.filter((t) => t.type === "INDUCTION").length;
    const retrievals = state.completedTasks.filter((t) => t.type === "RETRIEVAL").length;
    const timeHr = state.step / 3600; // step = seconds
    const avgUtil = state.bots.length > 0
      ? state.bots.reduce(
          (sum, b) => sum + b.totalBusySteps / Math.max(1, b.totalBusySteps + b.totalIdleSteps),
          0,
        ) / state.bots.length
      : 0;

    results.push({
      shiftIndex: i, steps: state.step, completed: state.completedTasks.length,
      inductions, retrievals,
      palletsPerHour: timeHr > 0 ? state.completedTasks.length / timeHr : 0,
      avgBotUtilization: avgUtil,
    });

    carryPallets = state.pallets;
  }

  let finalState = createInitialState(graph, config);
  if (carryPallets) finalState = { ...finalState, pallets: new Map(carryPallets) };
  return {
    ...finalState,
    evalResults: results, evalRunning: false, shiftDone: true,
    currentShiftIndex: config.evalShiftCount - 1,
  };
}
