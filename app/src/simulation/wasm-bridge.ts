import type { GraphData } from "../graph/types";
import type { SimConfig } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var wasmLoadGraph: (graphJSON: string, costParamsJSON: string) => WasmResult;
  // eslint-disable-next-line no-var
  var wasmFindPath: (sourceID: string, targetID: string) => WasmPathResult;
  // eslint-disable-next-line no-var
  var wasmSingleSource: (sourceID: string) => Record<string, number>;
}

type WasmResult = { ok: boolean; error?: string; nodes?: number; edges?: number };
type WasmPathResult = { ok: boolean; error?: string; totalCost?: number; path?: string[] };

let wasmReady = false;
let wasmLoadPromise: Promise<void> | null = null;

export async function initWasm(): Promise<void> {
  if (wasmReady) return;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    // Load wasm_exec.js
    const script = document.createElement("script");
    script.src = "/wasm_exec.js";
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = reject;
      document.head.appendChild(script);
    });

    // Instantiate WASM
    const go = new (globalThis as any).Go();
    const result = await WebAssembly.instantiateStreaming(
      fetch("/pathfinder.wasm"),
      go.importObject,
    );
    go.run(result.instance);
    wasmReady = true;
  })();

  return wasmLoadPromise;
}

export function loadGraphIntoWasm(data: GraphData, config: SimConfig): void {
  if (!wasmReady) throw new Error("WASM not initialized");
  const costParams = JSON.stringify({
    xyCostPerM: config.xyCostPerM,
    zUpCostPerM: config.zUpCostPerM,
    zDownCostPerM: config.zDownCostPerM,
    xyTurnCost: config.xyTurnCost,
    xyzTurnCost: config.xyzTurnCost,
  });
  const result = globalThis.wasmLoadGraph(JSON.stringify(data), costParams);
  if (!result.ok) {
    throw new Error(`WASM loadGraph failed: ${result.error}`);
  }
}

export function findPath(
  sourceID: string,
  targetID: string,
): { totalCost: number; path: string[] } | null {
  if (!wasmReady) throw new Error("WASM not initialized");
  const result = globalThis.wasmFindPath(sourceID, targetID);
  if (!result.ok) return null;
  return { totalCost: result.totalCost!, path: result.path! };
}

export function singleSourceCosts(sourceID: string): Map<string, number> {
  if (!wasmReady) throw new Error("WASM not initialized");
  const raw = globalThis.wasmSingleSource(sourceID);
  return new Map(Object.entries(raw));
}
