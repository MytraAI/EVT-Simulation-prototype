/**
 * Bot-count sweep orchestrator for DES evaluation.
 *
 * Runs the DES engine across a range of bot counts, collecting
 * throughput and utilization metrics at each point. Uses setTimeout
 * yielding to keep the UI responsive during long sweeps.
 */

import type { WarehouseGraph } from "../graph/loader";
import type { SimConfig } from "./types";
import type {
  DESConfig,
  DESShiftResult,
  DESSweepPoint,
  PickTimeDistribution,
} from "./des-types";
import { runDESShift } from "./des-engine";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function aggregateShiftResults(
  botCount: number,
  results: DESShiftResult[],
): DESSweepPoint {
  const n = results.length;
  if (n === 0) {
    return {
      botCount,
      shiftResults: [],
      avgThroughputPerHour: 0,
      avgBotUtilPct: 0,
      avgStationUtilPct: 0,
      avgCycleTimeS: 0,
      p95CycleTimeS: 0,
      avgBotQueueWaitS: 0,
      maxBotQueueWaitS: 0,
      p95BotQueueWaitS: 0,
      avgStationQueueWaitS: 0,
      maxStationQueueWaitS: 0,
      totalPalletsProcessed: 0,
    };
  }

  const allCycleTimes = results.flatMap((r) => r.cycleTimes).sort((a, b) => a - b);
  const allBotQueueWaits = results.map((r) => r.avgBotQueueWaitS).filter((v) => v > 0);

  return {
    botCount,
    shiftResults: results,
    avgThroughputPerHour:
      results.reduce((s, r) => s + r.throughputPerHour, 0) / n,
    avgBotUtilPct:
      results.reduce((s, r) => s + r.botUtilPct, 0) / n,
    avgStationUtilPct:
      results.reduce((s, r) => s + r.stationUtilPct, 0) / n,
    avgCycleTimeS:
      allCycleTimes.length > 0
        ? allCycleTimes.reduce((s, v) => s + v, 0) / allCycleTimes.length
        : 0,
    p95CycleTimeS: percentile(allCycleTimes, 0.95),
    avgBotQueueWaitS:
      results.reduce((s, r) => s + r.avgBotQueueWaitS, 0) / n,
    maxBotQueueWaitS: Math.max(...results.map((r) => r.maxBotQueueWaitS)),
    p95BotQueueWaitS: percentile(
      allBotQueueWaits.sort((a, b) => a - b),
      0.95,
    ),
    avgStationQueueWaitS:
      results.reduce((s, r) => s + r.avgStationQueueWaitS, 0) / n,
    maxStationQueueWaitS: Math.max(
      ...results.map((r) => r.maxStationQueueWaitS),
    ),
    totalPalletsProcessed: results.reduce((s, r) => s + r.tasksCompleted, 0),
  };
}

/**
 * Run a bot-count sweep across the configured range.
 *
 * Yields to the event loop between shifts to keep the UI responsive.
 * Reports progress via onProgress callback.
 */
export async function runBotCountSweep(
  graph: WarehouseGraph,
  simConfig: SimConfig,
  desConfig: DESConfig,
  pickDist: PickTimeDistribution | null = null,
  onProgress?: (completed: number, total: number, latestPoint?: DESSweepPoint) => void,
): Promise<DESSweepPoint[]> {
  const { sweepMinBots, sweepMaxBots, sweepStepBots, sweepShiftsPerPoint } = desConfig;

  const botCounts: number[] = [];
  for (let bc = sweepMinBots; bc <= sweepMaxBots; bc += sweepStepBots) {
    botCounts.push(bc);
  }

  const totalRuns = botCounts.length * sweepShiftsPerPoint;
  let completedRuns = 0;
  const sweepResults: DESSweepPoint[] = [];

  for (const botCount of botCounts) {
    const shiftResults: DESShiftResult[] = [];
    const configForCount = { ...simConfig, botCount };

    for (let shift = 0; shift < sweepShiftsPerPoint; shift++) {
      const result = runDESShift(
        graph,
        configForCount,
        desConfig,
        pickDist,
        shift,
      );
      shiftResults.push(result);
      completedRuns++;

      // Yield to event loop
      await new Promise((r) => setTimeout(r, 0));

      onProgress?.(completedRuns, totalRuns);
    }

    const point = aggregateShiftResults(botCount, shiftResults);
    sweepResults.push(point);
    onProgress?.(completedRuns, totalRuns, point);
  }

  return sweepResults;
}

/**
 * Export sweep results as CSV string.
 */
export function sweepResultsToCSV(results: DESSweepPoint[]): string {
  const headers = [
    "bot_count",
    "avg_throughput_per_hr",
    "avg_bot_util_pct",
    "avg_station_util_pct",
    "avg_cycle_time_s",
    "p95_cycle_time_s",
    "avg_bot_queue_wait_s",
    "max_bot_queue_wait_s",
    "p95_bot_queue_wait_s",
    "avg_station_queue_wait_s",
    "max_station_queue_wait_s",
    "total_pallets_processed",
  ];

  const rows = results.map((r) =>
    [
      r.botCount,
      r.avgThroughputPerHour.toFixed(2),
      r.avgBotUtilPct.toFixed(2),
      r.avgStationUtilPct.toFixed(2),
      r.avgCycleTimeS.toFixed(2),
      r.p95CycleTimeS.toFixed(2),
      r.avgBotQueueWaitS.toFixed(2),
      r.maxBotQueueWaitS.toFixed(2),
      r.p95BotQueueWaitS.toFixed(2),
      r.avgStationQueueWaitS.toFixed(2),
      r.maxStationQueueWaitS.toFixed(2),
      r.totalPalletsProcessed,
    ].join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Trigger a file download in the browser.
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
