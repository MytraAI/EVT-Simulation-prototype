import { useMemo } from "react";
import { useStore } from "../store";
import { computeHealthMetrics } from "../metrics/health";
import { buildLevelMaxMass, computeBalanceMetrics } from "../simulation/position-selector";

type Props = {
  height: number;
};

export function MetricsPanel({ height }: Props) {
  const simState = useStore((s) => s.simState);
  const graph = useStore((s) => s.graph);

  const health = useMemo(() => {
    if (!graph || !simState) return null;
    return computeHealthMetrics(graph, simState);
  }, [graph, simState]);

  const completedCount = simState?.completedTasks.length ?? 0;
  const step = simState?.step ?? 0;
  const bots = simState?.bots ?? [];
  const palletCount = simState?.pallets.size ?? 0;

  // Total pallet positions in graph
  const totalPositions = useMemo(() => {
    if (!graph) return 0;
    return graph.data.nodes.filter((n) => n.kind === "PALLET_POSITION").length;
  }, [graph]);

  const avgUtilization =
    bots.length > 0
      ? bots.reduce(
          (sum, b) =>
            sum + b.totalBusySteps / Math.max(1, b.totalBusySteps + b.totalIdleSteps),
          0,
        ) / bots.length
      : 0;

  const shiftDone = simState?.shiftDone ?? false;

  // Shift results
  const shiftInductions = simState?.completedTasks.filter((t) => t.type === "INDUCTION").length ?? 0;
  const shiftRetrievals = simState?.completedTasks.filter((t) => t.type === "RETRIEVAL").length ?? 0;
  const evalResults = simState?.evalResults ?? [];
  const shiftProgress = simState
    ? `${completedCount} / ${simState.shiftTasksGenerated}`
    : "—";

  // Time: each tick = 0.5s at 1x (matches 500ms interval). Use step count as sim-seconds.
  const shiftTimeS = step;
  const shiftTimeMin = (shiftTimeS / 60).toFixed(1);
  const shiftTimeHr = shiftTimeS / 3600;

  // Pallets/hr = total completed / shift time in hours (only meaningful when done)
  const palletsPerHour = shiftDone && shiftTimeHr > 0
    ? (completedCount / shiftTimeHr).toFixed(1)
    : "—";

  // Balance metrics
  const balance = useMemo(() => {
    if (!graph || !simState) return null;
    const levelMaxMass = buildLevelMaxMass(graph);
    return computeBalanceMetrics(graph, simState, levelMaxMass);
  }, [graph, simState]);

  // SKU distribution
  const skuDistribution = useMemo(() => {
    if (!simState) return [];
    const counts = new Map<string, number>();
    for (const [, pallet] of simState.pallets) {
      counts.set(pallet.sku, (counts.get(pallet.sku) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([sku, count]) => {
        const info = simState.skuCatalog.find((s) => s.sku === sku);
        return {
          sku,
          count,
          color: info?.color ?? "#888",
          velocity: info?.velocity ?? "medium",
          weightKg: info?.weightKg ?? 0,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [simState]);

  // Pending/active tasks
  const pendingTasks = simState?.tasks.filter((t) => t.assignedBotId === null).length ?? 0;
  const activeTasks = simState?.tasks.filter((t) => t.assignedBotId !== null).length ?? 0;

  // Recent events (last 10)
  const recentEvents = useMemo(() => {
    if (!simState) return [];
    return simState.eventLog.slice(-10).reverse();
  }, [simState]);

  return (
    <div
      className="bg-gray-800 border-t border-gray-700 overflow-y-auto flex flex-col"
      style={{ height }}
    >
      <div className="px-4 py-2 border-b border-gray-700 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">
          Metrics & Activity
        </h3>
        <span className="text-xs text-gray-500">Step {step}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Top stats row */}
        {/* Shift results box */}
        {shiftDone && (
          <div className="mx-4 mt-2 mb-1 p-3 bg-green-900/20 border border-green-700/40 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-green-400">
                {evalResults.length > 0 ? "EVAL COMPLETE" : "SHIFT COMPLETE"}
              </span>
              <span className="text-[10px] text-gray-500">{shiftTimeMin} min ({step} ticks)</span>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <div className="text-[10px] text-gray-500">Pallets/hr</div>
                <div className="text-sm font-bold text-cyan-400 tabular-nums">{palletsPerHour}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Inducted</div>
                <div className="text-sm font-bold text-blue-400 tabular-nums">{shiftInductions}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Retrieved</div>
                <div className="text-sm font-bold text-amber-400 tabular-nums">{shiftRetrievals}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Total</div>
                <div className="text-sm font-bold text-gray-200 tabular-nums">{completedCount}</div>
              </div>
            </div>

            {/* Multi-shift eval results */}
            {evalResults.length > 0 && (
              <div className="mt-3 border-t border-green-700/30 pt-2">
                <div className="text-[10px] text-gray-500 mb-1 font-semibold">
                  {evalResults.length}-Shift Eval Results
                </div>
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="text-left font-medium pr-2">#</th>
                      <th className="text-right font-medium pr-2">P/hr</th>
                      <th className="text-right font-medium pr-2">In</th>
                      <th className="text-right font-medium pr-2">Out</th>
                      <th className="text-right font-medium pr-2">Time</th>
                      <th className="text-right font-medium">Util%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evalResults.map((r) => (
                      <tr key={r.shiftIndex} className="text-gray-400">
                        <td className="pr-2">{r.shiftIndex + 1}</td>
                        <td className="text-right pr-2 text-cyan-400 font-medium tabular-nums">
                          {r.palletsPerHour.toFixed(1)}
                        </td>
                        <td className="text-right pr-2 tabular-nums">{r.inductions}</td>
                        <td className="text-right pr-2 tabular-nums">{r.retrievals}</td>
                        <td className="text-right pr-2 tabular-nums">
                          {(r.steps / 60).toFixed(1)}m
                        </td>
                        <td className="text-right tabular-nums">
                          {(r.avgBotUtilization * 100).toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-gray-300 border-t border-gray-700">
                      <td className="pr-2 font-semibold">Avg</td>
                      <td className="text-right pr-2 text-cyan-300 font-bold tabular-nums">
                        {(evalResults.reduce((s, r) => s + r.palletsPerHour, 0) / evalResults.length).toFixed(1)}
                      </td>
                      <td className="text-right pr-2 tabular-nums">
                        {Math.round(evalResults.reduce((s, r) => s + r.inductions, 0) / evalResults.length)}
                      </td>
                      <td className="text-right pr-2 tabular-nums">
                        {Math.round(evalResults.reduce((s, r) => s + r.retrievals, 0) / evalResults.length)}
                      </td>
                      <td className="text-right pr-2 tabular-nums">
                        {(evalResults.reduce((s, r) => s + r.steps, 0) / evalResults.length / 60).toFixed(1)}m
                      </td>
                      <td className="text-right tabular-nums">
                        {(evalResults.reduce((s, r) => s + r.avgBotUtilization, 0) / evalResults.length * 100).toFixed(0)}%
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2 px-4 py-2">
          <StatCard
            label="Shift"
            value={shiftDone ? "DONE" : shiftProgress}
            accent={shiftDone ? "green" : "cyan"}
          />
          <StatCard label="Time" value={`${shiftTimeMin}m`} />
          <StatCard label="In" value={shiftInductions} accent="cyan" />
          <StatCard label="Out" value={shiftRetrievals} accent="cyan" />
          <StatCard label="Pallets" value={`${palletCount} / ${totalPositions}`} />
          <StatCard
            label="Fill Rate"
            value={`${totalPositions > 0 ? ((palletCount / totalPositions) * 100).toFixed(1) : 0}%`}
          />
          <StatCard
            label="Bot Util."
            value={`${(avgUtilization * 100).toFixed(0)}%`}
            accent={avgUtilization > 0.7 ? "green" : avgUtilization > 0.3 ? "yellow" : "red"}
          />
          <StatCard label="Pending" value={pendingTasks} accent={pendingTasks > 5 ? "red" : undefined} />
          <StatCard label="Active" value={activeTasks} accent="green" />
          {balance && (
            <>
              <StatCard
                label="Wt-Level"
                value={`${(balance.weightLevelScore * 100).toFixed(0)}%`}
                accent={balance.weightLevelScore > 0.8 ? "green" : "yellow"}
              />
              <StatCard
                label="Radial Bal."
                value={`${((1 - balance.radialImbalance) * 100).toFixed(0)}%`}
                accent={balance.radialImbalance < 0.15 ? "green" : balance.radialImbalance < 0.3 ? "yellow" : "red"}
              />
            </>
          )}
        </div>

        <div className="flex gap-4 px-4 pb-2">
          {/* Weight distribution per level */}
          {balance && (
            <div className="w-52 shrink-0">
              <h4 className="text-xs text-gray-500 font-semibold mb-1">
                Level Weight Distribution
              </h4>
              <div className="space-y-1">
                {balance.levelWeights.map((lw) => (
                  <div key={lw.level} className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 w-8">L{lw.level}</span>
                    <div className="flex-1 h-3 bg-gray-700 rounded overflow-hidden">
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${lw.fillPct * 100}%`,
                          backgroundColor: lw.fillPct > 0.8 ? "#ef4444" : lw.fillPct > 0.5 ? "#eab308" : "#22c55e",
                        }}
                      />
                    </div>
                    <span className="text-gray-500 tabular-nums w-20 text-right">
                      {Math.round(lw.weightKg)}kg/{Math.round(lw.maxPerPositionKg)}
                    </span>
                    <span className="text-gray-500 tabular-nums w-8 text-right">
                      {lw.count}
                    </span>
                    <span className="text-gray-600 tabular-nums w-10 text-right">
                      {(lw.fillPct * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
              {/* Radial balance */}
              <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-gray-500">
                <div>L: {Math.round(balance.leftWeight)}kg</div>
                <div>R: {Math.round(balance.rightWeight)}kg</div>
                <div>F: {Math.round(balance.frontWeight)}kg</div>
                <div>B: {Math.round(balance.backWeight)}kg</div>
              </div>
            </div>
          )}

          {/* Event log */}
          <div className="flex-1 min-w-0">
            <h4 className="text-xs text-gray-500 font-semibold mb-1">Recent Orders</h4>
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {recentEvents.length === 0 && (
                <p className="text-xs text-gray-600">No events yet</p>
              )}
              {recentEvents.map((ev, i) => (
                <div
                  key={`${ev.step}-${ev.botId}-${i}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="text-gray-600 tabular-nums w-12">
                    t={ev.step}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      ev.type === "INDUCTION"
                        ? "bg-blue-900/50 text-blue-300"
                        : "bg-amber-900/50 text-amber-300"
                    }`}
                  >
                    {ev.type === "INDUCTION" ? "IN" : "OUT"}
                  </span>
                  <span
                    className={`font-medium ${
                      ev.status === "completed" ? "text-green-400" : "text-gray-400"
                    }`}
                  >
                    {ev.sku}
                  </span>
                  <span className="text-gray-600">Bot {ev.botId}</span>
                  <span className="text-gray-600 truncate">
                    {ev.status === "completed" ? "done" : "→ " + ev.positionId}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* SKU distribution */}
          <div className="w-48 shrink-0">
            <h4 className="text-xs text-gray-500 font-semibold mb-1">
              SKU Distribution ({skuDistribution.length} SKUs)
            </h4>
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {skuDistribution.slice(0, 10).map((s) => (
                <div key={s.sku} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span
                    className={`text-[9px] px-1 rounded font-medium ${
                      s.velocity === "high"
                        ? "bg-red-900/60 text-red-300"
                        : s.velocity === "medium"
                          ? "bg-yellow-900/60 text-yellow-300"
                          : "bg-blue-900/60 text-blue-300"
                    }`}
                  >
                    {s.velocity[0].toUpperCase()}
                  </span>
                  <span className="text-gray-400 truncate flex-1">{s.sku}</span>
                  <span className="text-gray-600 tabular-nums text-[10px]">
                    {Math.round(s.weightKg)}kg
                  </span>
                  <span className="text-gray-500 tabular-nums">{s.count}</span>
                </div>
              ))}
              {skuDistribution.length > 10 && (
                <p className="text-[10px] text-gray-600">
                  +{skuDistribution.length - 10} more
                </p>
              )}
            </div>
          </div>

          {/* Active bot tasks */}
          <div className="w-56 shrink-0">
            <h4 className="text-xs text-gray-500 font-semibold mb-1">Bot Status</h4>
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {bots.map((bot) => (
                <div key={bot.id} className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400 w-10">Bot {bot.id}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      bot.state === "IDLE"
                        ? "bg-gray-700 text-gray-400"
                        : bot.state.startsWith("TRAVELING")
                          ? "bg-cyan-900/50 text-cyan-300"
                          : "bg-purple-900/50 text-purple-300"
                    }`}
                  >
                    {bot.state.replace(/_/g, " ").toLowerCase()}
                  </span>
                  {bot.task && (
                    <span className="text-gray-600 truncate">
                      {bot.task.sku}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type Accent = "cyan" | "green" | "yellow" | "red" | undefined;

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: Accent;
}) {
  const accentClass =
    accent === "cyan"
      ? "text-cyan-400"
      : accent === "green"
        ? "text-green-400"
        : accent === "yellow"
          ? "text-yellow-400"
          : accent === "red"
            ? "text-red-400"
            : "text-gray-200";

  return (
    <div className="bg-gray-900/50 rounded px-2 py-1.5">
      <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
      <div className={`text-xs font-medium tabular-nums ${accentClass}`}>
        {value}
      </div>
    </div>
  );
}
