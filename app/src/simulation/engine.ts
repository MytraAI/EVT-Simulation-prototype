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
import { findPath } from "./wasm-bridge";
import { buildLevelMaxMass, selectInductionPosition } from "./position-selector";

const SKU_PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9A6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#a9a9a9",
  "#e6beff", "#1ce6ff", "#ff34ff", "#ff4a46", "#008941",
  "#006fa6", "#a30059", "#ffdbe5", "#7a4900", "#0000a6",
];

// SKU velocity split among catalog items (roughly even thirds)
// But ORDER frequency is 5:3:1 (high:medium:low) — see pickSkuForOrder()
function generateSkuCatalog(count: number): SkuInfo[] {
  const skus: SkuInfo[] = [];
  const third = Math.max(1, Math.floor(count / 3));

  for (let i = 0; i < count; i++) {
    let velocity: Velocity;
    if (i < third) velocity = "high";
    else if (i < third * 2) velocity = "medium";
    else velocity = "low";

    // High velocity SKUs → heavy (600-1000 kg)
    // 50% of low velocity SKUs → also heavy, other 50% → light (200-500 kg)
    // Medium → any distribution (200-1000 kg)
    let weightKg: number;
    if (velocity === "high") {
      weightKg = 600 + Math.random() * 400; // 600-1000 kg (heavy)
    } else if (velocity === "low") {
      if (Math.random() < 0.5) {
        weightKg = 600 + Math.random() * 400; // heavy half
      } else {
        weightKg = 200 + Math.random() * 300; // light half
      }
    } else {
      weightKg = 200 + Math.random() * 800; // 200-1000 kg (any)
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

/**
 * Pick a SKU for a new order using 5:3:1 ratio (high:medium:low).
 */
function pickSkuForOrder(catalog: SkuInfo[]): SkuInfo {
  const high = catalog.filter((s) => s.velocity === "high");
  const medium = catalog.filter((s) => s.velocity === "medium");
  const low = catalog.filter((s) => s.velocity === "low");

  // Weighted random: 5 parts high, 3 parts medium, 1 part low
  const r = Math.random() * 9;
  let pool: SkuInfo[];
  if (r < 5 && high.length > 0) pool = high;
  else if (r < 8 && medium.length > 0) pool = medium;
  else if (low.length > 0) pool = low;
  else pool = catalog; // fallback

  return pool[Math.floor(Math.random() * pool.length)];
}

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
    aisles.length > 0
      ? aisles
      : stationOps.length > 0
        ? stationOps
        : graph.data.nodes;

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
      zWaitTicks: 0,
      totalIdleSteps: 0,
      totalBusySteps: 0,
      tasksCompleted: 0,
      totalDistanceM: 0,
    });
  }

  const skuCatalog = generateSkuCatalog(config.skuCount);

  // Pre-fill warehouse
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

  // Determine initial shift phase
  let shiftPhase: "fill" | "drain" | "done" = "fill";
  if (config.shiftMode === "pure-retrieve") shiftPhase = "drain";
  if (config.shiftMode === "mixed") shiftPhase = "fill"; // doesn't matter for mixed

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

  if (generated >= totalTarget) {
    return { task: null, newPhase: "done" };
  }

  const station = stationOps[Math.floor(Math.random() * stationOps.length)];
  const skuInfo =
    pickSkuForOrder(state.skuCatalog);

  const palletPositions = graph.data.nodes.filter(
    (n) => n.kind === "PALLET_POSITION",
  );
  const maxPositions = palletPositions.length;

  // Figure out if this task is induction or retrieval
  let wantInduction: boolean;

  switch (config.shiftMode) {
    case "pure-induct":
      wantInduction = true;
      break;
    case "pure-retrieve":
      wantInduction = false;
      break;
    case "fill-drain": {
      const half = Math.ceil(totalTarget / 2);
      if (state.shiftPhase === "fill" && generated < half) {
        wantInduction = true;
      } else {
        wantInduction = false;
      }
      break;
    }
    case "mixed":
    default:
      wantInduction = Math.random() < 0.5;
      break;
  }

  // Positions already claimed by pending tasks
  const pendingInductPositions = new Set(
    state.tasks.filter((t) => t.type === "INDUCTION").map((t) => t.positionNodeId),
  );
  const pendingRetrievePositions = new Set(
    state.tasks.filter((t) => t.type === "RETRIEVAL").map((t) => t.positionNodeId),
  );

  if (wantInduction) {
    // Smart position selection: weight-level compliance, blocker minimization,
    // level balance, radial balance
    const levelMaxMass = buildLevelMaxMass(graph);
    const targetId = selectInductionPosition(
      graph,
      state,
      skuInfo.weightKg,
      levelMaxMass,
      pendingInductPositions,
      skuInfo.velocity,
    );
    if (targetId === null) {
      // Can't induct — warehouse full. For mixed mode, try retrieve instead
      if (config.shiftMode === "mixed") {
        return tryRetrieve(state, graph, station, skuInfo, pendingRetrievePositions);
      }
      return { task: null, newPhase: state.shiftPhase };
    }
    return {
      task: {
        id: taskCounter++,
        type: "INDUCTION",
        sku: skuInfo.sku,
        stationNodeId: station.id,
        positionNodeId: targetId,
        assignedBotId: null,
        createdAtStep: state.step,
        completedAtStep: null,
        travelDistanceM: 0,
        blockerPenalty: 0,
      },
      newPhase:
        config.shiftMode === "fill-drain" && generated + 1 >= Math.ceil(totalTarget / 2)
          ? "drain"
          : state.shiftPhase,
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
  // Find occupied positions not already claimed
  const available = Array.from(state.pallets.entries()).filter(
    ([id]) => !pendingRetrievePositions.has(id),
  );
  if (available.length === 0) {
    return { task: null, newPhase: state.shiftPhase };
  }

  // Prefer matching SKU
  const matching = available.filter(([, p]) => p.sku === skuInfo.sku);
  const [targetId] =
    matching.length > 0
      ? matching[Math.floor(Math.random() * matching.length)]
      : available[Math.floor(Math.random() * available.length)];

  const actualSku = state.pallets.get(targetId)!.sku;

  return {
    task: {
      id: taskCounter++,
      type: "RETRIEVAL",
      sku: actualSku,
      stationNodeId: station.id,
      positionNodeId: targetId,
      assignedBotId: null,
      createdAtStep: state.step,
      completedAtStep: null,
      travelDistanceM: 0,
      blockerPenalty: 0,
    },
    newPhase: state.shiftPhase,
  };
}

/**
 * Check if moving from prevNode to nextNode is a Z-axis move and return
 * the extra ticks to wait. Returns 0 for XY moves.
 */
function getZWaitTicks(
  prevNodeId: string,
  nextNodeId: string,
  graph: WarehouseGraph,
  config: SimConfig,
): number {
  const edge = graph.data.edges.find(
    (e) =>
      (e.a === prevNodeId && e.b === nextNodeId) ||
      (e.b === prevNodeId && e.a === nextNodeId),
  );
  if (!edge || edge.axis !== "z") return 0;

  const prev = graph.nodeMap.get(prevNodeId);
  const next = graph.nodeMap.get(nextNodeId);
  if (!prev || !next) return 0;

  const goingUp = next.position.z_m > prev.position.z_m;
  // Subtract 1 because the move itself takes 1 tick
  return goingUp
    ? Math.max(0, config.zUpTravelMultiplier - 1)
    : Math.max(0, config.zDownTravelMultiplier - 1);
}

function moveBotAlongPath(
  bot: Bot,
  graph: WarehouseGraph,
  config: SimConfig,
): boolean {
  if (bot.pathIndex >= bot.path.length - 1) return true;

  const nextNodeId = bot.path[bot.pathIndex + 1];

  // Check Z-wait for this edge
  const extraTicks = getZWaitTicks(bot.currentNodeId, nextNodeId, graph, config);
  if (extraTicks > 0) {
    bot.zWaitTicks = extraTicks;
  }

  bot.prevNodeId = bot.currentNodeId;
  bot.pathIndex++;
  bot.currentNodeId = bot.path[bot.pathIndex];
  bot.moveProgress = 0;

  const edge = graph.data.edges.find(
    (e) =>
      (e.a === bot.prevNodeId && e.b === bot.currentNodeId) ||
      (e.b === bot.prevNodeId && e.a === bot.currentNodeId),
  );
  if (edge) bot.totalDistanceM += edge.distance_m;

  return bot.pathIndex >= bot.path.length - 1;
}

export function stepSimulation(
  graph: WarehouseGraph,
  state: SimState,
  config: SimConfig,
): SimState {
  // Don't advance if shift is already done
  if (state.shiftDone) return state;

  const newStep = state.step + 1;

  const pallets = new Map(state.pallets);
  let tasks = [...state.tasks];
  let completedTasks = [...state.completedTasks];
  const eventLog = [...state.eventLog];
  const botPositions = new Map(state.botPositions);
  let shiftTasksGenerated = state.shiftTasksGenerated;
  let shiftPhase = state.shiftPhase;
  let shiftDone: boolean = state.shiftDone;

  // Generate tasks if shift not done and we have idle bots or few pending tasks
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
    if (shiftTasksGenerated >= config.shiftPalletCount) {
      shiftDone = tasks.length === 0 && completedTasks.length >= config.shiftPalletCount;
    }
  }

  // Check if all tasks are done
  if (shiftTasksGenerated >= config.shiftPalletCount && tasks.length === 0) {
    shiftDone = true;
  }

  // Update each bot
  const updatedBots = state.bots.map((bot) => {
    const b = { ...bot };

    // Advance move interpolation
    if (b.moveProgress < 1) {
      b.moveProgress = Math.min(1, b.moveProgress + 0.3);
    }

    // Handle Z-wait states
    if (b.state === "TRAVELING_Z_WAIT" || b.state === "TRAVELING_Z_WAIT_DROP") {
      b.totalBusySteps++;
      b.zWaitTicks--;
      if (b.zWaitTicks <= 0) {
        b.state = b.state === "TRAVELING_Z_WAIT"
          ? "TRAVELING_TO_PICKUP"
          : "TRAVELING_TO_DROPOFF";
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

          const pickupTarget =
            unassigned.type === "INDUCTION"
              ? unassigned.stationNodeId
              : unassigned.positionNodeId;

          const pathResult = findPath(b.currentNodeId, pickupTarget);
          if (pathResult) {
            b.path = pathResult.path;
            b.pathIndex = 0;
            b.state = "TRAVELING_TO_PICKUP";
            b.task.travelDistanceM += pathResult.totalCost;

            eventLog.push({
              step: newStep,
              type: unassigned.type,
              sku: unassigned.sku,
              botId: b.id,
              stationId: unassigned.stationNodeId,
              positionId: unassigned.positionNodeId,
              status: "assigned",
            });
          }
        }
        break;
      }

      case "TRAVELING_TO_PICKUP": {
        b.totalBusySteps++;
        botPositions.delete(b.currentNodeId);
        const arrived = moveBotAlongPath(b, graph, config);
        botPositions.set(b.currentNodeId, b.id);

        // If we just did a Z move, enter wait state
        if (b.zWaitTicks > 0) {
          b.state = "TRAVELING_Z_WAIT";
          return b;
        }

        if (arrived) {
          b.state = "PICKING";
          // Induction: picking up at station (operator load time)
          // Retrieval: picking up at rack position (bot pick time)
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
          const dropoffTarget =
            b.task.type === "INDUCTION"
              ? b.task.positionNodeId
              : b.task.stationNodeId;

          const pathResult = findPath(b.currentNodeId, dropoffTarget);
          if (pathResult) {
            b.path = pathResult.path;
            b.pathIndex = 0;
            b.state = "TRAVELING_TO_DROPOFF";
            b.task.travelDistanceM += pathResult.totalCost;
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
        const arrived = moveBotAlongPath(b, graph, config);
        botPositions.set(b.currentNodeId, b.id);

        if (b.zWaitTicks > 0) {
          b.state = "TRAVELING_Z_WAIT_DROP";
          return b;
        }

        if (arrived) {
          b.state = "PLACING";
          // Induction: placing at rack position (bot place time)
          // Retrieval: dropping at station (operator unload time)
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
            const skuInfo = state.skuCatalog.find(
              (s) => s.sku === b.task!.sku,
            );
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
            step: newStep,
            type: b.task.type,
            sku: b.task.sku,
            botId: b.id,
            stationId: b.task.stationNodeId,
            positionId: b.task.positionNodeId,
            status: "completed",
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

  const trimmedLog =
    eventLog.length > 200 ? eventLog.slice(eventLog.length - 200) : eventLog;

  return {
    step: newStep,
    bots: updatedBots,
    tasks,
    completedTasks,
    pallets,
    botPositions,
    skuCatalog: state.skuCatalog,
    eventLog: trimmedLog,
    shiftTasksGenerated,
    shiftPhase,
    shiftDone,
    evalResults: state.evalResults,
    evalRunning: state.evalRunning,
    currentShiftIndex: state.currentShiftIndex,
  };
}

/**
 * Run a full multi-shift eval: runs N shifts back-to-back, collecting results.
 * Returns the final state with evalResults populated.
 */
export function runMultiShiftEval(
  graph: WarehouseGraph,
  config: SimConfig,
): SimState {
  const results: import("./types").ShiftResult[] = [];

  let carryPallets: Map<string, Pallet> | null = null;

  for (let i = 0; i < config.evalShiftCount; i++) {
    // Create fresh state for each shift, carrying over pallets from previous
    let state = createInitialState(graph, config);

    // If we have pallets from previous shift, use them
    if (carryPallets) {
      state = { ...state, pallets: new Map(carryPallets) };
    }

    state = {
      ...state,
      evalRunning: true,
      currentShiftIndex: i,
      evalResults: results,
    };

    // Run until shift done
    let safety = 0;
    const maxSteps = config.shiftPalletCount * 500; // safety limit
    while (!state.shiftDone && safety < maxSteps) {
      state = stepSimulation(graph, state, config);
      safety++;
    }

    const inductions = state.completedTasks.filter((t) => t.type === "INDUCTION").length;
    const retrievals = state.completedTasks.filter((t) => t.type === "RETRIEVAL").length;
    const timeHr = state.step / 3600;
    const avgUtil = state.bots.length > 0
      ? state.bots.reduce(
          (sum, b) => sum + b.totalBusySteps / Math.max(1, b.totalBusySteps + b.totalIdleSteps),
          0,
        ) / state.bots.length
      : 0;

    results.push({
      shiftIndex: i,
      steps: state.step,
      completed: state.completedTasks.length,
      inductions,
      retrievals,
      palletsPerHour: timeHr > 0 ? state.completedTasks.length / timeHr : 0,
      avgBotUtilization: avgUtil,
    });

    // Carry pallets to next shift
    carryPallets = state.pallets;
  }

  // Return a final state with all eval results
  let finalState = createInitialState(graph, config);
  if (carryPallets) {
    finalState = { ...finalState, pallets: new Map(carryPallets) };
  }
  finalState = {
    ...finalState,
    evalResults: results,
    evalRunning: false,
    shiftDone: true,
    currentShiftIndex: config.evalShiftCount - 1,
  };

  return finalState;
}
