#!/usr/bin/env -S npx tsx
/**
 * Headless congestion calibration runner.
 *
 * Uses Node cluster module to fork workers across all cores.
 * Each worker runs the full time-stepped simulation for one
 * (botCount, algorithm, shift) combination.
 *
 * Usage:
 *   npx tsx scripts/run-calibration.ts [options]
 *
 * Options:
 *   --map <path>       Graph JSON (default: app/public/grainger-pilot-04102026-graph.json)
 *   --bots <list>      Bot counts to sample (default: 1,2,4,6,8,10,12,15,18,20)
 *   --shifts <n>       Shifts per (botCount, algo) pair (default: 5)
 *   --pallets <n>      Tasks per shift (default: 100)
 *   --workers <n>      Max workers (default: CPU count - 1)
 *   --out <path>       Output JSON (default: calibration-results.json)
 *   --csv <path>       Also output CSV
 */

import cluster from "node:cluster";
import { cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import sim modules directly (tsx resolves these)
import type { GraphData } from "../app/src/graph/types.js";
import { loadGraph } from "../app/src/graph/loader.js";
import type { SimConfig } from "../app/src/simulation/types.js";
import { DEFAULT_CONFIG } from "../app/src/simulation/types.js";
import { createInitialState, stepSimulation } from "../app/src/simulation/engine.js";
import { loadGraphIntoWasm } from "../app/src/simulation/wasm-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ───

type WorkItem = {
  id: number;
  botCount: number;
  algorithm: "no-collision" | "cooperative-astar";
  shiftIndex: number;
};

type WorkResult = {
  id: number;
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

// ─── Parse CLI args ───

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i]?.startsWith("--")) {
      opts[args[i].slice(2)] = args[i + 1] ?? "";
    }
  }
  return {
    mapPath: opts.map ?? resolve(__dirname, "../app/public/grainger-pilot-04102026-graph.json"),
    botCounts: (opts.bots ?? "1,2,4,6,8,10,12,15,18,20").split(",").map(Number),
    shiftsPerSample: parseInt(opts.shifts ?? "5", 10),
    palletCount: parseInt(opts.pallets ?? "100", 10),
    maxWorkers: parseInt(opts.workers ?? String(Math.max(1, cpus().length - 1)), 10),
    outPath: opts.out ?? "calibration-results.json",
    csvPath: opts.csv,
  };
}

// ─── Worker logic (runs in forked process) ───

function runSimWorker() {
  process.on("message", (msg: { type: string; item: WorkItem; graphData: GraphData; baseConfig: SimConfig; palletCount: number }) => {
    if (msg.type !== "work") return;

    const { item, graphData, baseConfig, palletCount } = msg;
    const graph = loadGraph(graphData);
    const config: SimConfig = {
      ...baseConfig,
      botCount: item.botCount,
      algorithm: item.algorithm as SimConfig["algorithm"],
      shiftPalletCount: palletCount,
    };

    // Initialize JS pathfinding fallback
    loadGraphIntoWasm(graphData, config);

    // Run shift
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

    const result: WorkResult = {
      id: item.id,
      botCount: item.botCount,
      algorithm: item.algorithm,
      shiftIndex: item.shiftIndex,
      avgCycleTimeS: completedCount > 0 ? totalCycleTime / completedCount : 0,
      throughputPerHour: state.step > 0 ? completedCount / (state.step / 3600) : 0,
      avgUtilization: item.botCount > 0 ? totalUtilSum / item.botCount : 0,
      avgCollisionWaitPct: totalBusySteps > 0
        ? totalCollisionWaitSteps / (totalBusySteps + totalCollisionWaitSteps) : 0,
      completedTasks: completedCount,
      steps: state.step,
    };

    process.send!({ type: "result", result });
  });
}

// ─── Primary logic ───

async function runPrimary() {
  const opts = parseArgs();

  console.log("=== EVT DES Congestion Calibration ===");
  console.log(`Map:        ${opts.mapPath}`);
  console.log(`Bot counts: ${opts.botCounts.join(", ")}`);
  console.log(`Shifts:     ${opts.shiftsPerSample} per (botCount, algorithm)`);
  console.log(`Pallets:    ${opts.palletCount} per shift`);
  console.log(`Workers:    ${opts.maxWorkers} (of ${cpus().length} cores)`);
  console.log();

  const graphData: GraphData = JSON.parse(readFileSync(opts.mapPath, "utf-8"));
  console.log(`Graph: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);

  // Build work items
  const algorithms: ("no-collision" | "cooperative-astar")[] = ["no-collision", "cooperative-astar"];
  const items: WorkItem[] = [];
  let id = 0;
  for (const botCount of opts.botCounts) {
    for (const algorithm of algorithms) {
      for (let shift = 0; shift < opts.shiftsPerSample; shift++) {
        items.push({ id: id++, botCount, algorithm, shiftIndex: shift });
      }
    }
  }

  console.log(`Total work units: ${items.length}`);
  console.log();

  // Fork workers
  const numWorkers = Math.min(opts.maxWorkers, items.length);
  const workers: ReturnType<typeof cluster.fork>[] = [];
  const results: WorkResult[] = [];
  const queue = [...items];
  let completed = 0;
  const startTime = Date.now();

  return new Promise<void>((resolveMain) => {
    function sendWork(worker: ReturnType<typeof cluster.fork>) {
      const item = queue.shift();
      if (!item) return false;
      worker.send({
        type: "work",
        item,
        graphData,
        baseConfig: DEFAULT_CONFIG,
        palletCount: opts.palletCount,
      });
      return true;
    }

    for (let i = 0; i < numWorkers; i++) {
      const worker = cluster.fork();
      workers.push(worker);

      worker.on("message", (msg: { type: string; result: WorkResult }) => {
        if (msg.type !== "result") return;
        results.push(msg.result);
        completed++;

        const pct = ((completed / items.length) * 100).toFixed(0);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (completed / ((Date.now() - startTime) / 1000)).toFixed(1);
        const remaining = items.length - completed;
        const eta = completed > 0
          ? (remaining / (completed / ((Date.now() - startTime) / 1000))).toFixed(0)
          : "?";
        process.stdout.write(
          `\r  [${pct}%] ${completed}/${items.length} | ${elapsed}s | ${rate}/s | ETA ${eta}s | ` +
          `${msg.result.botCount}bots ${msg.result.algorithm} s${msg.result.shiftIndex} → ` +
          `${msg.result.completedTasks} tasks in ${msg.result.steps} steps` +
          "      "
        );

        // Send more work or kill worker
        if (!sendWork(worker)) {
          worker.kill();
          const aliveWorkers = workers.filter((w) => !w.isDead());
          if (aliveWorkers.length === 0) {
            console.log("\n");
            printResults(opts, results, startTime);
            resolveMain();
          }
        }
      });

      worker.on("error", (err) => {
        console.error(`\nWorker ${worker.id} error:`, err.message);
      });

      // Send initial work
      sendWork(worker);
    }
  });
}

function printResults(
  opts: ReturnType<typeof parseArgs>,
  results: WorkResult[],
  startTime: number,
) {
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Completed in ${totalTime}s`);
  console.log();

  // Aggregate by (botCount, algorithm)
  const agg = new Map<string, WorkResult[]>();
  for (const r of results) {
    const key = `${r.botCount}:${r.algorithm}`;
    if (!agg.has(key)) agg.set(key, []);
    agg.get(key)!.push(r);
  }

  type Sample = {
    botCount: number;
    noCollision: { avgCycleTimeS: number; throughputPerHour: number; avgUtilization: number; avgCollisionWaitPct: number; totalTasks: number; shiftsRun: number };
    cooperativeAStar: { avgCycleTimeS: number; throughputPerHour: number; avgUtilization: number; avgCollisionWaitPct: number; totalTasks: number; shiftsRun: number };
    cycleTimePenalty: number;
    throughputPenalty: number;
  };

  function aggregate(rs: WorkResult[]) {
    const n = rs.length;
    return {
      avgCycleTimeS: n > 0 ? rs.reduce((s, r) => s + r.avgCycleTimeS, 0) / n : 0,
      throughputPerHour: n > 0 ? rs.reduce((s, r) => s + r.throughputPerHour, 0) / n : 0,
      avgUtilization: n > 0 ? rs.reduce((s, r) => s + r.avgUtilization, 0) / n : 0,
      avgCollisionWaitPct: n > 0 ? rs.reduce((s, r) => s + r.avgCollisionWaitPct, 0) / n : 0,
      totalTasks: rs.reduce((s, r) => s + r.completedTasks, 0),
      shiftsRun: n,
    };
  }

  const samples: Sample[] = [];
  for (const botCount of opts.botCounts) {
    const nc = aggregate(agg.get(`${botCount}:no-collision`) ?? []);
    const ca = aggregate(agg.get(`${botCount}:cooperative-astar`) ?? []);
    samples.push({
      botCount,
      noCollision: nc,
      cooperativeAStar: ca,
      cycleTimePenalty: nc.avgCycleTimeS > 0 ? ca.avgCycleTimeS / nc.avgCycleTimeS : 1.0,
      throughputPenalty: nc.throughputPerHour > 0 ? ca.throughputPerHour / nc.throughputPerHour : 1.0,
    });
  }

  // Print table
  console.log("┌────────┬────────────────────────────┬────────────────────────────┬──────────────────┐");
  console.log("│  Bots  │   No-Collision (baseline)   │    Cooperative A* (CA*)     │    Penalties     │");
  console.log("│        │  Cyc(s)  Thr/hr  Util% Coll%│  Cyc(s)  Thr/hr  Util% Coll%│  Cyc×    Thr×    │");
  console.log("├────────┼────────────────────────────┼────────────────────────────┼──────────────────┤");
  for (const s of samples) {
    const nc = s.noCollision;
    const ca = s.cooperativeAStar;
    console.log(
      `│ ${String(s.botCount).padStart(4)}   │` +
      ` ${nc.avgCycleTimeS.toFixed(0).padStart(5)}  ${nc.throughputPerHour.toFixed(1).padStart(6)}  ${(nc.avgUtilization * 100).toFixed(0).padStart(4)}%  ${(nc.avgCollisionWaitPct * 100).toFixed(0).padStart(3)}% │` +
      ` ${ca.avgCycleTimeS.toFixed(0).padStart(5)}  ${ca.throughputPerHour.toFixed(1).padStart(6)}  ${(ca.avgUtilization * 100).toFixed(0).padStart(4)}%  ${(ca.avgCollisionWaitPct * 100).toFixed(0).padStart(3)}% │` +
      ` ${s.cycleTimePenalty.toFixed(3).padStart(6)} ${s.throughputPenalty.toFixed(3).padStart(6)}  │`
    );
  }
  console.log("└────────┴────────────────────────────┴────────────────────────────┴──────────────────┘");
  console.log();

  // Write JSON
  const output = {
    metadata: {
      timestamp: new Date().toISOString(),
      mapPath: opts.mapPath,
      shiftsPerSample: opts.shiftsPerSample,
      palletCountPerShift: opts.palletCount,
      totalTimeS: parseFloat(totalTime),
    },
    samples,
  };
  writeFileSync(opts.outPath, JSON.stringify(output, null, 2));
  console.log(`JSON → ${opts.outPath}`);

  // CSV
  if (opts.csvPath) {
    const headers = "bot_count,nc_cycle_s,nc_thr_hr,nc_util,nc_tasks,ca_cycle_s,ca_thr_hr,ca_util,ca_coll_pct,ca_tasks,cycle_penalty,thr_penalty";
    const rows = samples.map((s) =>
      [s.botCount, s.noCollision.avgCycleTimeS.toFixed(2), s.noCollision.throughputPerHour.toFixed(2),
        s.noCollision.avgUtilization.toFixed(4), s.noCollision.totalTasks,
        s.cooperativeAStar.avgCycleTimeS.toFixed(2), s.cooperativeAStar.throughputPerHour.toFixed(2),
        s.cooperativeAStar.avgUtilization.toFixed(4), s.cooperativeAStar.avgCollisionWaitPct.toFixed(4),
        s.cooperativeAStar.totalTasks, s.cycleTimePenalty.toFixed(4), s.throughputPenalty.toFixed(4),
      ].join(",")
    );
    writeFileSync(opts.csvPath, [headers, ...rows].join("\n"));
    console.log(`CSV → ${opts.csvPath}`);
  }
}

// ─── Entry point ───

if (cluster.isPrimary) {
  runPrimary();
} else {
  runSimWorker();
}
