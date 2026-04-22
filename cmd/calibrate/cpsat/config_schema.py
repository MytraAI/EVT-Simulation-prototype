"""Config schema for the station-subsystem capacity solver.

Provides dataclass definitions and YAML loading with deep-merge support.
Configs are layered: base ← site ← experiment ← CLI overrides.

Usage:
    cfg = load_config("configs/grainger_scp.yaml", "configs/sweep_default.yaml")
    errors = validate_config(cfg, graph)
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml


# ── Dataclasses ──

@dataclass
class GridFilter:
    level: int | None = None
    grid_x: dict[str, int] | None = None   # {"min": 5, "max": 20}
    grid_y: dict[str, int] | None = None   # {"max": 12}


@dataclass
class SliceSpec:
    method: str = "grid_filter"  # "grid_filter" | "node_list" | "full"
    filter: GridFilter | None = None
    node_list: list[str] | None = None


@dataclass
class StationDef:
    op: str = ""
    xy: str = ""
    pez: str | None = None
    pallet_chain: list[str] | None = None
    topology: str = "baseline"  # "baseline" | "leaf" | "direct_access"


@dataclass
class StationGroupConfig:
    label: str = ""
    stations: list[StationDef] = field(default_factory=list)
    entry_points: list[str] = field(default_factory=list)
    exit_points: list[str] = field(default_factory=list)
    pick_type_mix: dict[str, float] = field(default_factory=dict)
    allow_same_entry_exit: bool = False


@dataclass
class ServiceTimeConfig:
    overhead_s: int = 5
    walk_speed_m_s: float = 1.67
    walk_distances: dict[str, float] = field(default_factory=lambda: {"conv": 2.0, "ncv": 3.5})
    pick_times: dict[str, int] = field(default_factory=dict)
    pez_dwell_s: int = 8           # tray drop/exchange time at PEZ cell
    pez_enabled: bool = True       # include PEZ step in outbound cycle
    arrival_clearance_s: int = 0   # operator clears station area while bot arrives (safety penalty)
    empirical: dict[str, str] | None = None  # {"presentation_dist": "path", "sequence_table": "path"}


@dataclass
class SliceConfig:
    graph_path: str = ""
    slice: SliceSpec = field(default_factory=SliceSpec)
    station_groups: list[StationGroupConfig] = field(default_factory=list)
    service_time: ServiceTimeConfig = field(default_factory=ServiceTimeConfig)


@dataclass
class SweepConfig:
    bot_counts: list[int] = field(default_factory=lambda: [4, 6, 8, 10, 12, 16, 20])
    operator_counts: list[int] = field(default_factory=lambda: [1])
    seeds: list[int] = field(default_factory=lambda: [1, 2, 3])
    max_waves: int = 2
    solver_budget_s: float = 15.0
    time_buffer_s: int = 2
    workers: int = 1
    solver_threads: int | None = None
    async_mode: bool = False
    async_cycles: int = 4
    classify_phases: bool = True


@dataclass
class FullConfig:
    slice: SliceConfig = field(default_factory=SliceConfig)
    sweep: SweepConfig = field(default_factory=SweepConfig)


# ── YAML loading + deep merge ──

def deep_merge(base: dict, override: dict) -> dict:
    """Recursive dict merge. Lists replace (not append). Scalars overwrite."""
    result = copy.deepcopy(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = copy.deepcopy(v)
    return result


def _dict_to_dataclass(cls, data: Any) -> Any:
    """Recursively instantiate a dataclass from a dict."""
    if data is None:
        return cls() if hasattr(cls, "__dataclass_fields__") else None
    if not hasattr(cls, "__dataclass_fields__"):
        return data
    if not isinstance(data, dict):
        return data

    # Resolve string annotations (from `from __future__ import annotations`)
    import typing
    try:
        hints = typing.get_type_hints(cls)
    except Exception:
        hints = {}

    kwargs = {}
    for f in fields(cls):
        raw = data.get(f.name)
        if raw is None:
            continue
        ft = hints.get(f.name, f.type)
        # Unwrap Optional / Union types: extract the first non-NoneType arg
        # Python 3.10+ uses types.UnionType for X | Y; older uses typing.Union
        import types as _types
        origin = getattr(ft, "__origin__", None)
        if origin is typing.Union or isinstance(ft, _types.UnionType):
            args = [a for a in getattr(ft, "__args__", ()) if a is not type(None)]
            if args:
                ft = args[0]
                origin = getattr(ft, "__origin__", None)
        # Handle list[StationDef], list[StationGroupConfig], etc.
        if origin is list and raw is not None:
            args = getattr(ft, "__args__", ())
            if args and hasattr(args[0], "__dataclass_fields__"):
                kwargs[f.name] = [_dict_to_dataclass(args[0], item) for item in raw]
            else:
                kwargs[f.name] = raw
        elif hasattr(ft, "__dataclass_fields__"):
            kwargs[f.name] = _dict_to_dataclass(ft, raw)
        else:
            kwargs[f.name] = raw
    return cls(**kwargs)


def parse_cli_overrides(set_args: list[str] | None) -> dict:
    """Parse --set key=value pairs into a nested dict.

    Examples:
        "sweep.workers=4"       → {"sweep": {"workers": 4}}
        "sweep.bot_counts=[4,8]" → {"sweep": {"bot_counts": [4, 8]}}
    """
    if not set_args:
        return {}
    result: dict = {}
    for s in set_args:
        if "=" not in s:
            continue
        key, val = s.split("=", 1)
        # Try to parse value as Python literal
        import ast
        try:
            val = ast.literal_eval(val)
        except (ValueError, SyntaxError):
            pass  # keep as string
        # Build nested dict from dotted key
        parts = key.split(".")
        d = result
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = val
    return result


def load_config(*paths: str | Path, overrides: dict | None = None,
                config_dir: Path | None = None) -> FullConfig:
    """Load and merge YAML config files, apply overrides, return FullConfig.

    Paths are resolved relative to config_dir (default: CWD).
    The top-level keys expected are: slice, sweep (matching FullConfig fields).
    If a file has keys directly under root (graph_path, station_groups, etc.),
    they're wrapped under 'slice' for convenience.
    """
    merged: dict = {}
    for p in paths:
        p = Path(p)
        if config_dir and not p.is_absolute():
            p = config_dir / p
        with open(p) as f:
            raw = yaml.safe_load(f) or {}
        # Convenience: if top-level has graph_path/station_groups, wrap in 'slice'
        if "graph_path" in raw or "station_groups" in raw:
            slice_keys = {f.name for f in fields(SliceConfig)}
            slice_part = {k: raw.pop(k) for k in list(raw) if k in slice_keys}
            if slice_part:
                raw.setdefault("slice", {}).update(slice_part)
        merged = deep_merge(merged, raw)

    if overrides:
        merged = deep_merge(merged, overrides)

    # Resolve graph_path relative to config_dir or CWD
    cfg = _dict_to_dataclass(FullConfig, merged)
    if cfg.slice.graph_path and config_dir:
        gp = Path(cfg.slice.graph_path)
        if not gp.is_absolute() and not gp.exists():
            resolved = config_dir / gp
            if resolved.exists():
                cfg.slice.graph_path = str(resolved)

    return cfg


# ── Validation ──

def validate_config(cfg: FullConfig, graph=None) -> list[str]:
    """Return a list of error strings. Empty = valid."""
    errors: list[str] = []

    sc = cfg.slice
    if not sc.graph_path:
        errors.append("slice.graph_path is required")
    elif not Path(sc.graph_path).exists():
        errors.append(f"graph not found: {sc.graph_path}")

    if not sc.station_groups:
        errors.append("at least one station_group is required")

    for gi, g in enumerate(sc.station_groups):
        if not g.stations:
            errors.append(f"station_groups[{gi}].stations is empty")
        if not g.entry_points:
            errors.append(f"station_groups[{gi}].entry_points is empty")
        if not g.exit_points:
            errors.append(f"station_groups[{gi}].exit_points is empty")
        mix_sum = sum(g.pick_type_mix.values())
        if g.pick_type_mix and abs(mix_sum - 1.0) > 0.05:
            errors.append(f"station_groups[{gi}].pick_type_mix sums to {mix_sum:.3f} (expected ~1.0)")

    if graph is not None:
        node_set = set(graph.nodes())
        for gi, g in enumerate(sc.station_groups):
            for si, stn in enumerate(g.stations):
                for attr in ("op", "xy"):
                    nid = getattr(stn, attr)
                    if nid and nid not in node_set:
                        errors.append(f"station_groups[{gi}].stations[{si}].{attr}={nid!r} not in graph")
                if stn.pallet_chain:
                    for pc in stn.pallet_chain:
                        if pc not in node_set:
                            errors.append(f"pallet_chain node {pc!r} not in graph")
            for ep in g.entry_points:
                if ep not in node_set:
                    errors.append(f"entry_point {ep!r} not in graph")
            for xp in g.exit_points:
                if xp not in node_set:
                    errors.append(f"exit_point {xp!r} not in graph")

    sw = cfg.sweep
    if not sw.bot_counts:
        errors.append("sweep.bot_counts is empty")

    return errors
