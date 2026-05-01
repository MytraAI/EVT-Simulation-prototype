#!/usr/bin/env python3
"""Render top-down layout diagrams for Samsung v1 and v2 station slices.

Each slice is drawn as a labelled grid: PEZ, OP, XY, aisle, Z-column,
pallet, with the spawn cells highlighted. Output: a single side-by-side
PNG suitable for embedding in the Notion doc.
"""
from __future__ import annotations
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt

HERE = Path(__file__).parent
ASSETS = HERE / "assets"

KIND_STYLE = {
    "STATION_PEZ":     {"face": "#fbb1bd", "edge": "#a3133a", "label": "PEZ"},
    "STATION_OP":      {"face": "#a4c8ff", "edge": "#1f4e98", "label": "OP"},
    "STATION_XY":      {"face": "#ffe0a3", "edge": "#a06200", "label": "XY"},
    "AISLE_CELL":      {"face": "#e8e8e8", "edge": "#888888", "label": "a"},
    "Z_COLUMN":        {"face": "#cdb4f6", "edge": "#5c2db5", "label": "Z"},
    "PALLET_POSITION": {"face": "#dff5d8", "edge": "#3d8a2e", "label": "p"},
}

SPAWN_CELLS = {"a-1-3-4", "a-1-5-1", "a-1-7-4", "a-1-9-2", "a-1-7-2"}


def short_label(node: dict) -> str:
    """Compact label for inside-cell text."""
    nid = node["id"]
    kind = node["kind"]
    if kind == "STATION_PEZ":
        return "PEZ"
    if kind == "STATION_OP":
        return "OP"
    if kind == "STATION_XY":
        return "XY"
    if kind == "Z_COLUMN":
        return "Z"
    if kind == "AISLE_CELL":
        return "a"
    return "p"


def draw_slice(ax, graph_path: Path, title: str, station_chain: list[dict]) -> None:
    g = json.load(open(graph_path))
    nodes = g["nodes"]

    # Pallet columns: collapse multi-row pallets at same (x, y) into a single block
    pallet_xy = {}
    for n in nodes:
        if n["kind"] == "PALLET_POSITION":
            pallet_xy.setdefault((n["x"], n["y"]), []).append(n)

    # Bounds
    xs = [n["x"] for n in nodes if n.get("x") is not None]
    ys = [n["y"] for n in nodes if n.get("y") is not None]
    x_min, x_max = min(xs) - 1, max(xs) + 1
    y_min, y_max = min(ys) - 1, max(ys) + 1

    # Cell size in axis units
    w, h = 0.9, 0.9

    # Track which pallet cells we've drawn to avoid duplicates
    drawn_pallets = set()

    for n in nodes:
        x = n.get("x")
        y = n.get("y")
        if x is None or y is None:
            continue
        kind = n["kind"]

        # Collapse identical-position pallets
        if kind == "PALLET_POSITION":
            if (x, y) in drawn_pallets:
                continue
            drawn_pallets.add((x, y))

        style = KIND_STYLE[kind]
        rect = mpatches.Rectangle(
            (x - w / 2, y - h / 2), w, h,
            facecolor=style["face"], edgecolor=style["edge"],
            linewidth=1.2,
        )
        ax.add_patch(rect)

        # Highlight spawn cells with a thicker red border
        if n["id"] in SPAWN_CELLS:
            spawn_rect = mpatches.Rectangle(
                (x - w / 2 - 0.06, y - h / 2 - 0.06),
                w + 0.12, h + 0.12,
                facecolor="none", edgecolor="#d62728",
                linewidth=2.2, linestyle="--",
            )
            ax.add_patch(spawn_rect)

        # Cell text
        ax.text(x, y, short_label(n), ha="center", va="center",
                fontsize=7, color="#222")

    # Station chain labels (bottom)
    for stn in station_chain:
        sx = stn["x"]
        ax.text(sx, y_min + 0.1, stn["label"],
                ha="center", va="bottom", fontsize=8, fontweight="bold",
                color="#1f4e98")

    # Y axis labels showing row number
    for y in range(y_min + 1, y_max):
        ax.text(x_min + 0.3, y, f"y={y}", ha="left", va="center",
                fontsize=7, color="#666")

    ax.set_xlim(x_min, x_max)
    ax.set_ylim(y_min, y_max)
    ax.set_aspect("equal")
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.set_xticks(range(x_min + 1, x_max))
    ax.set_yticks([])
    ax.set_xlabel("grid x")
    ax.tick_params(axis="x", labelsize=7)
    ax.grid(False)


def main():
    fig, axes = plt.subplots(2, 1, figsize=(12, 9),
                              gridspec_kw={"hspace": 0.25})

    v1_chain = [
        {"x": 1, "label": "PEZ-1"}, {"x": 2, "label": "Stn 1\nop-2"},
        {"x": 4, "label": "Stn 2\nop-4"}, {"x": 6, "label": "Stn 3\nop-6"},
        {"x": 8, "label": "Stn 4\nop-8"}, {"x": 10, "label": "PEZ-10"},
    ]
    v2_chain = [
        {"x": -3, "label": "PEZ--3"}, {"x": -2, "label": "Stn 1\nop--2"},
        {"x": 2, "label": "Stn 2\nop-2"}, {"x": 4, "label": "PEZ-4"},
        {"x": 6, "label": "Stn 3\nop-6"}, {"x": 8, "label": "PEZ-8\n(shared)"},
        {"x": 10, "label": "Stn 4\nop-10"},
    ]

    draw_slice(axes[0], HERE / "samsung_station_slice.json",
               "v1 — Compact chain (4 OP, 4 XY, 4 PEZ)", v1_chain)
    draw_slice(axes[1], HERE / "samsung_station_slice_v2.json",
               "v2 — Wide chain (4 OP, 9 XY, 3 PEZ — Stns 3&4 share pez-8-0)",
               v2_chain)

    # Combined legend
    legend_handles = [
        mpatches.Patch(facecolor=KIND_STYLE["STATION_OP"]["face"],
                       edgecolor=KIND_STYLE["STATION_OP"]["edge"], label="OP (operator pick cell)"),
        mpatches.Patch(facecolor=KIND_STYLE["STATION_XY"]["face"],
                       edgecolor=KIND_STYLE["STATION_XY"]["edge"], label="XY (gateway)"),
        mpatches.Patch(facecolor=KIND_STYLE["STATION_PEZ"]["face"],
                       edgecolor=KIND_STYLE["STATION_PEZ"]["edge"], label="PEZ (tray drop)"),
        mpatches.Patch(facecolor=KIND_STYLE["AISLE_CELL"]["face"],
                       edgecolor=KIND_STYLE["AISLE_CELL"]["edge"], label="aisle"),
        mpatches.Patch(facecolor=KIND_STYLE["Z_COLUMN"]["face"],
                       edgecolor=KIND_STYLE["Z_COLUMN"]["edge"], label="Z-column"),
        mpatches.Patch(facecolor=KIND_STYLE["PALLET_POSITION"]["face"],
                       edgecolor=KIND_STYLE["PALLET_POSITION"]["edge"], label="pallet"),
        mpatches.Patch(facecolor="none", edgecolor="#d62728", linewidth=2,
                       linestyle="--", label="spawn point (entry/exit)"),
    ]
    fig.legend(handles=legend_handles, loc="upper center", ncol=7,
               bbox_to_anchor=(0.5, 0.02), frameon=False, fontsize=9)

    fig.suptitle("Samsung station slice layouts — v1 vs v2", fontsize=14, y=0.99)
    fig.tight_layout(rect=(0, 0.04, 1, 0.97))

    out = ASSETS / "samsung_station_layouts.png"
    fig.savefig(out, dpi=140, bbox_inches="tight")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
