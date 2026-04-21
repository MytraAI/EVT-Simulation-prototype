"""Config-driven graph slicing for the station-subsystem solver.

Replaces hardcoded extract_south_zone() / extract_casepick_slice() with a
generic extract_subgraph() that reads from SliceSpec config.

Usage:
    from config_schema import load_config
    from graph_slice import extract_subgraph

    cfg = load_config("configs/grainger_scp.yaml")
    graph = extract_subgraph(cfg.slice.graph_path, cfg.slice.slice)
"""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx

from config_schema import GridFilter, SliceSpec


def extract_subgraph(graph_path: str | Path, slice_spec: SliceSpec) -> nx.Graph:
    """Extract a subgraph from a warehouse graph JSON based on the slice spec.

    Dispatches on slice_spec.method:
      "full"        — load the entire graph, no filtering
      "grid_filter"  — filter by level, grid_x, grid_y ranges
      "node_list"   — include only explicitly listed node IDs
    """
    method = slice_spec.method
    if method == "full":
        return _load_full(graph_path)
    elif method == "grid_filter":
        return _load_grid_filter(graph_path, slice_spec.filter or GridFilter())
    elif method == "node_list":
        return _load_node_list(graph_path, slice_spec.node_list or [])
    else:
        raise ValueError(f"unknown slice method: {method!r}")


def _load_full(graph_path: str | Path) -> nx.Graph:
    """Load the entire graph with no filtering."""
    with open(graph_path) as f:
        data = json.load(f)
    G = nx.Graph()
    for n in data["nodes"]:
        G.add_node(n["id"], kind=n["kind"], position=n["position"],
                   level=n.get("level", 1))
    for e in data["edges"]:
        G.add_edge(e["a"], e["b"], edge_id=e["id"],
                   axis=e["axis"], distance_m=e["distance_m"])
    return G


def _load_grid_filter(graph_path: str | Path, filt: GridFilter) -> nx.Graph:
    """Filter nodes by level and grid coordinate ranges."""
    with open(graph_path) as f:
        data = json.load(f)

    keep: set[str] = set()
    G = nx.Graph()
    for n in data["nodes"]:
        if not _node_passes_filter(n, filt):
            continue
        keep.add(n["id"])
        G.add_node(n["id"], kind=n["kind"], position=n["position"],
                   level=n.get("level", 1))
    for e in data["edges"]:
        if e["a"] in keep and e["b"] in keep:
            G.add_edge(e["a"], e["b"], edge_id=e["id"],
                       axis=e["axis"], distance_m=e["distance_m"])
    return G


def _node_passes_filter(node: dict, filt: GridFilter) -> bool:
    """Check if a node passes the grid filter criteria."""
    if filt.level is not None and node.get("level", 1) != filt.level:
        return False
    if filt.grid_x is not None:
        x = node.get("x", 0)
        if "min" in filt.grid_x and x < filt.grid_x["min"]:
            return False
        if "max" in filt.grid_x and x > filt.grid_x["max"]:
            return False
    if filt.grid_y is not None:
        y = node.get("y", 0)
        if "min" in filt.grid_y and y < filt.grid_y["min"]:
            return False
        if "max" in filt.grid_y and y > filt.grid_y["max"]:
            return False
    return True


def _load_node_list(graph_path: str | Path, node_ids: list[str]) -> nx.Graph:
    """Include only explicitly listed node IDs."""
    with open(graph_path) as f:
        data = json.load(f)

    keep = set(node_ids)
    G = nx.Graph()
    for n in data["nodes"]:
        if n["id"] in keep:
            G.add_node(n["id"], kind=n["kind"], position=n["position"],
                       level=n.get("level", 1))
    for e in data["edges"]:
        if e["a"] in keep and e["b"] in keep:
            G.add_edge(e["a"], e["b"], edge_id=e["id"],
                       axis=e["axis"], distance_m=e["distance_m"])
    return G
