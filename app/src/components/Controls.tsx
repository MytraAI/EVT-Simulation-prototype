import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import type { CameraMode, SimSpeed } from "../store";
import { initWasm, loadGraphIntoWasm } from "../simulation/wasm-bridge";
import { createInitialState, stepSimulation } from "../simulation/engine";

const SPEEDS: SimSpeed[] = [1, 2, 5, 10, 0];
const VIEWS: { mode: CameraMode; label: string }[] = [
  { mode: "3d", label: "3D" },
  { mode: "isometric", label: "Iso" },
  { mode: "2d", label: "2D" },
];

export function Controls() {
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const simState = useStore((s) => s.simState);
  const setSimState = useStore((s) => s.setSimState);
  const graph = useStore((s) => s.graph);
  const graphData = useStore((s) => s.graphData);
  const config = useStore((s) => s.config);

  const wasmReady = useRef(false);
  const animRef = useRef<number>(0);

  // Initialize WASM + simulation
  const handleInit = useCallback(async () => {
    if (!graph || !graphData) return;
    try {
      await initWasm();
      loadGraphIntoWasm(graphData, config);
      wasmReady.current = true;
      const initial = createInitialState(graph, config);
      setSimState(initial);
    } catch (e) {
      console.error("Failed to init simulation:", e);
    }
  }, [graph, graphData, config, setSimState]);

  // Auto-init when graph loads
  useEffect(() => {
    if (graph && !simState) {
      handleInit();
    }
  }, [graph, simState, handleInit]);

  // Step once
  const doStep = useCallback(() => {
    if (!graph || !simState || !wasmReady.current) return;
    const next = stepSimulation(graph, simState, config);
    setSimState(next);
  }, [graph, simState, config, setSimState]);

  // Play loop
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(animRef.current);
      return;
    }

    let lastTime = 0;
    // Base tick = 500ms (2 ticks/sec). Speed multiplier makes it faster.
    const interval = speed === 0 ? 0 : 500 / speed;

    const tick = (time: number) => {
      if (time - lastTime >= interval) {
        lastTime = time;
        const s = useStore.getState();
        if (s.graph && s.simState && wasmReady.current) {
          if (s.simState.shiftDone) {
            s.setPlaying(false);
            return;
          }
          const next = stepSimulation(s.graph, s.simState, s.config);
          s.setSimState(next);
        }
      }
      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, speed]);

  // Reset
  const handleReset = useCallback(() => {
    setPlaying(false);
    if (graph) {
      const initial = createInitialState(graph, config);
      setSimState(initial);
    }
  }, [graph, config, setPlaying, setSimState]);

  return (
    <div className="flex items-center gap-2 bg-gray-800/90 backdrop-blur rounded-lg px-4 py-2 border border-gray-700">
      {/* Transport */}
      <button
        className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
        onClick={() => setPlaying(!playing)}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button
        className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
        onClick={doStep}
        title="Step one timestep"
      >
        Step
      </button>
      <button
        className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
        onClick={handleReset}
      >
        Reset
      </button>

      <div className="w-px h-6 bg-gray-600" />

      {/* Speed */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-400">Speed:</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`px-2 py-0.5 rounded text-xs ${
              speed === s
                ? "bg-cyan-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
            onClick={() => setSpeed(s)}
          >
            {s === 0 ? "Max" : `${s}x`}
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-gray-600" />

      {/* View mode */}
      <ViewButtons />

      <div className="w-px h-6 bg-gray-600" />

      {/* Batch run */}
      <button
        className="px-3 py-1 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 transition-colors"
        onClick={() => {
          if (!graph || !simState || !wasmReady.current) return;
          let s = simState;
          for (let i = 0; i < 100; i++) {
            s = stepSimulation(graph, s, config);
          }
          setSimState(s);
        }}
      >
        Run 100
      </button>

      <div className="w-px h-6 bg-gray-600" />

      {/* Step counter */}
      <span className="text-xs text-gray-400 tabular-nums">
        Step: {simState?.step ?? 0}
      </span>
    </div>
  );
}

function ViewButtons() {
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-gray-400">View:</span>
      {VIEWS.map((v) => (
        <button
          key={v.mode}
          className={`px-2 py-0.5 rounded text-xs ${
            cameraMode === v.mode
              ? "bg-cyan-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
          onClick={() => setCameraMode(v.mode)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
