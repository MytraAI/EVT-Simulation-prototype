#!/usr/bin/env python3
"""Patch the v1 and v2 station slices to add aisle cells in front of every
station and XY at y=0 ('the row in front').

v1 source is missing y=0 cells at x=1, 2 (in front of PEZ-1, op-2).
v2 source is missing y=0 cells at x=-3, -2, -1, 0, 1, 2 (in front of
PEZ--3, op--2, xy--1, xy-0, xy-1, op-2).

For each new aisle cell we add:
  - horizontal edges to its y=0 neighbors (left/right)
  - vertical edges to the y=-1 station cell directly below it
"""
from __future__ import annotations
import copy
import json
from pathlib import Path

HERE = Path(__file__).parent

# Cell size from existing graph metadata: 1.5748m × 1.524m
CELL_X = 1.5748
CELL_Y = 1.524


def make_aisle_cell(x: int, y: int) -> dict:
    return {
        "id": f"a-1-{x}-{y}",
        "kind": "AISLE_CELL",
        "level": 1,
        "position": {
            "x_m": round(1.5748 * (x + 0.5), 4),
            "y_m": round(1.524 * (y + 0.5), 4),
            "z_m": 0,
        },
        "x": x,
        "y": y,
        "size_x_m": CELL_X,
        "size_y_m": CELL_Y,
        "has_charger": False,
        "max_pallet_height_m": 2.7432,
        "max_pallet_mass_kg": 1000,
    }


def make_edge(a: str, b: str, axis: str, dist: float) -> dict:
    return {
        "a": a, "b": b, "axis": axis,
        "distance_m": dist,
        "id": f"{a}-{b}",
        "max_pallet_height_m": 1.8288,
    }


def find_node_at(g: dict, x: int, y: int, kinds: set[str] | None = None) -> str | None:
    for n in g["nodes"]:
        if n.get("level") != 1: continue
        if n.get("x") != x or n.get("y") != y: continue
        if kinds and n["kind"] not in kinds: continue
        return n["id"]
    return None


def patch_slice(slice_path: Path, missing_xs: list[int], out_path: Path) -> None:
    g = json.load(open(slice_path))
    existing_ids = {n["id"] for n in g["nodes"]}
    existing_edges = {e["id"] for e in g["edges"]}

    added_nodes, added_edges = [], []

    for x in missing_xs:
        nid = f"a-1-{x}-0"
        if nid in existing_ids:
            continue
        cell = make_aisle_cell(x, 0)
        g["nodes"].append(cell)
        existing_ids.add(nid)
        added_nodes.append(nid)

    # Now add edges. Iterate over each new aisle and connect it to:
    #  - left neighbor at (x-1, 0) if it exists
    #  - right neighbor at (x+1, 0) if it exists
    #  - cell directly below at (x, -1) if it exists (a station cell)
    new_xs = set(missing_xs)
    for x in missing_xs:
        nid = f"a-1-{x}-0"
        for dx in (-1, 1):
            nbr_x = x + dx
            nbr_id = find_node_at(g, nbr_x, 0)
            if nbr_id is None:
                continue
            eid = f"{nid}-{nbr_id}"
            eid_rev = f"{nbr_id}-{nid}"
            if eid in existing_edges or eid_rev in existing_edges:
                continue
            g["edges"].append(make_edge(nid, nbr_id, "x", CELL_X))
            existing_edges.add(eid)
            added_edges.append((nid, nbr_id))
        # vertical edge to station at (x, -1)
        below_id = find_node_at(g, x, -1)
        if below_id is not None:
            eid = f"{nid}-{below_id}"
            eid_rev = f"{below_id}-{nid}"
            if eid not in existing_edges and eid_rev not in existing_edges:
                g["edges"].append(make_edge(nid, below_id, "y", CELL_Y))
                existing_edges.add(eid)
                added_edges.append((nid, below_id))

    json.dump(g, open(out_path, "w"), indent=2)
    print(f"\n== {slice_path.name} -> {out_path.name} ==")
    print(f"  added {len(added_nodes)} aisle cells: {added_nodes}")
    print(f"  added {len(added_edges)} edges:")
    for a, b in added_edges:
        print(f"    {a} <-> {b}")


def main():
    # v1: gaps at x=1, 2
    patch_slice(HERE / "samsung_station_slice.json",
                missing_xs=[1, 2],
                out_path=HERE / "samsung_station_slice.json")
    # v2: gaps at x=-3, -2, -1, 0, 1, 2
    patch_slice(HERE / "samsung_station_slice_v2.json",
                missing_xs=[-3, -2, -1, 0, 1, 2],
                out_path=HERE / "samsung_station_slice_v2.json")


if __name__ == "__main__":
    main()
