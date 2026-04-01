import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { loadGraphFromFile } from "../graph/loader";
import type { GraphData } from "../graph/types";
import type { SimConfig } from "../simulation/types";
import { initWasm, loadGraphIntoWasm } from "../simulation/wasm-bridge";
import { createInitialState, runMultiShiftEval } from "../simulation/engine";

const BUILT_IN_MAPS = [
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
  const [activeMap, setActiveMap] = useState("EVT 3/31");

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

  const set = (key: keyof SimConfig) => (v: number) =>
    updateConfig({ [key]: v });

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
      </div>
    </div>
  );
}
