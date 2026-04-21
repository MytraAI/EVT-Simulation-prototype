#!/usr/bin/env python3
"""Visualize the Grainger south-zone station slice and animate bot schedules.

Produces:
  1. Static slice map (PNG) — station types color-coded, entry/exit marked
  2. Animated bot flow (HTML) — Plotly frame-by-frame animation of a CP-SAT
     schedule showing bots traversing the slice

Usage:
    # Static slice only
    python visualize.py --layout Scp --output output/viz/slice_Scp.png

    # Animated schedule
    python visualize.py --layout Scp --schedule output/sweep/schedule_Scp_n8_s1.json \
        --output output/viz/anim_Scp.html

    # Quick demo: run a single solve and animate it
    python visualize.py --layout Ep-Sc --demo --bots 7 --output output/viz/
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

logger = logging.getLogger(__name__)

# ── Colour palette (dark-theme friendly) ──
COLORS = {
    "aisle":          "#26a69a",   # teal
    "pallet":         "#ffca28",   # amber
    "casepick_op":    "#ab47bc",   # purple — casepick stations
    "fullcase_op":    "#ff7043",   # orange — full-case stations
    "station_xy":     "#78909c",   # blue-grey — gateways
    "station_pez":    "#a0a0aa",   # grey — PEZ
    "z_column":       "#66bb6a",   # green — entry/exit z-columns
    "entry":          "#4caf50",   # green marker
    "exit":           "#f44336",   # red marker
    "bot":            "#00e5ff",   # cyan — bot body
    "bot_service":    "#ff4081",   # pink — bot at service
    "edge":           "#546e7a40", # faint line
    "background":     "#0d1117",
    "text":           "#c9d1d9",
}

# Station classification
SOUTH_CASEPICK_OPS = {"op-4-0", "op-8-0", "op-12-0", "op-16-0"}
EAST_FULLCASE_OPS = {"op-21-4", "op-21-7", "op-21-10"}
ALL_OPS = SOUTH_CASEPICK_OPS | EAST_FULLCASE_OPS

# Entry/exit cells
from graph_utils import ZONE_ENTRY_POINTS, ZONE_EXIT_POINTS, EP_EAST_ENTRY_POINTS, EP_EAST_EXIT_POINTS
ALL_ENTRIES = set(ZONE_ENTRY_POINTS) | set(EP_EAST_ENTRY_POINTS)
ALL_EXITS = set(ZONE_EXIT_POINTS) | set(EP_EAST_EXIT_POINTS)


def load_slice_graph(layout: str):
    """Load the south-zone slice as a NetworkX graph."""
    from graph_utils import extract_south_zone
    here = Path(__file__).resolve().parent
    repo_root = next(p for p in here.parents if (p / ".git").exists())
    candidates = [
        repo_root / "projects" / "grainger_pilot" / "maps" / f"grainger-pilot-{layout}.json",
        repo_root / f"grainger-pilot-{layout}.json",
    ]
    gpath = next((c for c in candidates if c.exists()), candidates[0])
    return extract_south_zone(str(gpath))


def _node_color(node_id: str, kind: str) -> str:
    if node_id in SOUTH_CASEPICK_OPS:
        return COLORS["casepick_op"]
    if node_id in EAST_FULLCASE_OPS:
        return COLORS["fullcase_op"]
    if kind == "STATION_XY":
        return COLORS["station_xy"]
    if kind == "STATION_PEZ":
        return COLORS["station_pez"]
    if kind == "Z_COLUMN":
        return COLORS["z_column"]
    if kind == "PALLET_POSITION":
        return COLORS["pallet"]
    return COLORS["aisle"]


def _node_size(node_id: str, kind: str) -> float:
    if node_id in ALL_OPS:
        return 80
    if kind in ("STATION_XY", "STATION_PEZ"):
        return 50
    if kind == "Z_COLUMN":
        return 45
    return 20


def render_static_slice(graph, output_path: Path, layout: str = "") -> None:
    """Render the slice as a static PNG with color-coded stations."""
    fig, ax = plt.subplots(figsize=(14, 10), facecolor=COLORS["background"])
    ax.set_facecolor(COLORS["background"])

    # Draw edges
    for u, v in graph.edges():
        x0, y0 = graph.nodes[u]["position"]["x_m"], graph.nodes[u]["position"]["y_m"]
        x1, y1 = graph.nodes[v]["position"]["x_m"], graph.nodes[v]["position"]["y_m"]
        ax.plot([x0, x1], [y0, y1], color=COLORS["edge"], linewidth=0.5, zorder=1)

    # Draw nodes
    for n, d in graph.nodes(data=True):
        x, y = d["position"]["x_m"], d["position"]["y_m"]
        kind = d.get("kind", "")
        c = _node_color(n, kind)
        s = _node_size(n, kind)
        marker = "s" if kind == "PALLET_POSITION" else ("D" if n in ALL_OPS else "o")
        ax.scatter(x, y, c=c, s=s, marker=marker, zorder=3, edgecolors="none", alpha=0.85)

        # Label stations
        if n in ALL_OPS:
            label = "CP" if n in SOUTH_CASEPICK_OPS else "FC"
            ax.annotate(label, (x, y), fontsize=7, color="white", fontweight="bold",
                       ha="center", va="center", zorder=4)

    # Mark entry/exit boundary cells
    for n in ALL_ENTRIES:
        if n in graph.nodes:
            x, y = graph.nodes[n]["position"]["x_m"], graph.nodes[n]["position"]["y_m"]
            ax.scatter(x, y, c=COLORS["entry"], s=120, marker="^", zorder=5,
                      edgecolors="white", linewidths=0.8, label="Entry" if n == sorted(ALL_ENTRIES)[0] else "")
    for n in ALL_EXITS:
        if n in graph.nodes:
            x, y = graph.nodes[n]["position"]["x_m"], graph.nodes[n]["position"]["y_m"]
            ax.scatter(x, y, c=COLORS["exit"], s=120, marker="v", zorder=5,
                      edgecolors="white", linewidths=0.8, label="Exit" if n == sorted(ALL_EXITS)[0] else "")

    # Legend
    legend_handles = [
        mpatches.Patch(color=COLORS["casepick_op"], label="Casepick Station (CP)"),
        mpatches.Patch(color=COLORS["fullcase_op"], label="Full-Case Station (FC)"),
        mpatches.Patch(color=COLORS["aisle"], label="Aisle Cell"),
        mpatches.Patch(color=COLORS["pallet"], label="Pallet Position"),
        mpatches.Patch(color=COLORS["z_column"], label="Z-Column (vertical)"),
        mpatches.Patch(color=COLORS["entry"], label="Entry Point"),
        mpatches.Patch(color=COLORS["exit"], label="Exit Point"),
    ]
    ax.legend(handles=legend_handles, loc="upper left", fontsize=8,
             facecolor="#161b22", edgecolor="#30363d", labelcolor=COLORS["text"])

    ax.set_title(f"Grainger Pilot — South Zone Slice [{layout}]\n"
                 f"{graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges",
                 color=COLORS["text"], fontsize=13, pad=12)
    ax.set_xlabel("x (meters)", color=COLORS["text"])
    ax.set_ylabel("y (meters)", color=COLORS["text"])
    ax.tick_params(colors=COLORS["text"])
    for spine in ax.spines.values():
        spine.set_color("#30363d")
    ax.set_aspect("equal")
    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150, facecolor=COLORS["background"])
    plt.close(fig)
    logger.info("Static slice → %s", output_path)


def render_gif(graph, schedule: dict, output_path: Path,
               layout: str = "", step_s: float = 2.0,
               fps: int = 10, max_frames: int = 200) -> None:
    """Render a GIF of bots moving through the slice using matplotlib + Pillow."""
    from io import BytesIO
    from PIL import Image

    pos = {n: (d["position"]["x_m"], d["position"]["y_m"])
           for n, d in graph.nodes(data=True)}

    steps = schedule.get("steps", [])
    if not steps:
        logger.warning("No steps — skipping GIF"); return

    max_t = max(s["end"] for s in steps)
    bot_ids = sorted(set(s["bot_id"] for s in steps))
    bot_configs = schedule.get("bot_configs", [])

    bot_at: dict[int, list[dict]] = {bid: [] for bid in bot_ids}
    for s in steps:
        bot_at[s["bot_id"]].append(s)
    for bid in bot_ids:
        bot_at[bid].sort(key=lambda x: x["start"])

    def _bot_pos_at(bid, t):
        for s in bot_at[bid]:
            if s["start"] <= t < s["end"]:
                cell = s["cell_id"]
                if cell in pos:
                    return (*pos[cell], cell)
        return None

    times = list(range(0, min(int(max_t) + 1, int(step_s * max_frames)), int(step_s)))
    if not times:
        return

    # Pre-compute bounds
    all_x = [p[0] for p in pos.values()]
    all_y = [p[1] for p in pos.values()]
    x_pad = (max(all_x) - min(all_x)) * 0.05
    y_pad = (max(all_y) - min(all_y)) * 0.05

    pil_frames: list[Image.Image] = []
    logger.info("Rendering %d GIF frames for %s...", len(times), layout)

    for ti, t in enumerate(times):
        fig, ax = plt.subplots(figsize=(12, 8), facecolor=COLORS["background"])
        ax.set_facecolor(COLORS["background"])

        # Edges
        for u, v in graph.edges():
            x0, y0 = pos[u]; x1, y1 = pos[v]
            ax.plot([x0, x1], [y0, y1], color=COLORS["edge"], linewidth=0.4, zorder=1)

        # Static nodes
        for n, d in graph.nodes(data=True):
            x, y = d["position"]["x_m"], d["position"]["y_m"]
            kind = d.get("kind", "")
            c = _node_color(n, kind)
            s = _node_size(n, kind) * 0.6
            marker = "s" if kind == "PALLET_POSITION" else ("D" if n in ALL_OPS else "o")
            ax.scatter(x, y, c=c, s=s, marker=marker, zorder=2, edgecolors="none", alpha=0.6)

        # Station labels
        for n in ALL_OPS:
            if n in pos:
                x, y = pos[n]
                label = "CP" if n in SOUTH_CASEPICK_OPS else "FC"
                ax.annotate(label, (x, y), fontsize=6, color="white", fontweight="bold",
                           ha="center", va="center", zorder=3)

        # Entry/exit
        for n in ALL_ENTRIES:
            if n in pos:
                ax.scatter(*pos[n], c=COLORS["entry"], s=80, marker="^", zorder=4,
                          edgecolors="white", linewidths=0.6)
        for n in ALL_EXITS:
            if n in pos:
                ax.scatter(*pos[n], c=COLORS["exit"], s=80, marker="v", zorder=4,
                          edgecolors="white", linewidths=0.6)

        # Bots at this frame
        active = 0
        for bid in bot_ids:
            p = _bot_pos_at(bid, t)
            if p:
                bx, by, cell = p
                is_service = cell in ALL_OPS
                bc = COLORS["bot_service"] if is_service else COLORS["bot"]
                ax.scatter(bx, by, c=bc, s=140, marker="o", zorder=5,
                          edgecolors="white", linewidths=1.2)
                # Bot ID label
                ax.annotate(str(bid), (bx, by), fontsize=5, color="white",
                           ha="center", va="center", zorder=6)
                active += 1

        ax.set_xlim(min(all_x) - x_pad, max(all_x) + x_pad)
        ax.set_ylim(min(all_y) - y_pad, max(all_y) + y_pad)
        ax.set_aspect("equal")
        ax.set_title(f"Grainger [{layout}]  t={t}s  |  {active}/{len(bot_ids)} bots active  |  "
                     f"PPH={schedule.get('pph', 0):.0f}",
                     color=COLORS["text"], fontsize=11, pad=8)
        ax.tick_params(colors=COLORS["text"], labelsize=7)
        for spine in ax.spines.values():
            spine.set_color("#30363d")

        # Render to PIL Image
        buf = BytesIO()
        fig.savefig(buf, format="png", dpi=100, facecolor=COLORS["background"],
                   bbox_inches="tight")
        plt.close(fig)
        buf.seek(0)
        pil_frames.append(Image.open(buf).copy())

        if (ti + 1) % 50 == 0:
            logger.info("  frame %d/%d", ti + 1, len(times))

    # Save GIF
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration_ms = int(1000 / fps)
    pil_frames[0].save(
        str(output_path),
        save_all=True,
        append_images=pil_frames[1:],
        duration=duration_ms,
        loop=0,
        optimize=True,
    )
    size_mb = output_path.stat().st_size / 1024 / 1024
    logger.info("GIF → %s (%.1f MB, %d frames, %d fps)", output_path, size_mb, len(pil_frames), fps)


def render_animated_schedule(graph, schedule: dict, output_path: Path,
                             layout: str = "", step_s: float = 1.0) -> None:
    """Render an animated HTML showing bots traversing the slice.

    `schedule` is the JSON output from run_sweep's solve_wave_schedule,
    containing `steps` (list of {bot_id, cell_id, start, end, duration}).
    """
    try:
        import plotly.graph_objects as go
    except ImportError:
        logger.error("plotly not installed — pip install plotly")
        return

    # Build node positions
    pos = {n: (d["position"]["x_m"], d["position"]["y_m"])
           for n, d in graph.nodes(data=True)}

    # Parse schedule steps → per-bot timelines
    steps = schedule.get("steps", [])
    if not steps:
        logger.warning("No steps in schedule — skipping animation")
        return

    max_t = max(s["end"] for s in steps)
    bot_ids = sorted(set(s["bot_id"] for s in steps))
    bot_configs = schedule.get("bot_configs", [])

    # For each time step, find where each bot is
    bot_at: dict[int, list[dict]] = {bid: [] for bid in bot_ids}
    for s in steps:
        bot_at[s["bot_id"]].append(s)
    for bid in bot_ids:
        bot_at[bid].sort(key=lambda x: x["start"])

    def _bot_pos_at(bid: int, t: float) -> tuple[float, float, str] | None:
        """Return (x, y, cell_id) for bot at time t, or None if not active."""
        for s in bot_at[bid]:
            if s["start"] <= t < s["end"]:
                cell = s["cell_id"]
                if cell in pos:
                    return (*pos[cell], cell)
        return None

    # Static background
    edge_x, edge_y = [], []
    for u, v in graph.edges():
        x0, y0 = pos[u]; x1, y1 = pos[v]
        edge_x.extend([x0, x1, None]); edge_y.extend([y0, y1, None])

    bg_traces = [
        go.Scatter(x=edge_x, y=edge_y, mode="lines",
                   line=dict(width=0.8, color="rgba(100,120,180,0.25)"),
                   hoverinfo="none", showlegend=False),
    ]

    # Node scatter by kind
    for kind, color, name in [
        ("AISLE_CELL", COLORS["aisle"], "Aisle"),
        ("PALLET_POSITION", COLORS["pallet"], "Pallet"),
        ("STATION_PEZ", COLORS["station_pez"], "PEZ"),
        ("Z_COLUMN", COLORS["z_column"], "Z-Column"),
    ]:
        xs = [pos[n][0] for n, d in graph.nodes(data=True) if d.get("kind") == kind and n in pos]
        ys = [pos[n][1] for n, d in graph.nodes(data=True) if d.get("kind") == kind and n in pos]
        if xs:
            bg_traces.append(go.Scatter(
                x=xs, y=ys, mode="markers", name=name,
                marker=dict(size=5, color=color, opacity=0.5),
                hoverinfo="none",
            ))

    # Station markers
    for ops, color, name in [
        (SOUTH_CASEPICK_OPS, COLORS["casepick_op"], "Casepick (CP)"),
        (EAST_FULLCASE_OPS, COLORS["fullcase_op"], "Full-Case (FC)"),
    ]:
        present = [n for n in ops if n in pos]
        if present:
            bg_traces.append(go.Scatter(
                x=[pos[n][0] for n in present],
                y=[pos[n][1] for n in present],
                mode="markers+text", name=name,
                text=["CP" if n in SOUTH_CASEPICK_OPS else "FC" for n in present],
                textposition="middle center", textfont=dict(size=9, color="white"),
                marker=dict(size=18, color=color, symbol="square", opacity=0.9,
                           line=dict(width=1.5, color="white")),
            ))

    # Entry/exit markers
    for cells, color, symbol, name in [
        (ALL_ENTRIES, COLORS["entry"], "triangle-up", "Entry"),
        (ALL_EXITS, COLORS["exit"], "triangle-down", "Exit"),
    ]:
        present = [n for n in cells if n in pos]
        if present:
            bg_traces.append(go.Scatter(
                x=[pos[n][0] for n in present],
                y=[pos[n][1] for n in present],
                mode="markers", name=name,
                marker=dict(size=12, color=color, symbol=symbol, opacity=0.8,
                           line=dict(width=1, color="white")),
            ))

    # Build animation frames
    times = list(range(0, int(max_t) + 1, int(step_s)))
    frames = []
    for t in times:
        bx, by, bc, bt = [], [], [], []
        for bid in bot_ids:
            p = _bot_pos_at(bid, t)
            if p:
                x, y, cell = p
                bx.append(x); by.append(y)
                is_service = cell in ALL_OPS
                bc.append(COLORS["bot_service"] if is_service else COLORS["bot"])
                # Bot type from config
                btype = ""
                if bid < len(bot_configs):
                    btype = bot_configs[bid].get("type", "")
                bt.append(f"Bot {bid} ({btype})" if btype else f"Bot {bid}")
        frames.append(go.Frame(
            data=[go.Scatter(
                x=bx, y=by, mode="markers+text",
                text=bt, textposition="top center",
                textfont=dict(size=7, color="white"),
                marker=dict(size=14, color=bc, symbol="circle",
                           line=dict(width=1.5, color="white")),
                showlegend=False,
            )],
            name=str(t),
            layout=go.Layout(
                annotations=[dict(
                    text=f"t = {t}s | {len([x for x in bx if x])} bots active",
                    xref="paper", yref="paper", x=0.5, y=1.02,
                    showarrow=False, font=dict(size=13, color="white"),
                )]
            ),
        ))

    # Initial frame
    init_data = bg_traces + [go.Scatter(
        x=[], y=[], mode="markers", showlegend=False,
        marker=dict(size=14, color=COLORS["bot"]),
    )]

    fig = go.Figure(data=init_data, frames=frames)

    # Playback controls
    fig.update_layout(
        updatemenus=[dict(
            type="buttons", showactive=False,
            x=0.05, y=-0.05,
            buttons=[
                dict(label="Play", method="animate",
                     args=[None, dict(frame=dict(duration=80, redraw=True),
                                      fromcurrent=True, transition=dict(duration=0))]),
                dict(label="Pause", method="animate",
                     args=[[None], dict(frame=dict(duration=0, redraw=False),
                                        mode="immediate")]),
            ],
        )],
        sliders=[dict(
            active=0, yanchor="top", xanchor="left",
            currentvalue=dict(prefix="Time: ", suffix="s", visible=True, font=dict(color="white")),
            pad=dict(b=10, t=50),
            len=0.9, x=0.05, y=0,
            steps=[dict(args=[[str(t)], dict(frame=dict(duration=80, redraw=True),
                                             mode="immediate")],
                       method="animate", label=str(t))
                  for t in times[::max(1, len(times)//50)]],  # cap slider ticks
        )],
        template="plotly_dark",
        title=dict(text=f"Grainger Pilot — Bot Flow [{layout}]  "
                       f"({len(bot_ids)} bots, {schedule.get('waves', 1)} waves)",
                  font=dict(size=15)),
        xaxis=dict(title="x (m)", scaleanchor="y"),
        yaxis=dict(title="y (m)"),
        width=1100, height=800,
        margin=dict(l=60, r=20, t=60, b=80),
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.write_html(str(output_path), include_plotlyjs="cdn")
    logger.info("Animation → %s (%d frames, %d bots)", output_path, len(frames), len(bot_ids))


def run_demo_solve(layout: str, n_bots: int, seed: int = 1) -> dict:
    """Quick CP-SAT solve returning a schedule dict with steps + bot_configs."""
    import random
    from run_sweep import (
        build_station_groups, build_bots, solve_wave_schedule,
        extract_south_zone, DEFAULT_UNLOADED, DEFAULT_LOADED,
    )
    here = Path(__file__).resolve().parent
    repo_root = next(p for p in here.parents if (p / ".git").exists())
    candidates = [
        repo_root / "projects" / "grainger_pilot" / "maps" / f"grainger-pilot-{layout}.json",
        repo_root / f"grainger-pilot-{layout}.json",
    ]
    gpath = next((c for c in candidates if c.exists()), candidates[0])
    graph = extract_south_zone(str(gpath))
    station_groups = build_station_groups(layout)
    rng = random.Random(seed)
    bots = build_bots(graph, station_groups, n_bots, DEFAULT_UNLOADED, DEFAULT_LOADED, rng)

    from ortools.sat.python import cp_model
    res_raw = solve_wave_schedule(bots, waves=2, time_buffer_s=2, seed=seed, max_time_s=15.0)
    if res_raw is None:
        logger.error("Demo solve INFEASIBLE for %s n=%d", layout, n_bots)
        return {}

    # Reconstruct steps from the solver (we need to re-solve and extract values)
    # For simplicity, build synthetic event steps from bot plans + wave offset
    wo = res_raw.get("wave_offset_s", res_raw.get("makespan_s", 300))
    pph = n_bots * 3600.0 / wo if wo > 0 else 0
    steps = []
    for w in range(2):
        t_off = w * wo
        for b in bots:
            t = t_off
            for j, (cell, dur) in enumerate(zip(b.cells, b.durations)):
                steps.append({
                    "bot_id": b.bot_id + w * len(bots),
                    "cell_id": cell,
                    "start": int(t),
                    "end": int(t + dur),
                    "duration": dur,
                })
                t += dur

    return {
        "steps": steps,
        "waves": 2,
        "wave_offset_s": wo,
        "pph": pph,
        "bots": n_bots,
        "bot_configs": [{"type": b.pick_type, "station": b.station_op} for b in bots] * 2,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--layout", default="Scp", choices=["Scp", "Ep-Sc"])
    ap.add_argument("--output", default="output/viz/")
    ap.add_argument("--schedule", default=None, help="Schedule JSON (from solver)")
    ap.add_argument("--demo", action="store_true", help="Run a quick solve and animate")
    ap.add_argument("--bots", type=int, default=6, help="Bot count for demo solve")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    out = Path(args.output)

    graph = load_slice_graph(args.layout)

    # Always produce static slice
    render_static_slice(graph, out / f"slice_{args.layout}.png", layout=args.layout)

    # Animate if schedule provided or demo mode
    schedule = None
    if args.schedule:
        with open(args.schedule) as f:
            schedule = json.load(f)
    elif args.demo:
        logger.info("Running demo solve: %s n=%d seed=%d", args.layout, args.bots, args.seed)
        schedule = run_demo_solve(args.layout, args.bots, args.seed)

    if schedule and schedule.get("steps"):
        # GIF (uploadable)
        render_gif(graph, schedule,
                   out / f"anim_{args.layout}.gif",
                   layout=args.layout, step_s=2.0, fps=8)
        # Interactive HTML (local viewing)
        render_animated_schedule(graph, schedule,
                                out / f"anim_{args.layout}.html",
                                layout=args.layout)


if __name__ == "__main__":
    main()
