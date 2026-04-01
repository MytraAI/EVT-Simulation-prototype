import { useRef, useEffect, useCallback, useState } from "react";
import { useStore } from "../store";
import { useDisplayState } from "../hooks/useDisplayState";
import type { NodeKind } from "../graph/types";
import { KIND_COLORS } from "../graph/types";

const NODE_LABEL: Record<NodeKind, string> = {
  AISLE_CELL: "Aisle",
  PALLET_POSITION: "Pallet",
  Z_COLUMN: "Z-Col",
  STATION_XY: "Stn XY",
  STATION_OP: "Stn OP",
  STATION_PEZ: "Stn PEZ",
};

const BOT_COLORS = [
  "#00e5ff", "#ff6d00", "#76ff03", "#d500f9", "#ffea00",
  "#ff1744", "#00b0ff", "#1de9b6", "#ff9100", "#f50057",
];

type ViewState = { panX: number; panY: number; zoom: number };

export function Viewport2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graph = useStore((s) => s.graph);
  const simState = useDisplayState();
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const viewLevel = useStore((s) => s.viewLevel);
  const setViewLevel = useStore((s) => s.setViewLevel);

  const viewRef = useRef<ViewState>({ panX: 0, panY: 0, zoom: 1 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [, forceRender] = useState(0);

  // Auto-fit
  useEffect(() => {
    if (!graph || !containerRef.current) return;
    const { bounds } = graph;
    const w = containerRef.current.clientWidth;
    const h = containerRef.current.clientHeight;
    const graphW = bounds.maxX - bounds.minX;
    const graphH = bounds.maxY - bounds.minY;
    const padding = 60;
    const zoom = Math.min(
      (w - padding * 2) / Math.max(graphW, 1),
      (h - padding * 2) / Math.max(graphH, 1),
    );
    viewRef.current = {
      zoom,
      panX: w / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
      panY: h / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom,
    };
    forceRender((n) => n + 1);
  }, [graph]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !graph) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = viewRef.current;

    // Clear
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(v.panX, v.panY);
    ctx.scale(v.zoom, v.zoom);

    const showLevel = viewLevel; // 0 = all

    // Edges
    ctx.strokeStyle = "rgba(55, 65, 81, 0.5)";
    ctx.lineWidth = 0.3 / v.zoom;
    for (const edge of graph.data.edges) {
      const a = graph.nodeMap.get(edge.a);
      const b = graph.nodeMap.get(edge.b);
      if (!a || !b) continue;
      if (showLevel > 0 && a.level !== showLevel && b.level !== showLevel)
        continue;
      ctx.beginPath();
      ctx.moveTo(a.position.x_m, a.position.y_m);
      ctx.lineTo(b.position.x_m, b.position.y_m);
      ctx.stroke();
    }

    // Nodes
    for (const node of graph.data.nodes) {
      if (showLevel > 0 && node.level !== showLevel) continue;
      const kind = node.kind as NodeKind;
      const color = KIND_COLORS[kind] || "#888";

      // Check if occupied by a pallet
      const pallet = simState?.pallets.get(node.id);

      ctx.globalAlpha = kind === "AISLE_CELL" ? 0.25 : 0.7;
      ctx.fillStyle = color;

      const x = node.position.x_m - node.size_x_m / 2;
      const y = node.position.y_m - node.size_y_m / 2;
      ctx.fillRect(x, y, node.size_x_m, node.size_y_m);

      // Draw pallet on top if occupied — size scales with pallet height
      if (pallet) {
        const skuColor =
          simState?.skuCatalog.find((s) => s.sku === pallet.sku)?.color ??
          "#fff";
        // Scale fill from 0.4 (short ~0.2m) to 0.9 (tall ~1.8m)
        const hFrac = Math.min(1, Math.max(0, (pallet.heightM - 0.2) / 1.6));
        const fillScale = 0.4 + hFrac * 0.5;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = skuColor;
        const half = fillScale / 2;
        const px = node.position.x_m - node.size_x_m * half;
        const py = node.position.y_m - node.size_y_m * half;
        ctx.fillRect(px, py, node.size_x_m * fillScale, node.size_y_m * fillScale);
      }

      // Selection highlight
      if (node.id === selectedNodeId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 / v.zoom;
        ctx.strokeRect(x, y, node.size_x_m, node.size_y_m);
      }
    }
    ctx.globalAlpha = 1;

    // Bots
    if (simState) {
      for (const bot of simState.bots) {
        const curNode = graph.nodeMap.get(bot.currentNodeId);
        if (!curNode) continue;
        if (showLevel > 0 && curNode.level !== showLevel) continue;

        // Interpolate between prev and current
        const prevNode = graph.nodeMap.get(bot.prevNodeId);
        const t = bot.moveProgress;
        let bx: number, by: number;
        if (prevNode && t < 1) {
          bx =
            prevNode.position.x_m +
            (curNode.position.x_m - prevNode.position.x_m) * t;
          by =
            prevNode.position.y_m +
            (curNode.position.y_m - prevNode.position.y_m) * t;
        } else {
          bx = curNode.position.x_m;
          by = curNode.position.y_m;
        }

        const r = 0.3;
        const color = BOT_COLORS[bot.id % BOT_COLORS.length];

        // Bot circle
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 / v.zoom;
        ctx.stroke();

        // Carrying indicator
        if (
          bot.state === "TRAVELING_TO_DROPOFF" ||
          bot.state === "EDGE_WAIT_DROP" ||
          bot.state === "PLACING"
        ) {
          ctx.beginPath();
          ctx.arc(bx, by, r * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffca28";
          ctx.fill();
        }

        // Bot ID
        const fontSize = Math.max(8 / v.zoom, 0.18);
        ctx.fillStyle = "#000";
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(bot.id), bx, by);

        // Draw path preview
        if (bot.path.length > 0 && bot.pathIndex < bot.path.length - 1) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1.5 / v.zoom;
          ctx.setLineDash([3 / v.zoom, 3 / v.zoom]);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          for (let pi = bot.pathIndex + 1; pi < bot.path.length; pi++) {
            const pn = graph.nodeMap.get(bot.path[pi]);
            if (pn) ctx.lineTo(pn.position.x_m, pn.position.y_m);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Physical columns
    if (graph.data.metadata?.physical?.columns) {
      ctx.fillStyle = "rgba(107, 114, 128, 0.4)";
      for (const col of graph.data.metadata.physical.columns) {
        ctx.fillRect(
          col.x_m - col.width_m / 2,
          col.y_m - col.depth_m / 2,
          col.width_m,
          col.depth_m,
        );
      }
    }

    ctx.restore();

    // HUD: Legend
    let legendX = 10;
    const legendY = h - 16;
    ctx.font = "11px sans-serif";
    for (const kind of Object.keys(KIND_COLORS) as NodeKind[]) {
      ctx.fillStyle = KIND_COLORS[kind];
      ctx.fillRect(legendX, legendY - 8, 10, 10);
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(NODE_LABEL[kind], legendX + 14, legendY - 3);
      legendX += ctx.measureText(NODE_LABEL[kind]).width + 24;
    }

    // Zoom %
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(v.zoom * 100)}%`, w - 10, 20);
  }, [graph, simState, selectedNodeId, viewLevel]);

  // Pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
    };
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    viewRef.current.panX =
      dragRef.current.panX + (e.clientX - dragRef.current.startX);
    viewRef.current.panY =
      dragRef.current.panY + (e.clientY - dragRef.current.startY);
    forceRender((n) => n + 1);
  }, []);
  const onMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Zoom
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const v = viewRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(200, v.zoom * factor));
    v.panX = mx - (mx - v.panX) * (newZoom / v.zoom);
    v.panY = my - (my - v.panY) * (newZoom / v.zoom);
    v.zoom = newZoom;
    forceRender((n) => n + 1);
  }, []);

  // Click select
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (!graph || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const v = viewRef.current;
      const worldX = (e.clientX - rect.left - v.panX) / v.zoom;
      const worldY = (e.clientY - rect.top - v.panY) / v.zoom;
      let closest: string | null = null;
      let closestDist = Infinity;
      for (const node of graph.data.nodes) {
        if (viewLevel > 0 && node.level !== viewLevel) continue;
        const dx = node.position.x_m - worldX;
        const dy = node.position.y_m - worldY;
        const dist = dx * dx + dy * dy;
        if (
          dist < closestDist &&
          Math.abs(dx) < node.size_x_m &&
          Math.abs(dy) < node.size_y_m
        ) {
          closestDist = dist;
          closest = node.id;
        }
      }
      setSelectedNodeId(closest);
    },
    [graph, setSelectedNodeId, viewLevel],
  );

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => forceRender((n) => n + 1));
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
      onClick={onClick}
    >
      <canvas ref={canvasRef} className="block" />

      {/* Level selector overlay */}
      {graph && graph.levels.length > 1 && (
        <div className="absolute top-3 right-3 flex items-center gap-1 bg-gray-800/90 backdrop-blur rounded-lg px-3 py-1.5 border border-gray-700">
          <span className="text-xs text-gray-400 mr-1">Level:</span>
          <button
            className={`px-2 py-0.5 rounded text-xs ${
              viewLevel === 0
                ? "bg-cyan-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setViewLevel(0);
            }}
          >
            All
          </button>
          {graph.levels.map((lvl) => (
            <button
              key={lvl}
              className={`px-2 py-0.5 rounded text-xs ${
                viewLevel === lvl
                  ? "bg-cyan-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setViewLevel(lvl);
              }}
            >
              {lvl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
