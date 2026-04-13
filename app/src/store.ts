import { create } from "zustand";
import type { GraphData } from "./graph/types";
import type { WarehouseGraph } from "./graph/loader";
import { loadGraph } from "./graph/loader";
import type { SimConfig, SimState } from "./simulation/types";
import { DEFAULT_CONFIG } from "./simulation/types";
import type { DESConfig, DESSweepPoint, PickTimeDistribution } from "./simulation/des-types";
import { DEFAULT_DES_CONFIG } from "./simulation/des-types";
import type { CalibrationConfig, CongestionCurve, CalibrationSample } from "./simulation/congestion-calibration";
import { DEFAULT_CALIBRATION_CONFIG } from "./simulation/congestion-calibration";

export type CameraMode = "3d" | "isometric" | "2d";
export type SimSpeed = 1 | 2 | 5 | 10 | 0; // 0 = max

type Store = {
  graphData: GraphData | null;
  graph: WarehouseGraph | null;
  setGraphData: (data: GraphData) => void;

  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;

  viewLevel: number;
  setViewLevel: (level: number) => void;

  config: SimConfig;
  updateConfig: (partial: Partial<SimConfig>) => void;

  simState: SimState | null;
  setSimState: (state: SimState | null) => void;

  playing: boolean;
  speed: SimSpeed;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: SimSpeed) => void;

  // Playback history
  history: SimState[];
  pushHistory: (state: SimState) => void;
  clearHistory: () => void;
  scrubIndex: number | null; // null = live, number = viewing history frame
  setScrubIndex: (index: number | null) => void;

  metricsPanelHeight: number;
  setMetricsPanelHeight: (h: number) => void;

  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // DES sweep
  desConfig: DESConfig;
  updateDESConfig: (partial: Partial<DESConfig>) => void;
  sweepResults: DESSweepPoint[] | null;
  setSweepResults: (results: DESSweepPoint[] | null) => void;
  sweepRunning: boolean;
  setSweepRunning: (running: boolean) => void;
  sweepProgress: { completed: number; total: number } | null;
  setSweepProgress: (p: { completed: number; total: number } | null) => void;
  pickTimeDist: PickTimeDistribution | null;
  setPickTimeDist: (dist: PickTimeDistribution | null) => void;

  // Congestion calibration
  calibConfig: CalibrationConfig;
  updateCalibConfig: (partial: Partial<CalibrationConfig>) => void;
  congestionCurve: CongestionCurve | null;
  setCongestionCurve: (curve: CongestionCurve | null) => void;
  calibRunning: boolean;
  setCalibRunning: (running: boolean) => void;
  calibProgress: { completed: number; total: number } | null;
  setCalibProgress: (p: { completed: number; total: number } | null) => void;
  calibSamples: CalibrationSample[] | null;
  setCalibSamples: (samples: CalibrationSample[] | null) => void;
};

// Max frames to keep in history (~10 min at 1x = 1200 frames)
const MAX_HISTORY = 5000;

export const useStore = create<Store>((set) => ({
  graphData: null,
  graph: null,
  setGraphData: (data) =>
    set({ graphData: data, graph: loadGraph(data), simState: null, history: [], scrubIndex: null }),

  cameraMode: "3d",
  setCameraMode: (mode) => set({ cameraMode: mode }),

  viewLevel: 0,
  setViewLevel: (level) => set({ viewLevel: level }),

  config: DEFAULT_CONFIG,
  updateConfig: (partial) =>
    set((s) => ({ config: { ...s.config, ...partial } })),

  simState: null,
  setSimState: (simState) => set({ simState }),

  playing: false,
  speed: 1,
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),

  history: [],
  pushHistory: (state) =>
    set((s) => {
      const h = s.history.length >= MAX_HISTORY
        ? [...s.history.slice(s.history.length - MAX_HISTORY + 1), state]
        : [...s.history, state];
      return { history: h };
    }),
  clearHistory: () => set({ history: [], scrubIndex: null }),
  scrubIndex: null,
  setScrubIndex: (index) => set({ scrubIndex: index }),

  metricsPanelHeight: 320,
  setMetricsPanelHeight: (h) => set({ metricsPanelHeight: h }),

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  // DES sweep
  desConfig: DEFAULT_DES_CONFIG,
  updateDESConfig: (partial) =>
    set((s) => ({ desConfig: { ...s.desConfig, ...partial } })),
  sweepResults: null,
  setSweepResults: (sweepResults) => set({ sweepResults }),
  sweepRunning: false,
  setSweepRunning: (sweepRunning) => set({ sweepRunning }),
  sweepProgress: null,
  setSweepProgress: (sweepProgress) => set({ sweepProgress }),
  pickTimeDist: null,
  setPickTimeDist: (pickTimeDist) => set({ pickTimeDist }),

  // Congestion calibration
  calibConfig: DEFAULT_CALIBRATION_CONFIG,
  updateCalibConfig: (partial) =>
    set((s) => ({ calibConfig: { ...s.calibConfig, ...partial } })),
  congestionCurve: null,
  setCongestionCurve: (congestionCurve) => set({ congestionCurve }),
  calibRunning: false,
  setCalibRunning: (calibRunning) => set({ calibRunning }),
  calibProgress: null,
  setCalibProgress: (calibProgress) => set({ calibProgress }),
  calibSamples: null,
  setCalibSamples: (calibSamples) => set({ calibSamples }),
}));
