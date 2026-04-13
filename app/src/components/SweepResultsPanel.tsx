import { useStore } from "../store";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { sweepResultsToCSV, downloadFile } from "../simulation/des-sweep";

export function SweepResultsPanel({ height }: { height: number }) {
  const sweepResults = useStore((s) => s.sweepResults);
  const setSweepResults = useStore((s) => s.setSweepResults);
  const congestionCurve = useStore((s) => s.congestionCurve);

  if (!sweepResults || sweepResults.length === 0) return null;

  const chartData = sweepResults.map((r) => ({
    bots: r.botCount,
    throughput: Number(r.avgThroughputPerHour.toFixed(1)),
    botUtil: Number(r.avgBotUtilPct.toFixed(1)),
    stationUtil: Number(r.avgStationUtilPct.toFixed(1)),
    cycleAvg: Number(r.avgCycleTimeS.toFixed(1)),
    cycleP95: Number(r.p95CycleTimeS.toFixed(1)),
    botQueueWait: Number(r.avgBotQueueWaitS.toFixed(1)),
    stationQueueWait: Number(r.avgStationQueueWaitS.toFixed(1)),
  }));

  const handleExportCSV = () => {
    const csv = sweepResultsToCSV(sweepResults);
    downloadFile(csv, "des-sweep-results.csv", "text/csv");
  };

  const handleExportJSON = () => {
    const json = JSON.stringify(sweepResults, null, 2);
    downloadFile(json, "des-sweep-results.json", "application/json");
  };

  return (
    <div
      className="border-t border-gray-700 bg-gray-900 overflow-y-auto"
      style={{ height }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-emerald-400">
            DES Sweep Results
          </h2>
          {congestionCurve && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 border border-amber-600/30">
              CA* congestion-calibrated
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
            onClick={handleExportCSV}
          >
            Export CSV
          </button>
          <button
            className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
            onClick={handleExportJSON}
          >
            Export JSON
          </button>
          <button
            className="text-xs px-2 py-1 rounded bg-gray-700 text-red-400 hover:bg-gray-600"
            onClick={() => setSweepResults(null)}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-2 gap-4 p-4">
        {/* Throughput vs Bot Count */}
        <div>
          <h3 className="text-xs text-gray-400 mb-1">Throughput vs Bot Count</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="bots"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                label={{ value: "Bots", position: "insideBottom", offset: -2, fontSize: 10, fill: "#9ca3af" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", fontSize: 11 }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Line
                type="monotone"
                dataKey="throughput"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Pallets/hr"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Utilization vs Bot Count */}
        <div>
          <h3 className="text-xs text-gray-400 mb-1">Utilization vs Bot Count</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="bots"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                label={{ value: "Bots", position: "insideBottom", offset: -2, fontSize: 10, fill: "#9ca3af" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} unit="%" />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", fontSize: 11 }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line
                type="monotone"
                dataKey="botUtil"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Bot Util %"
              />
              <Line
                type="monotone"
                dataKey="stationUtil"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Station Util %"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Cycle Time vs Bot Count */}
        <div>
          <h3 className="text-xs text-gray-400 mb-1">Cycle Time vs Bot Count</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="bots"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                label={{ value: "Bots", position: "insideBottom", offset: -2, fontSize: 10, fill: "#9ca3af" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} unit="s" />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", fontSize: 11 }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line
                type="monotone"
                dataKey="cycleAvg"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Avg Cycle Time"
              />
              <Line
                type="monotone"
                dataKey="cycleP95"
                stroke="#ec4899"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={{ r: 3 }}
                name="P95 Cycle Time"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Queue Wait Times vs Bot Count */}
        <div>
          <h3 className="text-xs text-gray-400 mb-1">Queue Wait vs Bot Count</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="bots"
                tick={{ fontSize: 10, fill: "#9ca3af" }}
                label={{ value: "Bots", position: "insideBottom", offset: -2, fontSize: 10, fill: "#9ca3af" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} unit="s" />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", fontSize: 11 }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line
                type="monotone"
                dataKey="botQueueWait"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Bot Queue Wait"
              />
              <Line
                type="monotone"
                dataKey="stationQueueWait"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Station Queue Wait"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Summary table */}
      <div className="px-4 pb-4">
        <h3 className="text-xs text-gray-400 mb-1">Summary</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-1 px-2">Bots</th>
                <th className="text-right py-1 px-2">Throughput/hr</th>
                <th className="text-right py-1 px-2">Bot Util%</th>
                <th className="text-right py-1 px-2">Stn Util%</th>
                <th className="text-right py-1 px-2">Avg Cycle</th>
                <th className="text-right py-1 px-2">P95 Cycle</th>
                <th className="text-right py-1 px-2">Pallets</th>
              </tr>
            </thead>
            <tbody>
              {sweepResults.map((r) => (
                <tr key={r.botCount} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="py-1 px-2 font-mono">{r.botCount}</td>
                  <td className="text-right py-1 px-2 font-mono">{r.avgThroughputPerHour.toFixed(1)}</td>
                  <td className="text-right py-1 px-2 font-mono">{r.avgBotUtilPct.toFixed(1)}</td>
                  <td className="text-right py-1 px-2 font-mono">{r.avgStationUtilPct.toFixed(1)}</td>
                  <td className="text-right py-1 px-2 font-mono">{r.avgCycleTimeS.toFixed(1)}s</td>
                  <td className="text-right py-1 px-2 font-mono">{r.p95CycleTimeS.toFixed(1)}s</td>
                  <td className="text-right py-1 px-2 font-mono">{r.totalPalletsProcessed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
