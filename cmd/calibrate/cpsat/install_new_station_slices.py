#!/usr/bin/env python3
"""Install the new station slice representations and apply PEZ-aisle patches.

Source: station_slice_v{1,2}_new.json (downloaded from GCS).
Target: samsung_station_slice.json + samsung_station_slice_v2.json (the slice
files the configs and sweep already reference).

Patches applied (matches the convention from the original 2-level baseline):
  v1:
    - pez-1--1  ↔ p-1-0-0-1   (1.78m, y axis) — west-end PEZ aisle access
    - pez-10--1 ↔ p-1-0-10-0  (1.78m, y axis) — east-end PEZ aisle access
  v2:
    - pez--3--1 ↔ p-1-0--4-1  (1.78m, y axis) — west-end PEZ aisle access
"""
from __future__ import annotations
import copy
import json
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent

V1_PATCHES = [
    ("pez-1--1",  "p-1-0-0-1",  "y", 1.78),
    ("pez-10--1", "p-1-0-10-0", "y", 1.78),
]
V2_PATCHES = [
    ("pez--3--1", "p-1-0--4-1", "y", 1.78),
]


def make_edge(a: str, b: str, axis: str, dist: float) -> dict:
    return {
        "a": a, "b": b, "axis": axis,
        "distance_m": dist,
        "id": f"{a}-{b}",
        "max_pallet_height_m": 1.8288,
    }


def apply_patches(graph: dict, patches: list[tuple[str, str, str, float]],
                  label: str) -> int:
    node_ids = {n["id"] for n in graph["nodes"]}
    existing = {e["id"] for e in graph["edges"]} | {
        f'{e["b"]}-{e["a"]}' for e in graph["edges"]
    }
    added = 0
    for a, b, axis, dist in patches:
        if a not in node_ids or b not in node_ids:
            print(f"  [{label}] skip {a}↔{b}: missing endpoint")
            continue
        eid = f"{a}-{b}"
        if eid in existing:
            print(f"  [{label}] already present: {a}↔{b}")
            continue
        graph["edges"].append(make_edge(a, b, axis, dist))
        existing.add(eid)
        added += 1
        print(f"  [{label}] patched: {a}↔{b}  ({axis}, {dist}m)")
    return added


def report_pez_connectivity(graph: dict, label: str) -> None:
    nbrs = defaultdict(list)
    for e in graph["edges"]:
        nbrs[e["a"]].append(e["b"])
        nbrs[e["b"]].append(e["a"])
    nodes_by_id = {n["id"]: n for n in graph["nodes"]}
    print(f"  [{label}] PEZ connectivity:")
    for n in graph["nodes"]:
        if n["kind"] != "STATION_PEZ":
            continue
        items = []
        for nbr in nbrs[n["id"]]:
            kind = nodes_by_id[nbr]["kind"]
            tag = {"AISLE_CELL": "aisle", "PALLET_POSITION": "pallet",
                   "STATION_OP": "OP", "STATION_XY": "XY",
                   "STATION_PEZ": "PEZ"}.get(kind, kind)
            items.append(f"{nbr} ({tag})")
        print(f"    {n['id']}: {items}")


def install(source: Path, target: Path,
            patches: list[tuple[str, str, str, float]], label: str) -> None:
    print(f"\n== {label}: {source.name} → {target.name} ==")
    g = json.load(open(source))
    n_added = apply_patches(g, patches, label)
    json.dump(g, open(target, "w"), indent=2)
    print(f"  {n_added} edge(s) added; wrote {target}")
    report_pez_connectivity(g, label)


def main():
    install(HERE / "station_slice_v1_new.json",
            HERE / "samsung_station_slice.json",
            V1_PATCHES, label="v1")
    install(HERE / "station_slice_v2_new.json",
            HERE / "samsung_station_slice_v2.json",
            V2_PATCHES, label="v2")


if __name__ == "__main__":
    main()
