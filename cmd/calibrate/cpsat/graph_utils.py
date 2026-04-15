"""Graph loading and kinematic utilities for the Grainger pilot CP-SAT scheduler.

Adapted from loom/projects/tesla_ga1_zone10/station_sim/graph.py.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import networkx as nx


@dataclass(frozen=True)
class BotKinematics:
    """Trapezoidal velocity profile parameters."""
    xy_velocity: float = 1.5   # m/s max cruise
    xy_accel: float = 1.5      # m/s^2 (unloaded default)
    trans_x_to_y: float = 3.9  # axis transition penalties (seconds)
    trans_y_to_x: float = 3.9
    trans_y_to_z: float = 3.0
    trans_z_to_y: float = 3.0


DEFAULT_UNLOADED = BotKinematics(xy_velocity=1.5, xy_accel=1.5)
DEFAULT_LOADED = BotKinematics(xy_velocity=1.5, xy_accel=0.3)


def trapezoidal_time(distance_m: float, v_max: float, accel: float) -> float:
    """Time for trapezoidal velocity profile over distance_m."""
    if distance_m <= 0:
        return 0.0
    d_accel = v_max ** 2 / accel
    if distance_m < d_accel:
        return 2.0 * math.sqrt(distance_m / accel)
    else:
        t_accel = v_max / accel
        d_cruise = distance_m - d_accel
        t_cruise = d_cruise / v_max
        return 2.0 * t_accel + t_cruise


def edge_travel_time(
    distance_m: float, axis: str, prev_axis: str | None, kin: BotKinematics
) -> float:
    """Kinematic travel time for a single edge including transition penalty."""
    base = trapezoidal_time(distance_m, kin.xy_velocity, kin.xy_accel)
    penalty = 0.0
    if prev_axis is not None and prev_axis != axis:
        key = f"trans_{prev_axis}_to_{axis}"
        penalty = getattr(kin, key, 0.0)
    return base + penalty


def path_travel_time(G: nx.Graph, path: list[str], kin: BotKinematics) -> float:
    """Total travel time along a path."""
    total = 0.0
    prev_axis = None
    for i in range(len(path) - 1):
        edata = G.edges[path[i], path[i + 1]]
        total += edge_travel_time(edata["distance_m"], edata["axis"], prev_axis, kin)
        prev_axis = edata["axis"]
    return total


def load_graph(path: str | Path) -> nx.Graph:
    """Load Grainger pilot graph JSON into NetworkX."""
    with open(path) as f:
        data = json.load(f)

    G = nx.Graph()
    for node in data["nodes"]:
        G.add_node(node["id"], kind=node["kind"], position=node["position"],
                    level=node.get("level", 1))
    for edge in data["edges"]:
        G.add_edge(edge["a"], edge["b"], edge_id=edge["id"],
                    axis=edge["axis"], distance_m=edge["distance_m"])
    return G


def shortest_path(G: nx.Graph, source: str, target: str) -> list[str]:
    """Shortest path by hop count."""
    return nx.shortest_path(G, source, target)


def find_nodes_by_kind(G: nx.Graph, kind: str) -> list[str]:
    return [n for n, d in G.nodes(data=True) if d.get("kind") == kind]


# ── Grainger-specific station topology ──

NORTH_STATIONS = [
    {"xy": "xy-3-0",  "op": "op-4-0",  "pez": "pez-2-0",  "aisle_entry": "a-1-3-1"},
    {"xy": "xy-7-0",  "op": "op-8-0",  "pez": "pez-6-0",  "aisle_entry": "a-1-7-1"},
    {"xy": "xy-11-0", "op": "op-12-0", "pez": "pez-10-0", "aisle_entry": "a-1-11-1"},
    {"xy": "xy-15-0", "op": "op-16-0", "pez": "pez-14-0", "aisle_entry": "a-1-15-1"},
]

SOUTH_STATIONS = [
    {"xy": "xy-3-46",  "op": "op-4-46",  "pez": "pez-2-46",  "aisle_entry": "a-1-3-45"},
    {"xy": "xy-7-46",  "op": "op-8-46",  "pez": "pez-6-46",  "aisle_entry": "a-1-7-45"},
    {"xy": "xy-11-46", "op": "op-12-46", "pez": "pez-10-46", "aisle_entry": "a-1-11-45"},
    {"xy": "xy-15-46", "op": "op-16-46", "pez": "pez-14-46", "aisle_entry": "a-1-15-45"},
]

# South station zone slice (ground floor, rows 38-46)
# Stations with their XY/OP/PEZ cells — entry/exit points chosen by solver
SOUTH_ZONE_STATIONS = [
    {"xy": "xy-3-46",  "op": "op-4-46",  "pez": "pez-2-46"},
    {"xy": "xy-7-46",  "op": "op-8-46",  "pez": "pez-6-46"},
    {"xy": "xy-11-46", "op": "op-12-46", "pez": "pez-10-46"},
    {"xy": "xy-15-46", "op": "op-16-46", "pez": "pez-14-46"},
]

# Slice extents: 2 travel rows (44-45) + 10 buffer rows (34-43) + station row (46) = 13 total
# Boundary row for entry/exit is row 34 (southernmost buffer row).
ZONE_MIN_GY = 34
ZONE_STATION_GY = 46

# Strict one-way north-south aisle enforcement.
# Full-length aisles (rows 34-45) alternate as ENTRY or EXIT:
#   x=3  ENTRY (southbound toward stations)
#   x=7  EXIT  (northbound away from stations)
#   x=11 ENTRY
#   x=13 EXIT
#   x=17 ENTRY
# Short aisles at rows 44-45 (x=1,5,9,15,19) are travel zone only — not entry/exit.
# Z-columns (a-1-1-46, a-1-19-46) can be EITHER direction.
ZONE_ENTRY_POINTS = [
    f"a-1-3-{ZONE_MIN_GY}",  f"a-1-11-{ZONE_MIN_GY}", f"a-1-17-{ZONE_MIN_GY}",  # entry aisles at boundary
    "a-1-1-46",  "a-1-19-46",                                                     # z-columns (either direction)
]
ZONE_EXIT_POINTS = [
    f"a-1-7-{ZONE_MIN_GY}",  f"a-1-13-{ZONE_MIN_GY}",  # exit aisles at boundary
    "a-1-1-46",  "a-1-19-46",                           # z-columns (either direction)
]


# Casepick slice: eastmost station only (x >= 13), single station for casepick stress test
CASEPICK_SLICE_STATIONS = [
    {"xy": "xy-15-46", "op": "op-16-46", "pez": "pez-14-46"},
]
CASEPICK_ENTRY_POINTS = [
    f"a-1-17-{ZONE_MIN_GY}",   # entry aisle (southbound, at boundary row 34)
    "a-1-19-46",                # z-column SE corner (either direction)
]
CASEPICK_EXIT_POINTS = [
    f"a-1-13-{ZONE_MIN_GY}",   # exit aisle (northbound, shared with neighbor station)
    "a-1-19-46",                # z-column SE corner (either direction)
]


def extract_casepick_slice(graph_path: str | Path, min_gy: int = None, min_gx: int = 13) -> nx.Graph:
    if min_gy is None:
        min_gy = ZONE_MIN_GY
    """Extract the casepick station slice (level 1, grid_y >= min_gy, grid_x >= min_gx)."""
    with open(graph_path) as f:
        data = json.load(f)

    node_ids = set()
    G = nx.Graph()
    for n in data["nodes"]:
        if n.get("level", 1) == 1 and n.get("y", 0) >= min_gy and n.get("x", 0) >= min_gx:
            node_ids.add(n["id"])
            G.add_node(n["id"], kind=n["kind"], position=n["position"],
                        level=n.get("level", 1))
    for e in data["edges"]:
        if e["a"] in node_ids and e["b"] in node_ids:
            G.add_edge(e["a"], e["b"], edge_id=e["id"],
                        axis=e["axis"], distance_m=e["distance_m"])
    return G


def extract_south_zone(graph_path: str | Path, min_gy: int = None) -> nx.Graph:
    """Extract the south station zone subgraph (level 1, grid_y >= min_gy)."""
    if min_gy is None:
        min_gy = ZONE_MIN_GY
    with open(graph_path) as f:
        data = json.load(f)

    node_ids = set()
    G = nx.Graph()
    for n in data["nodes"]:
        if n.get("level", 1) == 1 and n.get("y", 0) >= min_gy:
            node_ids.add(n["id"])
            G.add_node(n["id"], kind=n["kind"], position=n["position"],
                        level=n.get("level", 1))
    for e in data["edges"]:
        if e["a"] in node_ids and e["b"] in node_ids:
            G.add_edge(e["a"], e["b"], edge_id=e["id"],
                        axis=e["axis"], distance_m=e["distance_m"])
    return G
