import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { loadGraphFromFile } from "../graph/loader";
import type { GraphData } from "../graph/types";
import type { SimConfig } from "../simulation/types";
import type { DESConfig } from "../simulation/des-types";
import { initWasm, loadGraphIntoWasm } from "../simulation/wasm-bridge";
import { createInitialState, runMultiShiftEval } from "../simulation/engine";
import { runBotCountSweep } from "../simulation/des-sweep";
import { loadPickTimeDistribution } from "../simulation/pick-time-dist";
import { runCongestionCalibration, applyCongestionCurve } from "../simulation/congestion-calibration";

const BUILT_IN_MAPS = [
  { name: "Grainger Pilot", path: "/grainger-pilot-04102026-graph.json" },
  { name: "EVT 3/31", path: "/EVT_3_31_21.json" },
];

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
};

function Slider({ label, value, min, max, step, unit, onChange }: SliderProps) {
  return (
    <label className="block mb-2">
      <span className="text-xs text-gray-400">{label}</span>
      <div className="flex items-center gap-2 mt-0.5">
        <input
          type="number"
          className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:border-cyan-500 focus:outline-none tabular-nums"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
        />
        {unit && <span className="text-[10px] text-gray-500 shrink-0">{unit}</span>}
      </div>
    </label>
  );
}

export function ConfigPanel() {
  const setGraphData = useStore((s) => s.setGraphData);
  const config = useStore((s) => s.config);
  const updateConfig = useStore((s) => s.updateConfig);
  const graph = useStore((s) => s.graph);
  const fileRef = useRef<HTMLInputElement>(null);
  const [activeMap, setActiveMap] = useState("Grainger Pilot");

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const data = await loadGraphFromFile(file);
        setGraphData(data);
        setActiveMap(file.name);
      } catch (e) {
        console.error("Failed to load map JSON:", e);
      }
    },
    [setGraphData],
  );

  const loadBuiltInMap = useCallback(
    async (name: string, path: string) => {
      try {
        const resp = await fetch(path);
        const data: GraphData = await resp.json();
        setGraphData(data);
        setActiveMap(name);
      } catch (e) {
        console.error("Failed to load map:", e);
      }
    },
    [setGraphData],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const setSimState = useStore((s) => s.setSimState);
  const setPlaying = useStore((s) => s.setPlaying);
  const graphData = useStore((s) => s.graphData);

  // DES config
  const desConfig = useStore((s) => s.desConfig);
  const updateDESConfig = useStore((s) => s.updateDESConfig);
  const sweepRunning = useStore((s) => s.sweepRunning);
  const setSweepRunning = useStore((s) => s.setSweepRunning);
  const setSweepResults = useStore((s) => s.setSweepResults);
  const setSweepProgress = useStore((s) => s.setSweepProgress);
  const sweepProgress = useStore((s) => s.sweepProgress);
  const pickTimeDist = useStore((s) => s.pickTimeDist);
  const setPickTimeDist = useStore((s) => s.setPickTimeDist);
  const pickDistRef = useRef<HTMLInputElement>(null);

  // Congestion calibration
  const calibConfig = useStore((s) => s.calibConfig);
  const updateCalibConfig = useStore((s) => s.updateCalibConfig);
  const congestionCurve = useStore((s) => s.congestionCurve);
  const setCongestionCurve = useStore((s) => s.setCongestionCurve);
  const calibRunning = useStore((s) => s.calibRunning);
  const setCalibRunning = useStore((s) => s.setCalibRunning);
  const calibProgress = useStore((s) => s.calibProgress);
  const setCalibProgress = useStore((s) => s.setCalibProgress);
  const setCalibSamples = useStore((s) => s.setCalibSamples);

  const set = (key: keyof SimConfig) => (v: number) =>
    updateConfig({ [key]: v });

  const setDES = (key: keyof DESConfig) => (v: number) =>
    updateDESConfig({ [key]: v });

  const handleApplyReset = useCallback(async () => {
    if (!graph || !graphData) return;
    setPlaying(false);
    try {
      await initWasm();
      loadGraphIntoWasm(graphData, config);
      const initial = createInitialState(graph, config);
      setSimState(initial);
    } catch (e) {
      console.error("Failed to reset simulation:", e);
    }
  }, [graph, graphData, config, setSimState, setPlaying]);

  return (
    <div className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="p-3 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold text-cyan-400 tracking-wide">
            EVT WAREHOUSE SIM
          </h1>
          <a
            href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 text-[10px] rounded bg-purple-600/30 text-purple-300 hover:bg-purple-500 hover:text-white transition-colors cursor-pointer animate-pulse"
          >
            click me
          </a>
        </div>
      </div>

      {/* Map loading */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Active Volume
        </h2>
        {/* Built-in maps */}
        <div className="flex flex-col gap-1 mb-2">
          {BUILT_IN_MAPS.map((m) => (
            <button
              key={m.path}
              className={`text-left text-xs px-2 py-1.5 rounded transition-colors ${
                activeMap === m.name
                  ? "bg-cyan-600/30 text-cyan-300 border border-cyan-600/50"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
              onClick={() => loadBuiltInMap(m.name, m.path)}
            >
              {m.name}
            </button>
          ))}
        </div>
        <div
          className="border-2 border-dashed border-gray-600 rounded p-4 text-center cursor-pointer hover:border-cyan-500 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <p className="text-xs text-gray-400">
            Drop JSON or click to upload
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
        {graph && (
          <div className="mt-2 text-xs text-gray-500">
            {graph.data.nodes.length} nodes, {graph.data.edges.length} edges,{" "}
            {graph.levels.length} level{graph.levels.length > 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Bot parameters */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Bots
        </h2>
        <Slider
          label="Bot count"
          value={config.botCount}
          min={1}
          max={50}
          step={1}
          onChange={set("botCount")}
        />
        <label className="block mb-2">
          <span className="text-xs text-gray-400">Algorithm</span>
          <select
            className="w-full mt-0.5 bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600"
            value={config.algorithm}
            onChange={(e) => updateConfig({ algorithm: e.target.value as any })}
          >
            <option value="no-collision">No Collision (baseline estimate)</option>
            <option value="soft-collision">Soft Collision (wait then phase through)</option>
            <option value="cooperative-astar">Cooperative A* (basic MAPF)</option>
            <option value="strict">Strict (requires Director)</option>
          </select>
        </label>
        {config.algorithm === "soft-collision" && (
          <Slider
            label="Max collision wait"
            value={config.softCollisionWaitTicks}
            min={1}
            max={30}
            step={1}
            unit=" ticks"
            onChange={set("softCollisionWaitTicks")}
          />
        )}
      </div>

      {/* Station & Position times */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Operation Times
        </h2>
        <Slider
          label="Station pick (load onto bot)"
          value={config.stationPickTimeS}
          min={1}
          max={30}
          step={1}
          unit="s"
          onChange={set("stationPickTimeS")}
        />
        <Slider
          label="Station drop (unload from bot)"
          value={config.stationDropTimeS}
          min={1}
          max={30}
          step={1}
          unit="s"
          onChange={set("stationDropTimeS")}
        />
        <Slider
          label="Position pick (bot picks from rack)"
          value={config.positionPickTimeS}
          min={1}
          max={30}
          step={1}
          unit="s"
          onChange={set("positionPickTimeS")}
        />
        <Slider
          label="Position drop (bot places in rack)"
          value={config.positionDropTimeS}
          min={1}
          max={30}
          step={1}
          unit="s"
          onChange={set("positionDropTimeS")}
        />
      </div>

      {/* Travel speeds */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Travel
        </h2>
        <Slider
          label="XY speed"
          value={config.botSpeedMps}
          min={0.1}
          max={5}
          step={0.1}
          unit=" m/s"
          onChange={set("botSpeedMps")}
        />
        <Slider
          label="Z-up speed"
          value={config.zUpSpeedMps}
          min={0.01}
          max={2}
          step={0.01}
          unit=" m/s"
          onChange={set("zUpSpeedMps")}
        />
        <Slider
          label="Z-down speed"
          value={config.zDownSpeedMps}
          min={0.01}
          max={2}
          step={0.01}
          unit=" m/s"
          onChange={set("zDownSpeedMps")}
        />
        <Slider
          label="XY turn time"
          value={config.xyTurnTimeS}
          min={0}
          max={10}
          step={0.5}
          unit=" s"
          onChange={set("xyTurnTimeS")}
        />
        <Slider
          label="XY↔Z transition time"
          value={config.xyzTransitionTimeS}
          min={0}
          max={10}
          step={0.5}
          unit=" s"
          onChange={set("xyzTransitionTimeS")}
        />
      </div>

      {/* Shift config */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Shift
        </h2>
        <label className="block mb-3">
          <span className="text-xs text-gray-400">Mode</span>
          <select
            className="w-full mt-1 bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600"
            value={config.shiftMode}
            onChange={(e) =>
              updateConfig({ shiftMode: e.target.value as any })
            }
          >
            <option value="mixed">Mixed (random induct/retrieve)</option>
            <option value="fill-drain">Fill-Drain (fill N then drain N)</option>
            <option value="pure-induct">Pure Induct</option>
            <option value="pure-retrieve">Pure Retrieve</option>
          </select>
        </label>
        <Slider
          label="Pallet count"
          value={config.shiftPalletCount}
          min={10}
          max={1000}
          step={10}
          onChange={set("shiftPalletCount")}
        />
        <Slider
          label="Initial fill"
          value={Math.round(config.initialFillPct * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          onChange={(v) => updateConfig({ initialFillPct: v / 100 })}
        />
        <Slider
          label="SKU count"
          value={config.skuCount}
          min={5}
          max={50}
          step={1}
          onChange={set("skuCount")}
        />
        <Slider
          label="Eval shifts"
          value={config.evalShiftCount}
          min={1}
          max={20}
          step={1}
          onChange={set("evalShiftCount")}
        />
      </div>

      {/* DES / Sweep config */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          DES / Sweep
        </h2>
        <label className="block mb-2">
          <span className="text-xs text-gray-400">Job type</span>
          <select
            className="w-full mt-0.5 bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600"
            value={desConfig.jobType}
            onChange={(e) => updateDESConfig({ jobType: e.target.value as any })}
          >
            <option value="PIPO">PIPO (full pallet in/out)</option>
            <option value="PICO">PICO (pallet in / case out)</option>
          </select>
        </label>
        {desConfig.jobType === "PICO" && (
          <>
            <Slider
              label="PICO mix ratio"
              value={Math.round(desConfig.picoMixRatio * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => updateDESConfig({ picoMixRatio: v / 100 })}
            />
            <Slider
              label="Cases per pallet"
              value={desConfig.casesPerPallet}
              min={1}
              max={100}
              step={1}
              onChange={setDES("casesPerPallet")}
            />
            <Slider
              label="Cases per pick"
              value={desConfig.casesPerPick}
              min={1}
              max={50}
              step={1}
              onChange={setDES("casesPerPick")}
            />
          </>
        )}
        <label className="flex items-center gap-2 mb-2 mt-1">
          <input
            type="checkbox"
            checked={desConfig.botWaitAtStation}
            onChange={(e) => updateDESConfig({ botWaitAtStation: e.target.checked })}
            className="accent-cyan-500"
          />
          <span className="text-xs text-gray-400">Bot waits at station</span>
        </label>
        <Slider
          label="Shift duration"
          value={desConfig.shiftDurationS / 3600}
          min={1}
          max={12}
          step={0.5}
          unit=" hr"
          onChange={(v) => updateDESConfig({ shiftDurationS: v * 3600 })}
        />
        <Slider
          label="Task interarrival"
          value={desConfig.taskInterarrivalS}
          min={1}
          max={120}
          step={1}
          unit=" s"
          onChange={setDES("taskInterarrivalS")}
        />
        <div className="mt-2 mb-1">
          <span className="text-xs text-gray-500 uppercase">Sweep range</span>
        </div>
        <Slider
          label="Min bots"
          value={desConfig.sweepMinBots}
          min={1}
          max={50}
          step={1}
          onChange={setDES("sweepMinBots")}
        />
        <Slider
          label="Max bots"
          value={desConfig.sweepMaxBots}
          min={1}
          max={100}
          step={1}
          onChange={setDES("sweepMaxBots")}
        />
        <Slider
          label="Step"
          value={desConfig.sweepStepBots}
          min={1}
          max={10}
          step={1}
          onChange={setDES("sweepStepBots")}
        />
        <Slider
          label="Shifts per point"
          value={desConfig.sweepShiftsPerPoint}
          min={1}
          max={20}
          step={1}
          onChange={setDES("sweepShiftsPerPoint")}
        />
        {desConfig.jobType === "PICO" && (
          <div className="mt-2">
            <span className="text-xs text-gray-400">Pick time distribution</span>
            <div className="flex items-center gap-2 mt-1">
              <button
                className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                onClick={() => pickDistRef.current?.click()}
              >
                {pickTimeDist ? "Loaded" : "Load JSON"}
              </button>
              {pickTimeDist && (
                <span className="text-[10px] text-green-400">
                  {pickTimeDist.buckets.length} buckets
                </span>
              )}
              <input
                ref={pickDistRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const dist = loadPickTimeDistribution(JSON.parse(text));
                    setPickTimeDist(dist);
                  } catch (err) {
                    console.error("Failed to load pick time distribution:", err);
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Congestion Calibration */}
      <div className="p-3 border-b border-gray-700">
        <h2 className="text-xs font-semibold text-gray-400 uppercase mb-2">
          Congestion Calibration
        </h2>
        <p className="text-[10px] text-gray-500 mb-2">
          Runs time-stepped sim with CA* at sample bot counts to measure
          real congestion penalties, then applies them to DES sweep results.
        </p>
        <label className="block mb-2">
          <span className="text-xs text-gray-400">Sample bot counts</span>
          <input
            type="text"
            className="w-full bg-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-600 focus:border-cyan-500 focus:outline-none mt-0.5"
            value={calibConfig.sampleBotCounts.join(", ")}
            onChange={(e) => {
              const counts = e.target.value
                .split(",")
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => !isNaN(n) && n > 0);
              if (counts.length > 0) updateCalibConfig({ sampleBotCounts: counts });
            }}
          />
        </label>
        <Slider
          label="Shifts per sample"
          value={calibConfig.shiftsPerSample}
          min={1}
          max={20}
          step={1}
          onChange={(v) => updateCalibConfig({ shiftsPerSample: v })}
        />
        <Slider
          label="Tasks per shift"
          value={calibConfig.palletCountPerShift}
          min={20}
          max={500}
          step={10}
          onChange={(v) => updateCalibConfig({ palletCountPerShift: v })}
        />
        {congestionCurve && (
          <div className="mt-2 text-[10px] text-green-400">
            Calibrated: {congestionCurve.samples.length} sample points
            {congestionCurve.samples.map((s) => (
              <div key={s.botCount} className="text-gray-500 ml-2">
                {s.botCount} bots: {s.throughputPenalty.toFixed(2)}x throughput,{" "}
                {s.cycleTimePenalty.toFixed(2)}x cycle time
              </div>
            ))}
          </div>
        )}
      </div>

      {/* spacer */}
      <div className="p-1" />

      {/* Sticky buttons */}
      <div className="sticky bottom-0 p-3 bg-gray-800 border-t border-gray-700 space-y-2">
        <button
          className="w-full py-2 rounded text-sm font-semibold bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
          onClick={handleApplyReset}
        >
          Apply &amp; Reset
        </button>
        <button
          className="w-full py-2 rounded text-sm font-semibold bg-purple-600 hover:bg-purple-500 text-white transition-colors"
          onClick={async () => {
            if (!graph || !graphData) return;
            setPlaying(false);
            try {
              await initWasm();
              loadGraphIntoWasm(graphData, config);
              const result = runMultiShiftEval(graph, config);
              setSimState(result);
            } catch (e) {
              console.error("Eval failed:", e);
            }
          }}
        >
          Run Eval ({config.evalShiftCount} shifts)
        </button>
        <button
          className={`w-full py-2 rounded text-sm font-semibold transition-colors ${
            sweepRunning
              ? "bg-gray-600 text-gray-400 cursor-not-allowed"
              : "bg-emerald-600 hover:bg-emerald-500 text-white"
          }`}
          disabled={sweepRunning}
          onClick={async () => {
            console.log("DES sweep clicked", { graph: !!graph, graphData: !!graphData, sweepRunning });
            if (!graph || !graphData || sweepRunning) return;
            setPlaying(false);
            setSweepRunning(true);
            setSweepResults(null);
            setSweepProgress(null);
            try {
              console.log("Initializing WASM...");
              await initWasm();
              loadGraphIntoWasm(graphData, config);
              console.log("Starting sweep...", { config, desConfig });
              const results = await runBotCountSweep(
                graph,
                config,
                desConfig,
                pickTimeDist,
                (completed, total) => {
                  setSweepProgress({ completed, total });
                },
              );
              console.log("Sweep complete", results);
              // Apply congestion curve if calibrated
              const finalResults = congestionCurve
                ? applyCongestionCurve(results, congestionCurve)
                : results;
              setSweepResults(finalResults);
            } catch (e: any) {
              console.error("DES sweep failed:", e);
              alert("DES sweep failed: " + (e?.message ?? e));
            } finally {
              setSweepRunning(false);
              setSweepProgress(null);
            }
          }}
        >
          {sweepRunning
            ? `Sweep ${sweepProgress ? `${sweepProgress.completed}/${sweepProgress.total}` : "..."}`
            : `Run DES Sweep (${desConfig.sweepMinBots}-${desConfig.sweepMaxBots} bots)`}
        </button>
        <button
          className={`w-full py-2 rounded text-sm font-semibold transition-colors ${
            calibRunning
              ? "bg-gray-600 text-gray-400 cursor-not-allowed"
              : "bg-amber-600 hover:bg-amber-500 text-white"
          }`}
          disabled={calibRunning}
          onClick={async () => {
            if (!graph || !graphData || calibRunning) return;
            setPlaying(false);
            setCalibRunning(true);
            setCalibProgress(null);
            try {
              await initWasm();
              loadGraphIntoWasm(graphData, config);
              const curve = await runCongestionCalibration(
                graph,
                config,
                calibConfig,
                (completed, total, sample) => {
                  setCalibProgress({ completed, total });
                  if (sample) {
                    console.log(`Calibration sample: ${sample.botCount} bots — ` +
                      `throughput penalty: ${sample.throughputPenalty.toFixed(3)}, ` +
                      `cycle time penalty: ${sample.cycleTimePenalty.toFixed(3)}`);
                  }
                },
              );
              setCongestionCurve(curve);
              setCalibSamples(curve.samples);
              console.log("Calibration complete", curve.samples);
            } catch (e: any) {
              console.error("Calibration failed:", e);
              alert("Calibration failed: " + (e?.message ?? e));
            } finally {
              setCalibRunning(false);
              setCalibProgress(null);
            }
          }}
        >
          {calibRunning
            ? `Calibrating ${calibProgress ? `${calibProgress.completed}/${calibProgress.total}` : "..."}`
            : `Calibrate Congestion (${calibConfig.sampleBotCounts.length} points)`}
        </button>
      </div>
    </div>
  );
}
