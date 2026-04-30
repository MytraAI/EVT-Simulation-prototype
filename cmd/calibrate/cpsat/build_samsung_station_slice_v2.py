#!/usr/bin/env python3
"""Build a v2 station slice analogous to samsung_station_slice.json (v1).

Slice extent:
  - Level 1 only
  - y ∈ [-1..4] (5-row deep zone around stations)
  - x ∈ [-4..10] (full v2 width including west x=-4 column)

Includes v2 stations (4 OP / 9 XY / 3 PEZ) and 2 Z-column entry points
at (3,4) and (7,2).

Applies PEZ↔adjacent-aisle/pallet patches matching the v1 slice convention:
  - pez--3--1 ↔ p-1-0--4-1 (1.78m) — west PEZ to leftmost pallet column
  - pez-4-0   ↔ a-1-3-0, a-1-5-0   — natural aisle adjacency
  - pez-8-0   ↔ a-1-7-0, a-1-9-0   — natural aisle adjacency
"""
from __future__ import annotations
import copy
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "samsung_full_p1_v2.json"
DST = HERE / "samsung_station_slice_v2.json"

Y_MIN = -1
Y_MAX = 4
KEEP_KINDS = {
    "STATION_OP", "STATION_XY", "STATION_PEZ",
    "AISLE_CELL", "Z_COLUMN", "PALLET_POSITION",
}


def add_edge(g: dict, a: str, b: str, axis: str, dist: float) -> bool:
    eid = f"{a}-{b}"
    eid_rev = f"{b}-{a}"
    existing = {e["id"] for e in g["edges"]}
    if eid in existing or eid_rev in existing:
        return False
    g["edges"].append({
        "a": a, "b": b, "axis": axis,
        "distance_m": dist, "id": eid,
        "max_pallet_height_m": 1.8288,
    })
    return True


def main() -> None:
    src = json.load(open(SRC))

    keep_ids: set[str] = set()
    out_nodes: list[dict] = []
    for n in src["nodes"]:
        if n.get("level") != 1:
            continue
        if n["kind"] not in KEEP_KINDS:
            continue
        y = n.get("y")
        if y is None or y < Y_MIN or y > Y_MAX:
            continue
        keep_ids.add(n["id"])
        out_nodes.append(copy.deepcopy(n))

    out_edges = [
        copy.deepcopy(e) for e in src["edges"]
        if e["a"] in keep_ids and e["b"] in keep_ids
    ]

    g = {"nodes": out_nodes, "edges": out_edges, "metadata": src.get("metadata", {})}

    # Apply PEZ patches (only those whose endpoints are in the slice)
    patches = [
        # west PEZ → leftmost pallet column (matches v2 convention)
        ("pez--3--1", "p-1-0--4-1", "y", 1.78),
    ]
    for a, b, axis, dist in patches:
        if a in keep_ids and b in keep_ids:
            added = add_edge(g, a, b, axis, dist)
            if added:
                print(f"  patched: {a} ↔ {b} ({axis}, {dist}m)")

    # Verify natural aisle adjacency for the y=0 PEZs (pez-4-0, pez-8-0)
    # and check whether adjacency edges already exist.
    natural_pez_aisle = [
        ("pez-4-0", "a-1-3-0", "x", 1.57),
        ("pez-4-0", "a-1-5-0", "x", 1.57),
        ("pez-8-0", "a-1-7-0", "x", 1.57),
        ("pez-8-0", "a-1-9-0", "x", 1.57),
    ]
    for a, b, axis, dist in natural_pez_aisle:
        if a in keep_ids and b in keep_ids:
            if add_edge(g, a, b, axis, dist):
                print(f"  added natural adjacency: {a} ↔ {b}")

    # Summary
    by_kind = Counter(n["kind"] for n in g["nodes"])
    levels = sorted(set(n.get("level", 0) for n in g["nodes"]))
    z_edges = [e for e in g["edges"] if e.get("axis") == "z"]
    print(f"\n== samsung_station_slice_v2 ==")
    print(f"  nodes={len(g['nodes'])}, edges={len(g['edges'])}")
    print(f"  by_kind={dict(by_kind)}")
    print(f"  levels={levels}, z-edges={len(z_edges)}")

    # Verify PEZ connectivity
    from collections import defaultdict
    nbrs = defaultdict(list)
    for e in g["edges"]:
        nbrs[e["a"]].append(e["b"])
        nbrs[e["b"]].append(e["a"])
    pez_ids = {n["id"] for n in g["nodes"] if n["kind"] == "STATION_PEZ"}
    aisle_ids = {n["id"] for n in g["nodes"] if n["kind"] == "AISLE_CELL"}
    pallet_ids = {n["id"] for n in g["nodes"] if n["kind"] == "PALLET_POSITION"}
    for pid in sorted(pez_ids):
        nbs = nbrs[pid]
        types = []
        for n in nbs:
            if n in aisle_ids: types.append(f"aisle:{n}")
            elif n in pallet_ids: types.append(f"pallet:{n}")
            elif n in pez_ids: types.append(f"pez:{n}")
            else: types.append(f"station:{n}")
        print(f"  {pid} → {types}")

    json.dump(g, open(DST, "w"), indent=2)
    print(f"\n  wrote {DST}")


if __name__ == "__main__":
    main()
