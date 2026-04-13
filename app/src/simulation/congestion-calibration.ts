/**
 * Congestion calibration module.
 *
 * Runs the time-stepped engine at sampled bot counts with both
 * no-collision (free-flow) and cooperative-astar (deconflicted)
 * to measure the real congestion penalty. This penalty curve is
 * then applied to DES sweep results for accurate throughput estimates.
 *
 * Methodology:
 *   For each sampled bot count, run N shifts with both algorithms.
 *   Congestion penalty = CA* avg cycle time / no-collision avg cycle time
 *   This ratio (>= 1.0) captures how much travel + wait overhead
 *   deconfliction adds at each fleet size.
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SimConfig } from "./types";
import { createInitialState, stepSimulation } from "./engine";
import type { DESSweepPoint } from "./des-types";

// ─── Types ───

export type CalibrationSample = {
  botCount: number;
  noCollision: {
    avgCycleTimeS: number;
    throughputPerHour: number;
    avgUtilization: number;
    shiftsRun: number;
    totalTasks: number;
  };
  cooperativeAStar: {
    avgCycleTimeS: number;
    throughputPerHour: number;
    avgUtilization: number;
    avgCollisionWaitPct: number; // fraction of busy time spent waiting
    shiftsRun: number;
    totalTasks: number;
  };
  // Derived
  cycleTimePenalty: number;    // CA* cycle / no-collision cycle (>= 1.0)
  throughputPenalty: number;   // CA* throughput / no-collision throughput (<= 1.0)
};

export type CongestionCurve = {
  samples: CalibrationSample[];
  // Interpolated function: botCount → congestion multiplier on travel time
  getTravelTimeMultiplier: (botCount: number) => number;
  // Interpolated function: botCount → throughput discount factor
  getThroughputFactor: (botCount: number) => number;
};

export type CalibrationConfig = {
  sampleBotCounts: number[];   // which bot counts to measure (e.g. [2, 5, 8, 12, 16, 20])
  shiftsPerSample: number;     // how many shifts per bot count (more = more accurate)
  palletCountPerShift: number; // tasks per shift (should match DES config)
};

export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = {
  sampleBotCounts: [2, 5, 8, 12, 16, 20],
  shiftsPerSample: 5,
  palletCountPerShift: 400,
};

// ─── Core calibration runner ───

function runShiftsWithAlgorithm(
  graph: WarehouseGraph,
  baseConfig: SimConfig,
  botCount: number,
  algorithm: "no-collision" | "cooperative-astar",
  shiftsToRun: number,
): {
  avgCycleTimeS: number;
  throughputPerHour: number;
  avgUtilization: number;
  avgCollisionWaitPct: number;
  totalTasks: number;
} {
  const config: SimConfig = {
    ...baseConfig,
    botCount,
    algorithm,
  };

  let totalCycleTime = 0;
  let totalTasks = 0;
  let totalSteps = 0;
  let totalUtilSum = 0;
  let totalCollisionWaitSteps = 0;
  let totalBusySteps = 0;

  for (let shift = 0; shift < shiftsToRun; shift++) {
    let state = createInitialState(graph, config);
    let safety = 0;
    const maxSteps = config.shiftPalletCount * 500;

    while (!state.shiftDone && safety < maxSteps) {
      state = stepSimulation(graph, state, config);
      safety++;
    }

    // Collect metrics from completed tasks
    for (const task of state.completedTasks) {
      if (task.completedAtStep !== null) {
        totalCycleTime += task.completedAtStep - task.createdAtStep;
        totalTasks++;
      }
    }

    totalSteps += state.step;

    // Bot utilization and collision stats
    for (const bot of state.bots) {
      const busyPlusIdle = bot.totalBusySteps + bot.totalIdleSteps;
      if (busyPlusIdle > 0) {
        totalUtilSum += bot.totalBusySteps / busyPlusIdle;
      }
      totalCollisionWaitSteps += bot.totalCollisionWaitSteps;
      totalBusySteps += bot.totalBusySteps;
    }
  }

  const totalBotsAcrossShifts = botCount * shiftsToRun;
  const avgCycleTimeS = totalTasks > 0 ? totalCycleTime / totalTasks : 0;
  const totalHours = totalSteps / 3600;
  const throughputPerHour = totalHours > 0 ? totalTasks / totalHours : 0;
  const avgUtilization = totalBotsAcrossShifts > 0
    ? totalUtilSum / totalBotsAcrossShifts : 0;
  const avgCollisionWaitPct = totalBusySteps > 0
    ? totalCollisionWaitSteps / (totalBusySteps + totalCollisionWaitSteps) : 0;

  return {
    avgCycleTimeS,
    throughputPerHour,
    avgUtilization,
    avgCollisionWaitPct,
    totalTasks,
  };
}

// ─── Curve fitting ───

function linearInterpolate(
  samples: { x: number; y: number }[],
  x: number,
): number {
  if (samples.length === 0) return 1.0;
  if (samples.length === 1) return samples[0].y;

  // Sort by x
  const sorted = [...samples].sort((a, b) => a.x - b.x);

  // Below range: use first sample
  if (x <= sorted[0].x) return sorted[0].y;

  // Above range: extrapolate from last two points
  if (x >= sorted[sorted.length - 1].x) {
    if (sorted.length >= 2) {
      const a = sorted[sorted.length - 2];
      const b = sorted[sorted.length - 1];
      const slope = (b.y - a.y) / (b.x - a.x);
      return b.y + slope * (x - b.x);
    }
    return sorted[sorted.length - 1].y;
  }

  // Between two points: linear interpolation
  for (let i = 0; i < sorted.length - 1; i++) {
    if (x >= sorted[i].x && x <= sorted[i + 1].x) {
      const t = (x - sorted[i].x) / (sorted[i + 1].x - sorted[i].x);
      return sorted[i].y + t * (sorted[i + 1].y - sorted[i].y);
    }
  }

  return sorted[sorted.length - 1].y;
}

function buildCongestionCurve(samples: CalibrationSample[]): CongestionCurve {
  const travelTimePoints = samples.map((s) => ({
    x: s.botCount,
    y: s.cycleTimePenalty,
  }));

  const throughputPoints = samples.map((s) => ({
    x: s.botCount,
    y: s.throughputPenalty,
  }));

  return {
    samples,
    getTravelTimeMultiplier: (botCount: number) =>
      Math.max(1.0, linearInterpolate(travelTimePoints, botCount)),
    getThroughputFactor: (botCount: number) =>
      Math.min(1.0, linearInterpolate(throughputPoints, botCount)),
  };
}

// ─── Public API ───

/**
 * Run congestion calibration at the specified bot counts.
 *
 * This is SLOW — it runs the full time-stepped engine with CA* for
 * each sample point. Use async yielding so the UI stays responsive.
 */
export async function runCongestionCalibration(
  graph: WarehouseGraph,
  baseConfig: SimConfig,
  calibConfig: CalibrationConfig,
  onProgress?: (completed: number, total: number, sample?: CalibrationSample) => void,
): Promise<CongestionCurve> {
  const samples: CalibrationSample[] = [];
  const total = calibConfig.sampleBotCounts.length * 2; // 2 algorithms per bot count
  let completed = 0;

  for (const botCount of calibConfig.sampleBotCounts) {
    // Run no-collision baseline
    const noCollision = runShiftsWithAlgorithm(
      graph,
      { ...baseConfig, shiftPalletCount: calibConfig.palletCountPerShift },
      botCount,
      "no-collision",
      calibConfig.shiftsPerSample,
    );
    completed++;
    onProgress?.(completed, total);
    await new Promise((r) => setTimeout(r, 0));

    // Run CA*
    const castar = runShiftsWithAlgorithm(
      graph,
      { ...baseConfig, shiftPalletCount: calibConfig.palletCountPerShift },
      botCount,
      "cooperative-astar",
      calibConfig.shiftsPerSample,
    );
    completed++;

    // Compute penalties
    const cycleTimePenalty = noCollision.avgCycleTimeS > 0
      ? castar.avgCycleTimeS / noCollision.avgCycleTimeS
      : 1.0;
    const throughputPenalty = noCollision.throughputPerHour > 0
      ? castar.throughputPerHour / noCollision.throughputPerHour
      : 1.0;

    const sample: CalibrationSample = {
      botCount,
      noCollision: {
        ...noCollision,
        shiftsRun: calibConfig.shiftsPerSample,
      },
      cooperativeAStar: {
        ...castar,
        shiftsRun: calibConfig.shiftsPerSample,
      },
      cycleTimePenalty,
      throughputPenalty,
    };

    samples.push(sample);
    onProgress?.(completed, total, sample);
    await new Promise((r) => setTimeout(r, 0));
  }

  return buildCongestionCurve(samples);
}

/**
 * Apply a congestion curve to DES sweep results.
 *
 * Adjusts throughput downward and cycle times upward based on the
 * measured congestion penalties at each bot count.
 */
export function applyCongestionCurve(
  sweepResults: DESSweepPoint[],
  curve: CongestionCurve,
): DESSweepPoint[] {
  return sweepResults.map((point) => {
    const travelMult = curve.getTravelTimeMultiplier(point.botCount);
    const throughputFactor = curve.getThroughputFactor(point.botCount);

    return {
      ...point,
      // Adjust throughput down by the throughput factor
      avgThroughputPerHour: point.avgThroughputPerHour * throughputFactor,
      // Adjust cycle times up by the travel time multiplier
      avgCycleTimeS: point.avgCycleTimeS * travelMult,
      p95CycleTimeS: point.p95CycleTimeS * travelMult,
      // Queue waits increase with congestion
      avgBotQueueWaitS: point.avgBotQueueWaitS * travelMult,
      maxBotQueueWaitS: point.maxBotQueueWaitS * travelMult,
      p95BotQueueWaitS: point.p95BotQueueWaitS * travelMult,
      // Shift results adjusted too
      shiftResults: point.shiftResults.map((sr) => ({
        ...sr,
        throughputPerHour: sr.throughputPerHour * throughputFactor,
        avgCycleTimeS: sr.avgCycleTimeS * travelMult,
        p95CycleTimeS: sr.p95CycleTimeS * travelMult,
      })),
      // Pallet count adjusted
      totalPalletsProcessed: Math.round(point.totalPalletsProcessed * throughputFactor),
    };
  });
}

/**
 * Export calibration samples as CSV for analysis.
 */
export function calibrationToCSV(samples: CalibrationSample[]): string {
  const headers = [
    "bot_count",
    "nc_avg_cycle_time_s",
    "nc_throughput_per_hr",
    "nc_avg_util",
    "nc_total_tasks",
    "ca_avg_cycle_time_s",
    "ca_throughput_per_hr",
    "ca_avg_util",
    "ca_collision_wait_pct",
    "ca_total_tasks",
    "cycle_time_penalty",
    "throughput_penalty",
  ];

  const rows = samples.map((s) =>
    [
      s.botCount,
      s.noCollision.avgCycleTimeS.toFixed(2),
      s.noCollision.throughputPerHour.toFixed(2),
      s.noCollision.avgUtilization.toFixed(4),
      s.noCollision.totalTasks,
      s.cooperativeAStar.avgCycleTimeS.toFixed(2),
      s.cooperativeAStar.throughputPerHour.toFixed(2),
      s.cooperativeAStar.avgUtilization.toFixed(4),
      s.cooperativeAStar.avgCollisionWaitPct.toFixed(4),
      s.cooperativeAStar.totalTasks,
      s.cycleTimePenalty.toFixed(4),
      s.throughputPenalty.toFixed(4),
    ].join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}
