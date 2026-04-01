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
  const history = useStore((s) => s.history);
  const scrubIndex = useStore((s) => s.scrubIndex);
  const setScrubIndex = useStore((s) => s.setScrubIndex);

  const wasmReady = useRef(false);
  const animRef = useRef<number>(0);

  // The state to display: either scrubbed history frame or live state
  const displayState = scrubIndex !== null && history[scrubIndex]
    ? history[scrubIndex]
    : simState;

  // Initialize WASM + simulation
  const handleInit = useCallback(async () => {
    if (!graph || !graphData) return;
    try {
      await initWasm();
      loadGraphIntoWasm(graphData, config);
      wasmReady.current = true;
      const initial = createInitialState(graph, config);
      setSimState(initial);
      useStore.getState().clearHistory();
      useStore.getState().pushHistory(initial);
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
    // If scrubbing, exit scrub mode first
    if (scrubIndex !== null) {
      setScrubIndex(null);
    }
    const next = stepSimulation(graph, simState, config);
    setSimState(next);
    useStore.getState().pushHistory(next);
  }, [graph, simState, config, setSimState, scrubIndex, setScrubIndex]);

  // Play loop
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(animRef.current);
      return;
    }

    // Exit scrub mode when playing
    const s0 = useStore.getState();
    if (s0.scrubIndex !== null) {
      s0.setScrubIndex(null);
    }

    let lastTime = 0;
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
          s.pushHistory(next);
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
    setScrubIndex(null);
    if (graph) {
      const initial = createInitialState(graph, config);
      setSimState(initial);
      useStore.getState().clearHistory();
      useStore.getState().pushHistory(initial);
    }
  }, [graph, config, setPlaying, setSimState, setScrubIndex]);

  // Scrubber handlers
  const handleScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(e.target.value);
      setScrubIndex(idx);
    },
    [setScrubIndex],
  );

  const handleScrubEnd = useCallback(() => {
    // Stay in scrub mode — user can hit Play to resume from live state
  }, []);

  const goToLive = useCallback(() => {
    setScrubIndex(null);
  }, [setScrubIndex]);

  const currentStep = displayState?.step ?? 0;
  const isScrubbing = scrubIndex !== null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Scrubber bar */}
      {history.length > 1 && (
        <div className="flex items-center gap-2 bg-gray-800/90 backdrop-blur rounded-lg px-4 py-1.5 border border-gray-700">
          <span className="text-[10px] text-gray-500 w-6 tabular-nums">0</span>
          <input
            type="range"
            className="flex-1 accent-cyan-500 h-1.5"
            min={0}
            max={history.length - 1}
            value={scrubIndex ?? history.length - 1}
            onChange={handleScrub}
            onMouseUp={handleScrubEnd}
          />
          <span className="text-[10px] text-gray-500 w-12 tabular-nums text-right">
            {history.length - 1}
          </span>
          {isScrubbing && (
            <button
              className="px-2 py-0.5 rounded text-[10px] font-medium bg-cyan-700 text-white hover:bg-cyan-600"
              onClick={goToLive}
            >
              Live
            </button>
          )}
        </div>
      )}

      {/* Transport controls */}
      <div className="flex items-center gap-2 bg-gray-800/90 backdrop-blur rounded-lg px-4 py-2 border border-gray-700">
        <button
          className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
          onClick={() => {
            if (isScrubbing) setScrubIndex(null);
            setPlaying(!playing);
          }}
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

        <ViewButtons />

        <div className="w-px h-6 bg-gray-600" />

        {/* Batch run (records all frames to history) */}
        <button
          className="px-3 py-1 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 transition-colors"
          onClick={() => {
            if (!graph || !simState || !wasmReady.current) return;
            if (isScrubbing) setScrubIndex(null);
            let s = simState;
            for (let i = 0; i < 100; i++) {
              if (s.shiftDone) break;
              s = stepSimulation(graph, s, config);
              useStore.getState().pushHistory(s);
            }
            setSimState(s);
          }}
        >
          Run 100
        </button>

        <div className="w-px h-6 bg-gray-600" />

        {/* Step counter */}
        <span className="text-xs text-gray-400 tabular-nums">
          {isScrubbing && (
            <span className="text-amber-400 mr-1">SCRUB</span>
          )}
          Step: {currentStep}
        </span>
      </div>
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
