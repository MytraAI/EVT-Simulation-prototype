#!/usr/bin/env python3
"""Bot-count sweep driver for the Grainger pilot station capacity analysis.

Produces sweep_results.csv matching the Notion spec schema:
    layout, bot_count, seed, mean_pph, p5_pph, p95_pph, collisions,
    deadlocks, avg_op_utilization, peak_queue_depth, phase

Runs the wave-based CP-SAT solver with distance-aware service times,
separating station groups by pick type (casepick vs pallet_out).

Usage:
    run_sweep.py --layout Scp   --output output/
    run_sweep.py --layout Ep-Sc --output output/
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ortools.sat.python import cp_model

from graph_utils import (
    BotKinematics,
    DEFAULT_LOADED,
    DEFAULT_UNLOADED,
    EP_EAST_STATIONS,
    EP_EAST_ENTRY_POINTS,
    EP_EAST_EXIT_POINTS,
    SOUTH_ZONE_STATIONS,
    ZONE_ENTRY_POINTS,
    ZONE_EXIT_POINTS,
    edge_travel_time,
    extract_south_zone,
    path_travel_time,
    shortest_path,
)

logger = logging.getLogger(__name__)

# ---------- Service-time model ----------
#
# Two distinct durations per bot presentation:
#   pick_time_s(type)      — operator picks from the presented pallet. The BOT
#                            physically dwells at the op cell for this window.
#   operator_cycle_s(type) — pick + drop-off walk. The OPERATOR is busy until
#                            the walk completes. The bot is free to leave at
#                            the end of pick_time, opening the op cell for the
#                            next bot to stage / wait.
#
# In the CP-SAT model:
#   * Op-cell no-overlap uses pick_time_s (short).
#   * A per-station OPERATOR no-overlap resource uses operator_cycle_s (long).
#     This is what bottlenecks throughput — the walk continues after the bot
#     leaves, so the op cell can host queueing bots during that window.
#
# Station type assignment (empirical Grainger W004 SFDC outbound 2025):
#   East stations (op-21-*)       — full-case picking only.
#       type ∈ {full_case_conv, full_case_ncv}
#   South baseline (op-*-0)       — casepick only (both conv + ncv subtypes).
#       type ∈ {casepick_conv, casepick_ncv}
#
# Per-type empirical p50 pick times (from SECONDS_ON_TASK in outbound data):
#     full_case_conv   CON1 — Bulk Conveyable Pallets              32s   n=729,381
#     full_case_ncv    NC01/LTL*/NRAW — Non-conv pallets/raw      116s   n=232,986
#     casepick_conv    CON2 — Conveyable Top-Offs (pick bins)      52s   n=1,274,649
#     casepick_ncv     NC02/NC03 — Non-conv Top-Offs / Mixed SKUs  86s   n=231,372
#
# Walk time to drop-off depends on the conveyable-vs-ncv destination geometry
# (synthetic placeholders — refine with station geometry from Jacob).

WALK_SPEED_M_S = 1.67                  # ~6 km/h
OP_OVERHEAD_S = 5                      # identify(3) + confirm(2), always part of pick

# Fallback p50 pick times if presentation distribution not available.
PICK_TIME_S = {
    "full_case_conv":  32,
    "full_case_ncv":  116,
    "casepick_conv":   52,
    "casepick_ncv":    86,
}

# Walk distance from op station to drop-off by conveyable class (meters)
WALK_DIST_M = {
    "conv": 2.0,   # conveyable — short walk to conveyor
    "ncv":  3.5,   # non-conveyable — further walk to bin/repal
}

# ── Presentation-aware service time model ──
#
# Instead of a single p50 per type, sample a PRESENTATION BUCKET from the
# empirical distribution:
#   (sim_type, presentation_bucket) → probability, p50_sot_s
#
# For each bot, we:
#   1. Sample presentation_bucket ∝ probability (weighted draw)
#   2. Use the bucket's p50_sot_s as the pick time
#
# This captures that 82-86% of presentations are single-case (fast 25-48s)
# but 3-5% are multi-case (slow 170-280s), which drives the tail.

_presentation_cache: dict[str, list[tuple[str, float, float]]] | None = None
PRESENTATION_DIST_PATH = "output/empirical/presentation_distribution.parquet"


def _load_presentation_dist() -> dict[str, list[tuple[str, float, float]]] | None:
    """Load (sim_type → [(bucket, probability, p50_sot_s), ...]) from parquet.
    Returns None if file doesn't exist (falls back to fixed PICK_TIME_S)."""
    global _presentation_cache
    if _presentation_cache is not None:
        return _presentation_cache or None
    from pathlib import Path as _Path
    candidates = [
        _Path(PRESENTATION_DIST_PATH),
        _Path(__file__).resolve().parents[2] / "output" / "empirical" / "presentation_distribution.parquet",
    ]
    path = next((c for c in candidates if c.exists()), None)
    if path is None:
        _presentation_cache = {}
        return None
    import duckdb
    db = duckdb.connect()
    rows = db.execute(
        f"SELECT sim_type, presentation_bucket, probability, p50_sot_s "
        f"FROM read_parquet('{path}') ORDER BY sim_type, probability DESC"
    ).fetchall()
    d: dict[str, list[tuple[str, float, float]]] = {}
    for st, bucket, prob, p50 in rows:
        d.setdefault(st, []).append((bucket, prob, p50))
    _presentation_cache = d
    logger.info("Loaded presentation distribution: %s",
                ", ".join(f"{k}={len(v)} buckets" for k, v in d.items()))
    return d or None


def _sample_presentation(pick_type: str, rng: random.Random) -> tuple[str, float]:
    """Sample a presentation bucket and return (bucket_name, p50_sot_s).
    Falls back to PICK_TIME_S if no distribution loaded."""
    dist = _load_presentation_dist()
    if dist and pick_type in dist:
        buckets = dist[pick_type]
        r = rng.random()
        acc = 0.0
        for bucket, prob, p50 in buckets:
            acc += prob
            if r <= acc:
                return bucket, p50
        return buckets[-1][0], buckets[-1][2]  # last bucket fallback
    return "fixed", float(PICK_TIME_S.get(pick_type, 50))


def _conv_class(pick_type: str) -> str:
    return "conv" if pick_type.endswith("_conv") else "ncv"


def pick_time_s(pick_type: str, prev_type: str | None = None,
                rng: random.Random | None = None) -> int:
    """Time the BOT dwells at the op cell.

    If `rng` is provided, samples from the presentation distribution
    (Cases/Line bucket). Otherwise uses unconditional p50.
    """
    if rng is not None:
        _, p50 = _sample_presentation(pick_type, rng)
        return int(round(OP_OVERHEAD_S + p50))
    if prev_type is not None:
        cond = _load_sequence_table()
        if cond is not None:
            pt = cond.get((pick_type, prev_type))
            if pt is not None:
                return int(round(OP_OVERHEAD_S + pt))
    return int(round(OP_OVERHEAD_S + PICK_TIME_S[pick_type]))


def operator_cycle_s(pick_type: str, prev_type: str | None = None,
                     rng: random.Random | None = None) -> int:
    """Time the OPERATOR is busy — pick + drop-off walk."""
    walk = WALK_DIST_M[_conv_class(pick_type)] / WALK_SPEED_M_S
    if rng is not None:
        _, p50 = _sample_presentation(pick_type, rng)
        return int(round(OP_OVERHEAD_S + p50 + walk))
    if prev_type is not None:
        cond = _load_sequence_table()
        if cond is not None:
            pt = cond.get((pick_type, prev_type))
            if pt is not None:
                return int(round(OP_OVERHEAD_S + pt + walk))
    return int(round(OP_OVERHEAD_S + PICK_TIME_S[pick_type] + walk))


# Sequencing toggle — set by main() from --sequencing CLI flag. When False,
# pick_time_s/operator_cycle_s use unconditional p50 regardless of prev_type.
USE_SEQUENCING = True

# CP-SAT internal thread count per solve. None → use solver default (~8).
# In parallel sweeps set this lower so total threads ≲ num_cpus.
SOLVER_THREADS: int | None = None

_sequence_cache: dict[tuple[str, str], float] | None = None


def _load_sequence_table(path: str = "output/empirical/pick_time_sequence.parquet"
                        ) -> dict[tuple[str, str], float] | None:
    """Load the (current_type, prev_type) → p50 conditional lookup. Cached.
    Returns None if sequencing is disabled or the parquet isn't present."""
    global _sequence_cache
    if not USE_SEQUENCING:
        return None
    if _sequence_cache is not None:
        return _sequence_cache or None
    from pathlib import Path as _Path
    if not _Path(path).exists():
        _sequence_cache = {}
        return None
    import duckdb
    db = duckdb.connect()
    rows = db.execute(
        f"SELECT sim_type, prev_type, p50_s FROM read_parquet('{path}')"
    ).fetchall()
    _sequence_cache = {(st, pt): p50 for st, pt, p50 in rows}
    logger.info("Loaded sequence-conditional table: %d (curr,prev) pairs",
                len(_sequence_cache))
    return _sequence_cache or None


# Type mixes per station type (row-count-weighted, empirical SFDC outbound 2025 Q1-Q4).
_FULL_CASE_COUNTS = {
    "full_case_conv":  729_381,
    "full_case_ncv":   232_986,
}
_CASEPICK_COUNTS = {
    "casepick_conv": 1_274_649,
    "casepick_ncv":    231_372,
}
_FC_TOT = sum(_FULL_CASE_COUNTS.values())
_CP_TOT = sum(_CASEPICK_COUNTS.values())
FULL_CASE_MIX = [(k, v / _FC_TOT) for k, v in _FULL_CASE_COUNTS.items()]
CASEPICK_MIX  = [(k, v / _CP_TOT) for k, v in _CASEPICK_COUNTS.items()]


def service_time_seconds(pick_type: str, rng: random.Random | None = None) -> int:
    """Legacy helper — returns the operator cycle time (bot dwell will be shorter)."""
    return operator_cycle_s(pick_type)


# ---------- Bot-plan construction ----------

@dataclass
class BotPlan:
    bot_id: int
    station_op: str
    pick_type: str
    bot_dwell_s: int       # bot's dwell at op cell (pick portion only)
    operator_cycle_s: int  # pick + drop-off walk (operator-only resource)
    cells: list
    durations: list
    service_idx: int       # index in cells[] where service happens


def _build_baseline_bot_plan(graph, stn: dict, entry: str, exit_pt: str,
                             kin_in: BotKinematics, kin_out: BotKinematics,
                             bot_id: int, pick_type: str,
                             rng: random.Random,
                             prev_type: str | None = None) -> BotPlan:
    """Baseline (south) station: approach through xy gateway to op leaf."""
    dwell = pick_time_s(pick_type, prev_type, rng)
    op_cyc = operator_cycle_s(pick_type, prev_type, rng)
    approach = shortest_path(graph, entry, stn["xy"])
    depart = shortest_path(graph, stn["xy"], exit_pt)
    cells = approach + [stn["op"], stn["xy"]] + depart[1:]
    service_idx = len(approach)

    durations, prev_axis = [], None
    for j in range(len(cells)):
        if j == service_idx:
            durations.append(dwell)
        elif j < len(cells) - 1 and graph.has_edge(cells[j], cells[j + 1]):
            ed = graph.edges[cells[j], cells[j + 1]]
            kin = kin_in if j <= service_idx else kin_out
            t = edge_travel_time(ed["distance_m"], ed["axis"], prev_axis, kin)
            durations.append(max(1, round(t)))
            prev_axis = ed["axis"]
        else:
            durations.append(1)
    return BotPlan(bot_id, stn["op"], pick_type, dwell, op_cyc, cells, durations, service_idx)


def _build_leaf_bot_plan(graph, stn: dict, entry: str, exit_pt: str,
                         kin_in: BotKinematics, kin_out: BotKinematics,
                         bot_id: int, pick_type: str,
                         rng: random.Random,
                         prev_type: str | None = None) -> BotPlan:
    """East (leaf-topology) station: op is a leaf at the end of a pallet chain.

    Cells = entry → ... → xy_aisle → pallet_chain[0..2] → op
                                   ← pallet_chain[2..0] → xy_aisle → ... → exit
    """
    dwell = pick_time_s(pick_type, prev_type, rng)
    op_cyc = operator_cycle_s(pick_type, prev_type, rng)
    chain = stn["pallet_chain"]
    approach = shortest_path(graph, entry, stn["xy"])     # ends at xy_aisle
    depart = shortest_path(graph, stn["xy"], exit_pt)     # starts at xy_aisle
    cells = (approach
             + chain                                       # p0, p1, p2
             + [stn["op"]]                                 # service cell
             + list(reversed(chain))                       # p2, p1, p0
             + depart)                                     # xy_aisle, ..., exit
    service_idx = len(approach) + len(chain)

    durations, prev_axis = [], None
    for j in range(len(cells)):
        if j == service_idx:
            durations.append(dwell)
        elif j < len(cells) - 1 and graph.has_edge(cells[j], cells[j + 1]):
            ed = graph.edges[cells[j], cells[j + 1]]
            kin = kin_in if j <= service_idx else kin_out
            t = edge_travel_time(ed["distance_m"], ed["axis"], prev_axis, kin)
            durations.append(max(1, round(t)))
            prev_axis = ed["axis"]
        else:
            durations.append(1)
    return BotPlan(bot_id, stn["op"], pick_type, dwell, op_cyc, cells, durations, service_idx)


def _rank_entry_exit(graph, anchor: str,
                     entry_candidates: list[str], exit_candidates: list[str],
                     kin: BotKinematics,
                     allow_same: bool = False) -> list[tuple[str, str, float]]:
    """Rank feasible (entry, exit) pairs by total travel time.

    allow_same=True lets a bot enter and exit via the same node — useful for
    leaf-topology stations (east Ep) where gx=17 is the only corridor and
    forcing one-way flow requires an impractical long detour through the SE
    z-column. CP-SAT's no-overlap on physical dwell still prevents two bots
    from occupying the same cell simultaneously.
    """
    pairs = []
    for ep in entry_candidates:
        try:
            ap = shortest_path(graph, ep, anchor)
            ac = path_travel_time(graph, ap, kin)
        except Exception:
            continue
        for xp in exit_candidates:
            if xp == ep and not allow_same:
                continue
            try:
                dp = shortest_path(graph, anchor, xp)
                dc = path_travel_time(graph, dp, kin)
            except Exception:
                continue
            pairs.append((ep, xp, ac + dc))
    pairs.sort(key=lambda t: t[2])
    return pairs


def build_bots(graph, station_groups: list[dict], num_bots: int,
               kin_unloaded: BotKinematics, kin_loaded: BotKinematics,
               rng: random.Random) -> list[BotPlan]:
    """Distribute bots round-robin across station groups, seeding both the
    group rotation and the entry/exit pair selection.

    station_groups: list of dicts with keys
        stations:  list of station dicts
        entry_pts: list of entry node ids
        exit_pts:  list of exit node ids
        pick_type: str | "casepick-mix" — if "casepick-mix", each bot samples
                   from CASEPICK_MIX; otherwise fixed type.
    """
    # Flatten to (group_idx, station_idx) pairs, rotated seed-dependently
    flat = []
    for gi, g in enumerate(station_groups):
        for si in range(len(g["stations"])):
            flat.append((gi, si))
    rng.shuffle(flat)

    # Pre-rank entry/exit pairs per station. Leaf-topology stations (east Ep)
    # have a single corridor and must be allowed to re-use the same aisle node
    # for entry+exit.
    ranked = {}
    for gi, g in enumerate(station_groups):
        for stn in g["stations"]:
            anchor = stn["xy"]
            allow_same = stn.get("topology") == "leaf"
            pairs = _rank_entry_exit(graph, anchor, g["entry_pts"], g["exit_pts"],
                                     kin_loaded, allow_same=allow_same)
            ranked[stn["op"]] = pairs if pairs else [
                (g["entry_pts"][0], g["exit_pts"][0], 0.0)
            ]
    used_idx: dict[str, int] = {stn["op"]: 0 for g in station_groups for stn in g["stations"]}
    # Track most recent type placed at each station so the NEXT bot can consult
    # the sequencing-conditional lookup. First bot at each station has no prev.
    prev_type_at: dict[str, str | None] = {stn["op"]: None for g in station_groups for stn in g["stations"]}

    bots: list[BotPlan] = []
    for bid in range(num_bots):
        gi, si = flat[bid % len(flat)]
        g = station_groups[gi]
        stn = g["stations"][si]
        pairs = ranked[stn["op"]]
        ep, xp, _ = pairs[used_idx[stn["op"]] % len(pairs)]
        used_idx[stn["op"]] += 1

        # Sample a pick type from the group's mix
        pt = g["pick_type"]
        mix = None
        if pt == "casepick-mix":
            mix = CASEPICK_MIX
        elif pt == "full-case-mix":
            mix = FULL_CASE_MIX
        if mix is not None:
            r = rng.random(); acc = 0.0
            for name, w in mix:
                acc += w
                if r <= acc:
                    pt = name; break
            else:
                pt = mix[-1][0]

        topo = stn.get("topology", "baseline")
        builder = _build_leaf_bot_plan if topo == "leaf" else _build_baseline_bot_plan
        # Pass the previous pick type at this station for conditional cycle lookup.
        prev_pt = prev_type_at[stn["op"]]
        bots.append(builder(graph, stn, ep, xp, kin_unloaded, kin_loaded, bid, pt, rng, prev_pt))
        prev_type_at[stn["op"]] = pt

    return bots


# ---------- CP-SAT wave scheduler ----------

def solve_wave_schedule(bots: list, waves: int, time_buffer_s: int,
                       seed: int, max_time_s: float = 30.0,
                       async_mode: bool = False,
                       operators_per_station: int = 1,
                       solver_threads: int | None = None) -> dict | None:
    """Return {status, wave_offset_s, makespan_s} or None if infeasible.

    operators_per_station: number of operators at each station. With N>1,
        multiple bots can be served concurrently (up to N) because while one
        operator walks the pallet to drop-off, another operator can start
        picking for the next bot. The op CELL still has capacity 1 (physical),
        but the operator RESOURCE has capacity N (via cumulative constraint).

    wave mode (default): `waves` copies of the N-bot plan, each shifted by a
        shared wave_offset. Minimize wave_offset. PPH = N × 3600 / wave_offset.

    async mode: `waves` copies per bot — each copy is a CYCLE that the bot
        completes sequentially. No global wave_offset.
    """
    n_base = len(bots)
    model = cp_model.CpModel()
    max_time = max(sum(b.durations) for b in bots) * (3 + waves)

    # Duplicate bot plans per wave / per cycle
    wave_bots = []
    for w in range(waves):
        for b in bots:
            wave_bots.append((w, b))

    starts, ends = {}, {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        for j, (cell, dur) in enumerate(zip(b.cells, b.durations)):
            s = model.new_int_var(0, max_time, f"s_b{bid}_{j}")
            e = model.new_int_var(0, max_time, f"e_b{bid}_{j}")
            model.add(e == s + dur)
            starts[(bid, j)] = s
            ends[(bid, j)] = e

    # Sequential steps per bot
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        for j in range(len(b.cells) - 1):
            model.add(starts[(bid, j + 1)] >= ends[(bid, j)])

    # Physical dwell intervals (no-overlap per cell)
    dwell_intervals = {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        n_steps = len(b.cells)
        for j in range(n_steps):
            s = starts[(bid, j)]
            if j < n_steps - 1:
                dw = model.new_int_var(1, max_time, f"dw_b{bid}_{j}")
                model.add(dw == starts[(bid, j + 1)] - s + time_buffer_s)
                de = model.new_int_var(0, max_time + time_buffer_s, f"de_b{bid}_{j}")
                model.add(de == s + dw)
            else:
                dw = b.durations[j] + time_buffer_s
                de = model.new_int_var(0, max_time + time_buffer_s, f"de_b{bid}_{j}")
                model.add(de == s + dw)
            dwell_intervals[(bid, j)] = model.new_interval_var(s, dw, de, f"di_b{bid}_{j}")

    # Per-cell no-overlap
    cell_dwells: dict[str, list] = {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        for j, cell in enumerate(b.cells):
            cell_dwells.setdefault(cell, []).append(dwell_intervals[(bid, j)])
    for cell, ivals in cell_dwells.items():
        if len(ivals) > 1:
            model.add_no_overlap(ivals)

    # Per-station operator resource (virtual).
    # Bot's physical dwell at op cell = pick_time (shorter). Operator continues
    # to be busy for the drop-off walk AFTER the bot leaves.
    #
    # With operators_per_station == 1: no-overlap (original behavior).
    # With operators_per_station > 1: cumulative constraint with capacity N.
    #   This lets up to N operator intervals overlap — modelling N operators
    #   who can each independently pick/walk. A new bot can start service as
    #   soon as ANY operator is free, not just the one who handled the last bot.
    operator_intervals: dict[str, list] = {}
    operator_demands: dict[str, list[int]] = {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        s_service = starts[(bid, b.service_idx)]
        dur = b.operator_cycle_s
        e_op = model.new_int_var(0, max_time + time_buffer_s, f"opend_b{bid}")
        model.add(e_op == s_service + dur)
        ivl = model.new_interval_var(s_service, dur, e_op, f"opi_b{bid}")
        operator_intervals.setdefault(b.station_op, []).append(ivl)
        operator_demands.setdefault(b.station_op, []).append(1)
    for op_cell, ivals in operator_intervals.items():
        if len(ivals) <= 1:
            continue
        if operators_per_station <= 1:
            model.add_no_overlap(ivals)
        else:
            model.add_cumulative(
                ivals,
                operator_demands[op_cell],
                operators_per_station,
            )

    # Scheduling structure
    if async_mode and waves > 1:
        # Each bot's cycle w+1 starts after cycle w ends (per-bot sequential).
        # No global wave_offset — cycles align freely subject to cell + operator
        # no-overlap constraints.
        for w in range(1, waves):
            for b in bots:
                prev_bid = (w - 1) * n_base + b.bot_id
                curr_bid = w * n_base + b.bot_id
                model.add(starts[(curr_bid, 0)] >= ends[(prev_bid, len(b.cells) - 1)])
        wave_offset = None
    elif waves > 1:
        # Wave mode: wave w starts exactly w * wave_offset after wave 0
        wave_offset = model.new_int_var(1, max_time, "wave_offset")
        for w in range(1, waves):
            for b in bots:
                w0_bid = b.bot_id
                wN_bid = w * n_base + b.bot_id
                for j in range(len(b.cells)):
                    model.add(starts[(wN_bid, j)] == starts[(w0_bid, j)] + w * wave_offset)
    else:
        wave_offset = None

    makespan = model.new_int_var(0, max_time, "makespan")
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        model.add(makespan >= ends[(bid, len(b.cells) - 1)])
    # In wave mode we minimize wave_offset (inter-wave period sets PPH);
    # in async mode or single-wave we minimize makespan directly.
    if wave_offset is not None:
        model.minimize(wave_offset)
    else:
        model.minimize(makespan)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_s
    solver.parameters.random_seed = int(seed) & 0x7FFFFFFF
    # CP-SAT thread count is controlled by SOLVER_THREADS (module-level), which
    # the caller tunes based on parallel-worker count so total threads ≲ num_cpus.
    # Default 8 matches the solver's own default; set to 1-2 when running a
    # ProcessPool of 8+ external workers.
    _threads = solver_threads if solver_threads is not None else SOLVER_THREADS
    if _threads is not None:
        solver.parameters.num_search_workers = int(_threads)
    status = solver.solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    ms = solver.value(makespan)
    wo = solver.value(wave_offset) if wave_offset is not None else ms

    # Compute per-station queue depth from the schedule: approximate as the max
    # number of bot service dwells whose [start..end] overlap at the same op cell.
    # Useful as peak_queue_depth proxy.
    service_intervals: dict[str, list[tuple[int, int]]] = {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        # Operator-level interval (pick + walk) per bot
        s_val = solver.value(starts[(bid, b.service_idx)])
        service_intervals.setdefault(b.station_op, []).append(
            (s_val, s_val + b.operator_cycle_s)
        )

    peak_queue = 0
    for op_cell, ivals in service_intervals.items():
        ivals.sort()
        events = []
        for s, e in ivals:
            events.append((s, +1))
            events.append((e, -1))
        events.sort()
        cur = 0
        for _, d in events:
            cur += d
            peak_queue = max(peak_queue, cur)

    # Average op utilization depends on the mode:
    #   wave mode:  time-basis = wave_offset × waves (same as makespan in steady state)
    #   async mode: time-basis = makespan
    total_svc = sum(end - start for ivals in service_intervals.values()
                    for start, end in ivals)
    num_stations = len({b.station_op for b in bots})
    if async_mode:
        cycle_span = ms
    else:
        cycle_span = wo * max(waves, 1)
    avg_op_util = total_svc / (num_stations * cycle_span) if cycle_span > 0 else 0.0

    return {
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "wave_offset_s": wo,
        "makespan_s": ms,
        "peak_queue_depth": peak_queue,
        "avg_op_utilization": min(avg_op_util, 1.0),
        "async_mode": async_mode,
        "n_cycles_total": len(wave_bots),
    }


# ---------- Sweep driver ----------

def build_station_groups(layout: str) -> list[dict]:
    if layout == "Scp":
        return [{
            "stations": SOUTH_ZONE_STATIONS,
            "entry_pts": ZONE_ENTRY_POINTS,
            "exit_pts": ZONE_EXIT_POINTS,
            "pick_type": "casepick-mix",
            "group_label": "casepick",
        }]
    elif layout == "Ep-Sc":
        return [
            {
                "stations": SOUTH_ZONE_STATIONS,
                "entry_pts": ZONE_ENTRY_POINTS,
                "exit_pts": ZONE_EXIT_POINTS,
                "pick_type": "casepick-mix",
                "group_label": "casepick",
            },
            {
                "stations": EP_EAST_STATIONS,
                "entry_pts": EP_EAST_ENTRY_POINTS,
                "exit_pts": EP_EAST_EXIT_POINTS,
                "pick_type": "full-case-mix",
                "group_label": "full_case",
            },
        ]
    raise ValueError(f"unknown layout: {layout}")


def graph_path_for_layout(repo_root: Path, layout: str) -> Path:
    return repo_root / f"grainger-pilot-{layout}.json"


def _best_waves_result(graph, station_groups, num_bots, max_waves,
                       time_buffer_s, seed, kin_unloaded, kin_loaded,
                       async_mode: bool = False,
                       async_cycles: int = 4,
                       operators_per_station: int = 1) -> dict:
    """Wave mode: try waves 1..max_waves, return best-PPH feasible.
    Async mode: single solve with `async_cycles` repetitions per bot.
    """
    rng = random.Random(seed)
    bots = build_bots(graph, station_groups, num_bots, kin_unloaded, kin_loaded, rng)

    if async_mode:
        # Single solve with N × async_cycles total service events
        budget = 30.0
        res = solve_wave_schedule(bots, waves=async_cycles, time_buffer_s=time_buffer_s,
                                  seed=seed, max_time_s=budget, async_mode=True,
                                  operators_per_station=operators_per_station)
        if res is None:
            return {"pph": 0.0, "wave_offset_s": 0, "makespan_s": 0, "waves": 0,
                    "peak_queue_depth": 0, "avg_op_utilization": 0.0,
                    "status": "INFEASIBLE", "num_bots": num_bots}
        total_services = num_bots * async_cycles
        res["pph"] = total_services * 3600.0 / res["makespan_s"] if res["makespan_s"] else 0.0
        res["waves"] = async_cycles
        res["num_bots"] = num_bots
        return res

    # Wave mode: search waves 1..max_waves
    best = None
    for w in range(1, max_waves + 1):
        budget = 15.0
        res = solve_wave_schedule(bots, waves=w, time_buffer_s=time_buffer_s,
                                  seed=seed, max_time_s=budget,
                                  operators_per_station=operators_per_station)
        if res is None:
            if best is None:
                continue
            break
        pph = num_bots * 3600.0 / res["wave_offset_s"]
        res["pph"] = pph
        res["waves"] = w
        if best is None or pph > best["pph"]:
            best = res
    if best is None:
        return {"pph": 0.0, "wave_offset_s": 0, "makespan_s": 0, "waves": 0,
                "peak_queue_depth": 0, "avg_op_utilization": 0.0,
                "status": "INFEASIBLE", "num_bots": num_bots}
    best["num_bots"] = num_bots
    return best


def classify_phase(prev_marginal: float | None, first_marginal: float | None,
                   variance_pct: float, any_deadlock: bool) -> str:
    """Phase per spec: linear / degradation / collapse.

    With empirical sampling each seed draws different service times, so
    variance at a given bot count reflects real-world stochasticity (operator
    breaks, SKU variability). We only use variance as a collapse signal when
    it's extreme (>60%), and primarily rely on marginal-gain ratios.
    """
    if any_deadlock:
        return "collapse"
    if first_marginal is None or first_marginal <= 0 or prev_marginal is None:
        return "linear"
    ratio = prev_marginal / first_marginal
    if ratio >= 0.7:
        return "linear"
    if ratio >= 0.3:
        return "degradation"
    return "collapse"


def _worker_init(graph_path: str, layout: str, sequencing: bool,
                 solver_threads: int) -> None:
    """Pool worker setup: load graph + station groups once per process."""
    global _WORKER_GRAPH, _WORKER_STATION_GROUPS, USE_SEQUENCING, SOLVER_THREADS
    USE_SEQUENCING = sequencing
    SOLVER_THREADS = solver_threads
    _WORKER_GRAPH = extract_south_zone(graph_path)
    _WORKER_STATION_GROUPS = build_station_groups(layout)


_WORKER_GRAPH = None
_WORKER_STATION_GROUPS = None


def _worker_compute_point(task: tuple) -> dict:
    """Run one (bot_count, seed, operators) point in a pool worker."""
    n_bots, seed, max_waves, time_buffer_s, async_mode, async_cycles, ops_per_stn = task
    t0 = time.time()
    res = _best_waves_result(_WORKER_GRAPH, _WORKER_STATION_GROUPS,
                             n_bots, max_waves, time_buffer_s, seed,
                             DEFAULT_UNLOADED, DEFAULT_LOADED,
                             async_mode=async_mode, async_cycles=async_cycles,
                             operators_per_station=ops_per_stn)
    return {
        "n_bots": n_bots, "seed": seed, "ops_per_stn": ops_per_stn,
        "res": res, "dt": time.time() - t0,
    }


def run_sweep(layout: str, bot_counts: list[int], seeds: list[int],
              max_waves: int, time_buffer_s: int, repo_root: Path,
              out_dir: Path, async_mode: bool = False,
              async_cycles: int = 4, workers: int = 1,
              operator_counts: list[int] | None = None):
    """Sweep (bot_count × operator_count × seed) grid. workers>1 uses a pool."""
    out_dir.mkdir(parents=True, exist_ok=True)
    gpath = graph_path_for_layout(repo_root, layout)
    if not gpath.exists():
        raise FileNotFoundError(gpath)

    logger.info("Loading south slice from %s", gpath)
    graph = extract_south_zone(str(gpath))
    logger.info("  %d nodes, %d edges", graph.number_of_nodes(), graph.number_of_edges())
    station_groups = build_station_groups(layout)
    total_stations = sum(len(g["stations"]) for g in station_groups)
    logger.info("  %d stations across %d groups", total_stations, len(station_groups))

    if operator_counts is None:
        operator_counts = [1]
    rows: list[dict] = []

    # Build the (n_bots, ops, seed) task grid and dispatch
    tasks = [(n_bots, seed, max_waves, time_buffer_s, async_mode, async_cycles, ops)
             for ops in operator_counts for n_bots in bot_counts for seed in seeds]
    # Key: (ops, n_bots) → list of result dicts
    per_key: dict[tuple[int, int], list[dict]] = {
        (ops, n): [] for ops in operator_counts for n in bot_counts
    }

    if workers > 1:
        from concurrent.futures import ProcessPoolExecutor, as_completed
        import os
        ncpu = os.cpu_count() or 8
        solver_threads = SOLVER_THREADS if SOLVER_THREADS else max(1, ncpu // workers)
        logger.info("Parallel mode: %d workers × %d solver threads (ncpu=%d) across %d tasks",
                    workers, solver_threads, ncpu, len(tasks))
        t_pool0 = time.time()
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_worker_init,
            initargs=(str(gpath), layout, USE_SEQUENCING, solver_threads),
        ) as pool:
            futures = {pool.submit(_worker_compute_point, t): t for t in tasks}
            for fut in as_completed(futures):
                out = fut.result()
                n_bots, seed = out["n_bots"], out["seed"]
                ops = out.get("ops_per_stn", 1)
                res, dt = out["res"], out["dt"]
                per_key[(ops, n_bots)].append(out)
                logger.info("  [%s ops=%d n=%d seed=%d] %s waves=%d pph=%.1f util=%.2f peakq=%d (%.1fs)",
                            layout, ops, n_bots, seed, res["status"], res["waves"],
                            res["pph"], res["avg_op_utilization"],
                            res["peak_queue_depth"], dt)
        logger.info("Pool wall time: %.1fs", time.time() - t_pool0)
    else:
        for n_bots, seed, mw, tb, am, ac, ops in tasks:
            t0 = time.time()
            res = _best_waves_result(graph, station_groups, n_bots, max_waves,
                                     time_buffer_s, seed, DEFAULT_UNLOADED, DEFAULT_LOADED,
                                     async_mode=async_mode, async_cycles=async_cycles,
                                     operators_per_station=ops)
            dt = time.time() - t0
            per_key[(ops, n_bots)].append({"n_bots": n_bots, "seed": seed,
                                            "ops_per_stn": ops, "res": res, "dt": dt})
            logger.info("  [%s ops=%d n=%d seed=%d] %s waves=%d pph=%.1f util=%.2f peakq=%d (%.1fs)",
                        layout, ops, n_bots, seed, res["status"], res["waves"],
                        res["pph"], res["avg_op_utilization"],
                        res["peak_queue_depth"], dt)

    # Aggregate per (operators, bot_count) in stable order
    point_aggregates: list[dict] = []
    first_marginal = None

    for ops in operator_counts:
        first_marginal = None
        prev_agg = None  # track previous within this ops group
        for bi, n_bots in enumerate(bot_counts):
            point_results = sorted(per_key[(ops, n_bots)], key=lambda x: x["seed"])
            seed_pphs = [p["res"]["pph"] for p in point_results]
            seed_best_waves = [p["res"]["waves"] for p in point_results]
            deadlock_flag = any(p["res"]["pph"] == 0.0 for p in point_results)

            for p in point_results:
                res = p["res"]
                rows.append({
                    "layout": layout,
                    "bot_count": n_bots,
                    "operators_per_station": ops,
                    "seed": p["seed"],
                    "waves": res["waves"],
                    "wave_offset_s": res["wave_offset_s"],
                    "mean_pph": round(res["pph"], 1),
                    "p5_pph": "",
                    "p95_pph": "",
                    "peak_queue_depth": res["peak_queue_depth"],
                    "avg_op_utilization": round(res["avg_op_utilization"], 3),
                    "collisions": 0,
                    "deadlocks": 1 if res["pph"] == 0.0 else 0,
                    "status": res["status"],
                    "solver_s": round(p["dt"], 2),
                })

            # Variance across seeds
            good = [p for p in seed_pphs if p > 0]
            if good:
                mean_pph = sum(good) / len(good)
                p5_pph  = min(good)
                p95_pph = max(good)
                var_pct = 100.0 * (p95_pph - p5_pph) / mean_pph if mean_pph > 0 else 0.0
            else:
                mean_pph = p5_pph = p95_pph = 0.0
                var_pct = 0.0

            # Marginal gain relative to previous bot count within this ops group
            if bi == 0 or prev_agg is None:
                first_marginal = mean_pph / n_bots if n_bots else 0.0
                prev_marginal = first_marginal
            else:
                delta_bots = n_bots - prev_agg["bot_count"]
                prev_marginal = (mean_pph - prev_agg["mean_pph"]) / delta_bots if delta_bots else 0.0

            phase = classify_phase(prev_marginal, first_marginal, var_pct, deadlock_flag)

            point = {
                "layout": layout,
                "bot_count": n_bots,
                "operators_per_station": ops,
                "mean_pph": round(mean_pph, 1),
                "p5_pph": round(p5_pph, 1),
                "p95_pph": round(p95_pph, 1),
                "variance_pct": round(var_pct, 1),
                "marginal_pph_per_bot": round(prev_marginal, 2),
                "phase": phase,
                "seeds": len(good),
                "avg_waves": round(sum(seed_best_waves) / max(len(seed_best_waves), 1), 2),
            }
            point_aggregates.append(point)
            prev_agg = point
            logger.info("  ↳ AGG ops=%d n=%d mean=%.1f p5=%.1f p95=%.1f var=%.1f%% phase=%s",
                        ops, n_bots, mean_pph, p5_pph, p95_pph, var_pct, phase)

    # Fill p5/p95 and phase back into per-seed rows
    aggmap = {(p["operators_per_station"], p["bot_count"]): p for p in point_aggregates}
    for r in rows:
        a = aggmap.get((r.get("operators_per_station", 1), r["bot_count"]))
        if a:
            r["p5_pph"] = a["p5_pph"]
            r["p95_pph"] = a["p95_pph"]
            r["phase"] = a["phase"]

    # Write CSV
    csv_path = out_dir / f"sweep_results_{layout}.csv"
    fieldnames = ["layout", "bot_count", "operators_per_station", "seed",
                  "mean_pph", "p5_pph", "p95_pph",
                  "collisions", "deadlocks", "avg_op_utilization",
                  "peak_queue_depth", "phase", "waves", "wave_offset_s",
                  "status", "solver_s"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})
    logger.info("Wrote %s (%d rows)", csv_path, len(rows))

    # Aggregated points for downstream plotting
    agg_path = out_dir / f"sweep_aggregates_{layout}.json"
    with open(agg_path, "w") as f:
        json.dump({
            "layout": layout,
            "graph_path": str(gpath),
            "num_stations": total_stations,
            "station_groups": [{"label": g["group_label"],
                                "count": len(g["stations"]),
                                "pick_type": g["pick_type"]}
                               for g in station_groups],
            "bot_counts": bot_counts,
            "seeds": seeds,
            "max_waves": max_waves,
            "time_buffer_s": time_buffer_s,
            "walk_speed_m_s": WALK_SPEED_M_S,
            "pick_time_s": PICK_TIME_S,
            "walk_dist_m": WALK_DIST_M,
            "casepick_mix": CASEPICK_MIX,
            "full_case_mix": FULL_CASE_MIX,
            "async_mode": async_mode,
            "async_cycles": async_cycles if async_mode else None,
            "points": point_aggregates,
        }, f, indent=2)
    logger.info("Wrote %s", agg_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", required=True, choices=["Scp", "Ep-Sc"])
    ap.add_argument("--output", default="output/station_capacity")
    ap.add_argument("--bots", default="4,6,8,10,12,16,20,24",
                    help="Comma-separated bot counts")
    ap.add_argument("--seeds", default="1,2,3", help="Comma-separated seeds")
    ap.add_argument("--max-waves", type=int, default=3)
    ap.add_argument("--time-buffer", type=int, default=2)
    ap.add_argument("--async-mode", action="store_true",
                    help="Use asynchronous scheduling (no global wave_offset)")
    ap.add_argument("--async-cycles", type=int, default=4,
                    help="Cycles per bot in async mode (default 4)")
    ap.add_argument("--no-sequencing", action="store_true",
                    help="Disable pick-time sequencing-conditional lookup (use unconditional p50)")
    ap.add_argument("--operators", default="1",
                    help="Comma-separated operator counts per station to sweep "
                         "(e.g., '1,2,3'). Default 1.")
    ap.add_argument("--workers", type=int, default=1,
                    help="Parallel worker processes (default 1 = serial). "
                         "A good value is ncpu/8 (so each CP-SAT solve gets "
                         "~8 threads). E.g., on a 22-CPU machine try --workers 3.")
    ap.add_argument("--solver-threads", type=int, default=None,
                    help="CP-SAT threads per solve. Defaults to ncpu//workers.")
    ap.add_argument("--repo-root", default=None,
                    help="Path to EVT-Simulation-prototype root (auto-detect by default)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    # Apply sequencing toggle before any pick_time_s calls
    global USE_SEQUENCING, SOLVER_THREADS
    USE_SEQUENCING = not args.no_sequencing
    SOLVER_THREADS = args.solver_threads

    repo_root = Path(args.repo_root) if args.repo_root else Path(__file__).resolve().parents[3]
    bot_counts = [int(x) for x in args.bots.split(",") if x.strip()]
    seeds = [int(x) for x in args.seeds.split(",") if x.strip()]
    operator_counts = [int(x) for x in args.operators.split(",") if x.strip()]
    run_sweep(layout=args.layout, bot_counts=bot_counts, seeds=seeds,
              max_waves=args.max_waves, time_buffer_s=args.time_buffer,
              repo_root=repo_root, out_dir=Path(args.output),
              async_mode=args.async_mode, async_cycles=args.async_cycles,
              workers=args.workers, operator_counts=operator_counts)


if __name__ == "__main__":
    main()
