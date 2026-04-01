import { useEffect, useState, Component, type ReactNode } from "react";
import { useStore } from "../store";
import { ConfigPanel } from "./ConfigPanel";
import { Viewport } from "./Viewport";
import { Controls } from "./Controls";
import { MetricsPanel } from "./MetricsPanel";
import type { GraphData } from "../graph/types";

const DEFAULT_MAP = "/EVT_3_31_21.json";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 bg-red-900/50 text-red-200 m-4 rounded">
          <h2 className="font-bold mb-2">Render Error</h2>
          <pre className="text-xs whitespace-pre-wrap">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const graph = useStore((s) => s.graph);
  const setGraphData = useStore((s) => s.setGraphData);
  const metricsPanelHeight = useStore((s) => s.metricsPanelHeight);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(DEFAULT_MAP)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: GraphData) => {
        setGraphData(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Failed to load default map:", e);
        setLoadError(String(e));
        setLoading(false);
      });
  }, [setGraphData]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Left sidebar */}
      <ErrorBoundary>
        <ConfigPanel />
      </ErrorBoundary>

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* 3D Viewport */}
        <div className="flex-1 relative min-h-0">
          {loadError && (
            <div className="flex items-center justify-center h-full text-red-400">
              <p>Failed to load map: {loadError}</p>
            </div>
          )}
          {loading && !loadError && (
            <div className="flex items-center justify-center h-full text-gray-500">
              <p className="text-lg">Loading map...</p>
            </div>
          )}
          {graph && !loadError && (
            <ErrorBoundary>
              <Viewport />
            </ErrorBoundary>
          )}
          {graph && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
              <Controls />
            </div>
          )}
        </div>

        {graph && (
          <ErrorBoundary>
            <MetricsPanel height={metricsPanelHeight} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
