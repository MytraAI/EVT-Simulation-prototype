import { create } from "zustand";
import type { GraphData } from "./graph/types";
import type { WarehouseGraph } from "./graph/loader";
import { loadGraph } from "./graph/loader";
import type { SimConfig, SimState } from "./simulation/types";
import { DEFAULT_CONFIG } from "./simulation/types";

export type CameraMode = "3d" | "isometric" | "2d";
export type SimSpeed = 1 | 2 | 5 | 10 | 0; // 0 = max

type Store = {
  graphData: GraphData | null;
  graph: WarehouseGraph | null;
  setGraphData: (data: GraphData) => void;

  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;

  // 2D level filter (0 = all levels)
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

  metricsPanelHeight: number;
  setMetricsPanelHeight: (h: number) => void;

  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
};

export const useStore = create<Store>((set) => ({
  graphData: null,
  graph: null,
  setGraphData: (data) =>
    set({ graphData: data, graph: loadGraph(data), simState: null }),

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

  metricsPanelHeight: 320,
  setMetricsPanelHeight: (h) => set({ metricsPanelHeight: h }),

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
}));
