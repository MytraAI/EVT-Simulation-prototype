#!/usr/bin/env python3
"""CP-SAT wave scheduler for the Grainger pilot station sim.

Formulates one N-bot cycle as a job-shop scheduling problem:
- Machines: each cell has capacity 1
- Jobs: each bot has an ordered sequence of cells (spawn → approach → XY → OP → XY → depart → exit)
- Physical dwell: bot occupies cell from arrival until physical departure
- Objective: minimize wave_offset (maximize steady-state throughput)

Adapted from loom/projects/tesla_ga1_zone10/station_sim/cpsat_scheduler.py.

Usage:
    python solver.py --map ../../grainger-pilot-04102026-graph.json --side north --bots 4 --waves 2
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

from ortools.sat.python import cp_model

from graph_utils import (
    BotKinematics,
    DEFAULT_LOADED,
    DEFAULT_UNLOADED,
    NORTH_STATIONS,
    SOUTH_STATIONS,
    SOUTH_ZONE_STATIONS,
    ZONE_ENTRY_POINTS,
    ZONE_EXIT_POINTS,
    CASEPICK_SLICE_STATIONS,
    CASEPICK_ENTRY_POINTS,
    CASEPICK_EXIT_POINTS,
    extract_south_zone,
    extract_casepick_slice,
    edge_travel_time,
    load_graph,
    shortest_path,
)

logger = logging.getLogger(__name__)


@dataclass
class ScheduledStep:
    bot_id: int
    cell_id: str
    start: int
    end: int
    duration: int


@dataclass
class OptimalSchedule:
    steps: list[ScheduledStep]
    makespan: int
    bots: int
    pph: float
    wave_offset: int = 0
    bot_configs: list[dict] | None = None


def _rank_entry_exit_pairs(graph, xy_station, entry_candidates, exit_candidates, kin):
    """Rank all feasible (entry, exit) pairs for a station by total travel cost.

    Returns list of (entry, exit, cost) sorted ascending by cost.
    Entry and exit must differ to enforce one-way flow.
    """
    from graph_utils import path_travel_time

    pairs = []
    for ep in entry_candidates:
        try:
            app_path = shortest_path(graph, ep, xy_station)
            app_cost = path_travel_time(graph, app_path, kin)
        except Exception:
            continue
        for xp in exit_candidates:
            if xp == ep:
                continue
            try:
                dep_path = shortest_path(graph, xy_station, xp)
                dep_cost = path_travel_time(graph, dep_path, kin)
            except Exception:
                continue
            pairs.append((ep, xp, app_cost + dep_cost))
    pairs.sort(key=lambda x: x[2])
    return pairs


def _pick_best_entry_exit(graph, xy_station, entry_candidates, exit_candidates, kin):
    """Pick the single best (entry, exit) pair by minimum total travel time."""
    pairs = _rank_entry_exit_pairs(graph, xy_station, entry_candidates, exit_candidates, kin)
    if not pairs:
        return entry_candidates[0], exit_candidates[0]
    return pairs[0][0], pairs[0][1]


def compute_optimal_cycle(
    map_json: str,
    side: str = "north",
    num_bots: int | None = None,
    service_time: int = 46,
    time_buffer: int = 2,
    waves: int = 1,
    pez_enabled: bool = False,
    pez_time: int = 9,
    kin_unloaded: BotKinematics = DEFAULT_UNLOADED,
    kin_loaded: BotKinematics = DEFAULT_LOADED,
    zone_slice: bool = False,
    slice_mode: str = "south",  # "south" or "casepick"
) -> OptimalSchedule | None:
    """Compute optimal wave schedule for Grainger pilot stations.

    zone_slice=True with slice_mode:
      "south":    full south station zone (4 stations, rows 38-46)
      "casepick": eastmost station only (1 station, x>=13, rows 38-46)
    """

    if zone_slice:
        if slice_mode == "casepick":
            graph = extract_casepick_slice(map_json)
            stations = CASEPICK_SLICE_STATIONS
            entry_pts = CASEPICK_ENTRY_POINTS
            exit_pts = CASEPICK_EXIT_POINTS
        else:
            graph = extract_south_zone(map_json)
            stations = SOUTH_ZONE_STATIONS
            entry_pts = ZONE_ENTRY_POINTS
            exit_pts = ZONE_EXIT_POINTS
        bot_type = "OB"
        logger.info("%s slice: %d nodes, %d edges", slice_mode, graph.number_of_nodes(), graph.number_of_edges())
    else:
        graph = load_graph(map_json)
        stations = NORTH_STATIONS if side == "north" else SOUTH_STATIONS
        bot_type = "IB" if side == "north" else "OB"

    # Build bot-to-station assignment. If num_bots > stations, assign round-robin.
    # Multiple bots at the same station will queue (CP-SAT enforces via no-overlap).
    n_stations = len(stations)
    if num_bots is None:
        num_bots = n_stations
    bot_assignments = []
    for i in range(num_bots):
        bot_assignments.append(stations[i % n_stations])

    # For zone slice: pre-compute ranked (entry, exit) pairs per station and
    # rotate through them for bots sharing the same station. This spreads the
    # load across entry points instead of everyone using the single cheapest path.
    station_pair_rankings = {}
    station_pair_idx = {}
    if zone_slice:
        kin_for_rank = kin_loaded if bot_type == "OB" else kin_unloaded
        for stn in stations:
            pairs = _rank_entry_exit_pairs(graph, stn["xy"], entry_pts, exit_pts, kin_for_rank)
            station_pair_rankings[stn["xy"]] = pairs
            station_pair_idx[stn["xy"]] = 0

    # Build bot paths. Each bot:
    #   entry → approach → XY → OP (service) → XY → depart → exit
    # Zone slice: rotate through top-N ranked entry/exit pairs per station
    # Full graph: entry = exit = aisle_entry

    bots = []
    for i, stn in enumerate(bot_assignments):
        if zone_slice:
            pairs = station_pair_rankings[stn["xy"]]
            if pairs:
                idx = station_pair_idx[stn["xy"]] % len(pairs)
                entry, exit_pt, _ = pairs[idx]
                station_pair_idx[stn["xy"]] += 1
            else:
                entry, exit_pt = entry_pts[0], exit_pts[0]
            logger.info("Bot %d (%s): entry=%s exit=%s", i, stn["xy"], entry, exit_pt)
        else:
            entry = stn.get("entry") or stn.get("spawn") or stn.get("aisle_entry")
            exit_pt = stn.get("exit") or entry
        xy = stn["xy"]
        op = stn["op"]
        pez = stn["pez"]

        kin_in = kin_unloaded if bot_type == "IB" else kin_loaded
        kin_out = kin_loaded if bot_type == "IB" else kin_unloaded

        # Build full path: entry → approach → XY → OP → XY → depart → exit
        # Separate entry/exit aisles for one-way flow
        approach_path = shortest_path(graph, entry, xy)
        depart_path = shortest_path(graph, xy, exit_pt)

        if pez_enabled:
            if bot_type == "IB":
                cells = approach_path[:-1] + [pez, xy, op, xy] + depart_path[1:]
                service_idx = len(approach_path)  # op cell index
                pez_idx = len(approach_path) - 1   # pez cell
            else:
                cells = approach_path + [op, xy, pez] + depart_path[1:]
                service_idx = len(approach_path)     # op cell
                pez_idx = len(approach_path) + 2     # pez cell
        else:
            cells = approach_path + [op, xy] + depart_path[1:]
            service_idx = len(approach_path)  # op cell index

        # Compute per-step durations
        durations = []
        prev_axis = None
        for j in range(len(cells)):
            if j == service_idx:
                durations.append(service_time)
            elif pez_enabled and j == pez_idx:
                durations.append(pez_time)
            elif j < len(cells) - 1 and graph.has_edge(cells[j], cells[j + 1]):
                edata = graph.edges[cells[j], cells[j + 1]]
                kin = kin_in if j <= service_idx else kin_out
                t = edge_travel_time(edata["distance_m"], edata["axis"], prev_axis, kin)
                durations.append(max(1, round(t)))
                prev_axis = edata["axis"]
            else:
                durations.append(1)

        bots.append({
            "id": i, "cells": cells, "durations": durations,
            "config": {"xy": xy, "op": op, "pez": pez, "type": bot_type, "entry": entry, "exit": exit_pt},
        })

    n_base_bots = len(bots)

    # Multi-wave: duplicate bots for each additional wave
    if waves > 1:
        for w in range(1, waves):
            for b in bots[:n_base_bots]:
                bots.append({
                    "id": w * n_base_bots + b["id"],
                    "cells": list(b["cells"]),
                    "durations": list(b["durations"]),
                    "config": b["config"],
                    "wave": w,
                })
        for b in bots[:n_base_bots]:
            b["wave"] = 0

    # ── Build CP-SAT model ──

    model = cp_model.CpModel()
    max_time = max(sum(b["durations"]) for b in bots) * 3

    starts, ends = {}, {}
    for b in bots:
        bid = b["id"]
        for j, (cell, dur) in enumerate(zip(b["cells"], b["durations"])):
            s = model.new_int_var(0, max_time, f"s_b{bid}_{j}_{cell}")
            e = model.new_int_var(0, max_time, f"e_b{bid}_{j}_{cell}")
            model.add(e == s + dur)
            starts[(bid, j)] = s
            ends[(bid, j)] = e

    # Constraint 1: sequential steps
    for b in bots:
        bid = b["id"]
        for j in range(len(b["cells"]) - 1):
            model.add(starts[(bid, j + 1)] >= ends[(bid, j)])

    # Constraint 2: physical dwell no-overlap
    dwell_intervals = {}
    for b in bots:
        bid = b["id"]
        n_steps = len(b["cells"])
        for j in range(n_steps):
            s = starts[(bid, j)]
            if j < n_steps - 1:
                dwell_size = model.new_int_var(1, max_time, f"dw_b{bid}_{j}")
                model.add(dwell_size == starts[(bid, j + 1)] - s + time_buffer)
                dwell_end = model.new_int_var(0, max_time + time_buffer, f"de_b{bid}_{j}")
                model.add(dwell_end == s + dwell_size)
            else:
                dwell_size = b["durations"][j] + time_buffer
                dwell_end = model.new_int_var(0, max_time + time_buffer, f"de_b{bid}_{j}")
                model.add(dwell_end == s + dwell_size)

            dwell_intervals[(bid, j)] = model.new_interval_var(
                s, dwell_size, dwell_end, f"di_b{bid}_{j}"
            )

    # Per-cell no-overlap
    cell_dwells: dict[str, list] = {}
    for b in bots:
        bid = b["id"]
        for j, cell in enumerate(b["cells"]):
            cell_dwells.setdefault(cell, []).append(dwell_intervals[(bid, j)])
    for cell, ivals in cell_dwells.items():
        if len(ivals) > 1:
            model.add_no_overlap(ivals)

    # Objective
    if waves > 1:
        wave_offset_var = model.new_int_var(1, max_time, "wave_offset")
        for w in range(1, waves):
            for i in range(n_base_bots):
                w0_bid = i
                wN_bid = w * n_base_bots + i
                for j in range(len(bots[i]["cells"])):
                    model.add(starts[(wN_bid, j)] == starts[(w0_bid, j)] + w * wave_offset_var)
        makespan = model.new_int_var(0, max_time, "makespan")
        for b in bots:
            model.add(makespan >= ends[(b["id"], len(b["cells"]) - 1)])
        model.minimize(wave_offset_var)
    else:
        makespan = model.new_int_var(0, max_time, "makespan")
        for b in bots:
            model.add(makespan >= ends[(b["id"], len(b["cells"]) - 1)])
        model.minimize(makespan)

    # Solve
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 15.0
    status = solver.solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        logger.error("CP-SAT: no feasible schedule (status=%s)", status)
        return None

    ms = solver.value(makespan)
    w_offset = solver.value(wave_offset_var) if waves > 1 else ms

    # Extract wave-0 schedule
    steps = []
    for b in bots[:n_base_bots]:
        bid = b["id"]
        n_steps = len(b["cells"])
        for j, (cell, dur) in enumerate(zip(b["cells"], b["durations"])):
            step_start = solver.value(starts[(bid, j)])
            step_end = solver.value(starts[(bid, j + 1)]) if j < n_steps - 1 else solver.value(ends[(bid, j)])
            steps.append(ScheduledStep(bid, cell, step_start, step_end, dur))

    steps.sort(key=lambda s: (s.bot_id, s.start))
    pph = n_base_bots * 3600 / w_offset

    status_name = "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE"
    logger.info("CP-SAT: %d bots, makespan=%ds, wave_offset=%ds, PPH=%.0f (%s)",
                n_base_bots, ms, w_offset, pph, status_name)

    return OptimalSchedule(
        steps=steps, makespan=ms, bots=n_base_bots, pph=pph,
        wave_offset=w_offset,
        bot_configs=[b["config"] for b in bots[:n_base_bots]],
    )


def schedule_to_json(sched: OptimalSchedule, side: str, waves: int) -> dict:
    """Convert schedule to JSON-serializable dict."""
    return {
        "side": side,
        "bots": sched.bots,
        "waves": waves,
        "wave_offset_s": sched.wave_offset,
        "makespan_s": sched.makespan,
        "pph": round(sched.pph, 1),
        "steps": [
            {"bot_id": s.bot_id, "cell_id": s.cell_id,
             "start": s.start, "end": s.end, "duration": s.duration}
            for s in sched.steps
        ],
        "bot_configs": sched.bot_configs,
    }


def run_fleet_sweep(args, kin_unloaded, kin_loaded):
    """Sweep fleet sizes: for each bot count (1..4), try increasing waves until infeasible."""
    import time as _time

    max_bots = args.sweep_max_bots
    max_waves = args.sweep_max_waves

    # Build service time table: each subtype is handle + drop phase time.
    # - Conveyable pallets (Case or Casepick) drop to conveyor.
    # - NCV full pallet (Case NCV) drops to conveyor too.
    # - NCV casepick splits into → bin or → repalletize (manual).
    is_casepick = getattr(args, 'slice_mode', 'south') == 'casepick'

    def _handle_plus_drop(handle, drop):
        return (handle or 0) + (drop or 0)

    if is_casepick:
        svc = {
            "casepick_conv":      _handle_plus_drop(args.svc_casepick_conv      or args.service_time, args.drop_conveyor),
            "casepick_ncv_bin":   _handle_plus_drop(args.svc_casepick_ncv_bin   or int(args.service_time * 1.2), args.drop_bin),
            "casepick_ncv_repal": _handle_plus_drop(args.svc_casepick_ncv_repal or int(args.service_time * 1.2), args.drop_repal),
        }
    else:
        svc = {
            "case_conv":          _handle_plus_drop(args.svc_case_conv          or args.service_time, args.drop_conveyor),
            "case_ncv":           _handle_plus_drop(args.svc_case_ncv           or int(args.service_time * 1.3), args.drop_conveyor),
            "casepick_conv":      _handle_plus_drop(args.svc_casepick_conv      or args.service_time, args.drop_conveyor),
            "casepick_ncv_bin":   _handle_plus_drop(args.svc_casepick_ncv_bin   or int(args.service_time * 1.2), args.drop_bin),
            "casepick_ncv_repal": _handle_plus_drop(args.svc_casepick_ncv_repal or int(args.service_time * 1.2), args.drop_repal),
        }

    slice_label = "Casepick Slice (1 station)" if is_casepick else "South Station Zone (4 stations)"
    print("=" * 70)
    print(f"FLEET SIZE SWEEP — {slice_label}")
    print(f"Map:          {args.map}")
    print(f"Max bots:     {max_bots}  |  Max waves: {max_waves}")
    print(f"Buffer:       {args.time_buffer}s  |  PEZ: {'enabled' if args.pez else 'disabled'}")
    print(f"\nDrop-off phase times:")
    print(f"  Conveyor drop:                 {args.drop_conveyor}s")
    print(f"  Bin drop (NCV casepick):       {args.drop_bin}s")
    print(f"  Repalletize drop (NCV CP):     {args.drop_repal}s")
    print(f"\nTotal service time per subtype (handle + drop):")
    for k, v in svc.items():
        label = k.replace("_", " ").replace("ncv", "NCV").title()
        print(f"  {label:30s} {v}s")
    print(f"  {'(sweep default)':30s} {args.service_time}s")
    print("=" * 70)
    print()

    results = []
    t0 = _time.time()

    # For each bot count, find best wave count, then compute PPH per subtype
    for n_bots in range(1, max_bots + 1):
        print(f"--- {n_bots} bot(s) per wave ---")
        best_pph = 0
        best_waves = 0
        best_offset = 0
        best_makespan = 0

        for n_waves in range(1, max_waves + 1):
            sched = compute_optimal_cycle(
                map_json=args.map, side=args.side, num_bots=n_bots,
                service_time=args.service_time, time_buffer=args.time_buffer,
                waves=n_waves, pez_enabled=args.pez, pez_time=args.pez_time,
                kin_unloaded=kin_unloaded, kin_loaded=kin_loaded,
                zone_slice=args.zone_slice, slice_mode=args.slice_mode,
            )
            if sched is None:
                print(f"  {n_waves} waves: INFEASIBLE")
                break

            status = "OPTIMAL" if sched.pph > 0 else "FEASIBLE"
            print(f"  {n_waves} waves: offset={sched.wave_offset}s  makespan={sched.makespan}s  PPH={sched.pph:.0f}  ({status})")

            if sched.pph > best_pph:
                best_pph = sched.pph
                best_waves = n_waves
                best_offset = sched.wave_offset
                best_makespan = sched.makespan

        # Compute PPH per subtype using single-wave (fast) at best_waves count
        subtype_pph = {}
        if best_waves > 0:
            for svc_name, svc_time in svc.items():
                sub_sched = compute_optimal_cycle(
                    map_json=args.map, side=args.side, num_bots=n_bots,
                    service_time=svc_time, time_buffer=args.time_buffer,
                    waves=1, pez_enabled=args.pez, pez_time=args.pez_time,
                    kin_unloaded=kin_unloaded, kin_loaded=kin_loaded,
                    zone_slice=args.zone_slice,
                )
                # Scale single-wave PPH by best_waves ratio
                if sub_sched:
                    base_pph = sub_sched.pph  # single wave
                    # Estimate multi-wave: PPH scales by (single_cycle / wave_offset_ratio)
                    subtype_pph[svc_name] = round(base_pph * min(best_waves, 2), 1)
                else:
                    subtype_pph[svc_name] = 0

        results.append({
            "bots": n_bots,
            "best_waves": best_waves,
            "best_pph": round(best_pph, 1),
            "wave_offset_s": best_offset,
            "makespan_s": best_makespan,
            "active_bots": n_bots * best_waves,
            "subtype_pph": subtype_pph,
        })
        print(f"  BEST: {best_waves} waves → {best_pph:.0f} PPH ({n_bots * best_waves} active bots)")
        sub_str = "  subtypes: " + " | ".join(f"{k}={v}" for k, v in subtype_pph.items())
        print(sub_str)
        print()

    elapsed = _time.time() - t0
    print(f"Sweep completed in {elapsed:.1f}s\n")

    # Summary table
    print("┌───────┬───────┬────────┬──────────┬──────────┬────────────┬────────────────────────────────────────────────────────────┐")
    print("│ Bots  │ Waves │ Active │ Offset   │ Makespan │ Default    │ PPH by Operation Subtype                                   │")
    print("│ /wave │       │ bots   │ (s)      │ (s)      │ PPH        │ CaseConv  CaseNCV  CPConv  CP-Bin  CP-Repal               │")
    print("├───────┼───────┼────────┼──────────┼──────────┼────────────┼────────────────────────────────────────────────────────────┤")
    for r in results:
        sp = r.get("subtype_pph", {})
        print(f"│  {r['bots']:3d}  │  {r['best_waves']:3d}  │  {r['active_bots']:4d}  │  {r['wave_offset_s']:6d}  │  {r['makespan_s']:6d}  │  {r['best_pph']:8.0f}  │"
              f"  {sp.get('case_conv',0):6.0f}    {sp.get('case_ncv',0):6.0f}  {sp.get('casepick_conv',0):6.0f}  {sp.get('casepick_ncv_bin',0):6.0f}  {sp.get('casepick_ncv_repal',0):6.0f}               │")
    print("└───────┴───────┴────────┴──────────┴──────────┴────────────┴────────────────────────────────────────────────────────────┘")

    # JSON output
    sweep_output = {
        "sweep_type": "fleet_size",
        "zone": "south_station_zone",
        "service_times": svc,
        "default_service_time_s": args.service_time,
        "time_buffer_s": args.time_buffer,
        "pez_enabled": args.pez,
        "results": results,
    }
    out_path = args.output or "fleet-sweep-results.json"
    with open(out_path, "w") as f:
        json.dump(sweep_output, f, indent=2)
    print(f"\nJSON → {out_path}")


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    parser = argparse.ArgumentParser(description="CP-SAT wave scheduler for Grainger pilot")
    parser.add_argument("--map", required=True, help="Path to graph JSON")
    parser.add_argument("--side", default="north", choices=["north", "south"])
    parser.add_argument("--bots", type=int, default=None, help="Bots per wave (default: all stations)")
    parser.add_argument("--service-time", type=int, default=46, help="Default operator service time (s)")
    # Granular per-subtype operator times (override --service-time when set)
    parser.add_argument("--svc-case-conv", type=int, default=None, help="Case conveyable service (s)")
    parser.add_argument("--svc-case-ncv", type=int, default=None, help="Case non-conveyable service (s)")
    parser.add_argument("--svc-casepick-conv", type=int, default=None, help="Casepick conveyable: per-case pick time (s)")
    parser.add_argument("--svc-casepick-ncv-bin", type=int, default=None, help="Casepick NCV bin: per-case pick + bin time (s)")
    parser.add_argument("--svc-casepick-ncv-repal", type=int, default=None, help="Casepick NCV repal: per-case pick + repal time (s)")
    # Drop-off phase times (added to operator service time)
    parser.add_argument("--drop-conveyor", type=int, default=5, help="Conveyor drop time (s) — applies to any conveyable pallet")
    parser.add_argument("--drop-bin", type=int, default=8, help="Bin drop time (s) — NCV casepick only")
    parser.add_argument("--drop-repal", type=int, default=15, help="Repalletize drop time (s) — NCV casepick only")
    parser.add_argument("--time-buffer", type=int, default=2, help="Cell clearance buffer (s)")
    parser.add_argument("--waves", type=int, default=1, help="Overlapping waves to optimize")
    parser.add_argument("--pez", action="store_true", help="Enable PEZ tray legs")
    parser.add_argument("--pez-time", type=int, default=9, help="PEZ tray time (s)")
    parser.add_argument("--xy-speed", type=float, default=1.5, help="Bot XY speed (m/s)")
    parser.add_argument("--xy-accel", type=float, default=1.5, help="Bot XY accel (m/s^2)")
    parser.add_argument("--loaded-accel", type=float, default=0.3, help="Loaded accel (m/s^2)")
    parser.add_argument("--zone-slice", action="store_true", help="(deprecated, use --slice)")
    parser.add_argument("--slice", default=None, choices=["south", "casepick"], help="Slice mode: south (4 stations) or casepick (1 eastmost station)")
    parser.add_argument("--sweep", action="store_true", help="Sweep fleet sizes (1..max bots, varying waves)")
    parser.add_argument("--sweep-max-bots", type=int, default=10, help="Max bots per wave in sweep")
    parser.add_argument("--sweep-max-waves", type=int, default=5, help="Max waves to try per bot count in sweep")
    parser.add_argument("-o", "--output", default=None, help="Output JSON file (default: stdout)")
    args = parser.parse_args()

    kin_unloaded = BotKinematics(xy_velocity=args.xy_speed, xy_accel=args.xy_accel)
    kin_loaded = BotKinematics(xy_velocity=args.xy_speed, xy_accel=args.loaded_accel)

    # Resolve slice mode
    if args.slice:
        args.zone_slice = True
        args.slice_mode = args.slice
    elif args.zone_slice:
        args.slice_mode = "south"
    else:
        args.slice_mode = "south"

    if args.sweep:
        run_fleet_sweep(args, kin_unloaded, kin_loaded)
        return

    sched = compute_optimal_cycle(
        map_json=args.map, side=args.side, num_bots=args.bots,
        service_time=args.service_time, time_buffer=args.time_buffer,
        waves=args.waves, pez_enabled=args.pez, pez_time=args.pez_time,
        kin_unloaded=kin_unloaded, kin_loaded=kin_loaded,
        zone_slice=args.zone_slice, slice_mode=args.slice_mode,
    )

    if sched is None:
        print("ERROR: No feasible schedule found", file=sys.stderr)
        sys.exit(1)

    result = schedule_to_json(sched, args.side, args.waves)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2)
        print(f"Schedule written to {args.output}", file=sys.stderr)
    else:
        json.dump(result, sys.stdout, indent=2)
        print(file=sys.stdout)

    # Summary
    print(f"\n{'='*50}", file=sys.stderr)
    print(f"Side:         {args.side}", file=sys.stderr)
    print(f"Bots/wave:    {sched.bots}", file=sys.stderr)
    print(f"Waves:        {args.waves}", file=sys.stderr)
    print(f"Makespan:     {sched.makespan}s", file=sys.stderr)
    print(f"Wave offset:  {sched.wave_offset}s", file=sys.stderr)
    print(f"Projected PPH: {sched.pph:.0f}", file=sys.stderr)
    print(f"{'='*50}", file=sys.stderr)

    # Per-bot timeline
    for i, bc in enumerate(sched.bot_configs):
        bot_steps = [s for s in sched.steps if s.bot_id == i]
        entry = bc.get('entry', bc.get('spawn', '?'))
        exit_pt = bc.get('exit', entry)
        print(f"\nBot {i} ({bc['type']}) {entry} → {bc['xy']} → {bc['op']} → {exit_pt}:", file=sys.stderr)
        for s in bot_steps:
            print(f"  t={s.start:3d}-{s.end:3d}s  {s.cell_id:15s}  (dur={s.duration}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
