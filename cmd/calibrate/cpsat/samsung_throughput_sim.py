#!/usr/bin/env python3
"""Samsung P1 throughput simulation — greedy assignment + CP-SAT scheduling.

5 bots, 4 stations (2 ops each), 150-pallet depletion run.
Greedy nearest-first assigns pallets to bots and stations.
CP-SAT schedules cell visits to resolve contention (cell conflicts,
Z-column mutex, PEZ adjacency blocking, station OP dwell).

Usage:
    python samsung_throughput_sim.py [--pallets 150] [--window 5]
"""
from __future__ import annotations

import argparse
import json
import logging
import random
import time
from collections import defaultdict
from pathlib import Path

from ortools.sat.python import cp_model

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger(__name__)


def load_paths(path: str = "samsung_paths.json") -> dict:
    with open(path) as f:
        return json.load(f)


def greedy_assign(
    bots: list[dict],
    available_pallets: list[str],
    paths_data: dict,
    window_size: int = 1,
    balance_weight: float = 0.0,
    station_counts: dict[str, int] | None = None,
) -> list[dict]:
    """Greedy assignment with optional load balancing.

    When balance_weight=0 (default): pure nearest-first.
    When balance_weight>0: penalizes over-used stations so less-used
    stations get more traffic.  The penalty is:
        cost = travel_time + balance_weight * station_load_fraction * avg_cycle

    Returns list of trip dicts.
    """
    p2s = paths_data["pallet_to_station"]
    pez2p = paths_data["pez_to_pallet"]
    pez_for_station = paths_data["pez_for_station"]
    station_ops = paths_data["station_ops"]

    # Running station load count for balancing
    stn_load = dict(station_counts) if station_counts else {s: 0 for s in station_ops}
    total_load = max(sum(stn_load.values()), 1)

    claimed = set()
    trips = []

    bot_order = sorted(range(len(bots)), key=lambda b: bots[b]["available_at"])

    for _round in range(window_size):
        for b in bot_order:
            bot = bots[b]
            bot_pez = bot.get("position", "")

            best_pal = None
            best_stn = None
            best_cost = float("inf")
            best_loaded = None

            for pal in available_pallets:
                if pal in claimed:
                    continue

                for sop in station_ops:
                    p2s_key = f"{pal}|{sop}"
                    if p2s_key not in p2s:
                        continue
                    loaded = p2s[p2s_key]

                    pez_id = pez_for_station[sop]
                    if bot_pez and f"{bot_pez}|{pal}" in pez2p:
                        return_path = pez2p[f"{bot_pez}|{pal}"]
                        travel = return_path["total_s"] + loaded["total_s"]
                    else:
                        travel = loaded["total_s"]

                    # Load-balancing penalty: over-used stations cost more
                    if balance_weight > 0 and total_load > 0:
                        ideal_share = total_load / len(station_ops)
                        excess = max(0, stn_load[sop] - ideal_share)
                        penalty = balance_weight * excess * 2  # 2s per excess pallet
                    else:
                        penalty = 0

                    cost = travel + penalty

                    if cost < best_cost:
                        best_cost = cost
                        best_pal = pal
                        best_stn = sop
                        best_loaded = loaded

            if best_pal is None:
                continue

            claimed.add(best_pal)
            stn_load[best_stn] = stn_load.get(best_stn, 0) + 1
            total_load += 1
            trips.append({
                "bot": b,
                "pallet": best_pal,
                "station": best_stn,
                "loaded_cells": best_loaded["cells"],
                "loaded_durs": best_loaded["durations"],
                "loaded_total": best_loaded["total_s"],
                "pez": pez_for_station[best_stn],
            })

            # Update bot position estimate for next round
            bots[b] = {**bot, "position": pez_for_station[best_stn]}

    return trips


def schedule_trips(
    trips: list[dict],
    bots: list[dict],
    paths_data: dict,
    graph_adj: dict,
    max_time_s: float = 30.0,
) -> dict | None:
    """CP-SAT schedule: resolve cell conflicts, Z-column mutex, PEZ blocking.

    Models the FULL bot cycle for each trip:
      loaded path (pallet→station) → PEZ dwell → return path (PEZ→next pallet)

    The return path between consecutive trips on the same bot is included
    so Z-column contention and aisle conflicts during unloaded travel are
    correctly captured.
    """
    if not trips:
        return None

    pez_dwell = paths_data["pez_dwell_s"]
    pez2p = paths_data["pez_to_pallet"]

    model = cp_model.CpModel()
    max_t = max(sum(t["loaded_durs"]) for t in trips) * 6 + max(b["available_at"] for b in bots)
    max_t = max(max_t, 8000)

    # ── Build per-bot trip chains with return paths ──
    bot_trips_ordered = defaultdict(list)  # b → [trip_idx, ...]
    for ti, trip in enumerate(trips):
        bot_trips_ordered[trip["bot"]].append(ti)

    # For each consecutive pair of trips on the same bot, compute return path
    return_paths = {}  # (ti_from, ti_to) → {cells, durations}
    for b, trip_idxs in bot_trips_ordered.items():
        for i in range(len(trip_idxs) - 1):
            ti_curr = trip_idxs[i]
            ti_next = trip_idxs[i + 1]
            pez_id = trips[ti_curr]["pez"]
            next_pallet = trips[ti_next]["pallet"]
            ret_key = f"{pez_id}|{next_pallet}"
            if ret_key in pez2p:
                rp = pez2p[ret_key]
                # Skip first cell (PEZ, already covered) and last cell (pallet, covered by next loaded)
                ret_cells = rp["cells"][1:-1] if len(rp["cells"]) > 2 else []
                ret_durs = rp["durations"][1:-1] if len(rp["durations"]) > 2 else []
                return_paths[(ti_curr, ti_next)] = {"cells": ret_cells, "durs": ret_durs}

    # ── Per-trip cell intervals ──
    trip_starts = []
    trip_ends = []       # end of PEZ
    trip_return_ends = {}  # end of return path (if any)
    cell_intervals: dict[str, list] = defaultdict(list)

    for ti, trip in enumerate(trips):
        b = trip["bot"]
        cells = trip["loaded_cells"]
        durs = trip["loaded_durs"]
        n_cells = len(cells)

        t_start = model.new_int_var(bots[b]["available_at"], max_t, f"ts_{ti}")

        # Loaded path cells
        prev_end = t_start
        for j in range(n_cells):
            cell = cells[j]
            dur = durs[j]
            cs = model.new_int_var(0, max_t, f"cs_{ti}_{j}")
            model.add(cs == prev_end)

            if j < n_cells - 1:
                ce = model.new_int_var(0, max_t + dur + 500, f"ce_{ti}_{j}")
                model.add(ce >= cs + dur)
                dw = model.new_int_var(dur, dur + 500, f"dw_{ti}_{j}")
                model.add(dw == ce - cs)
            else:
                ce = model.new_int_var(0, max_t + dur, f"ce_{ti}_{j}")
                model.add(ce == cs + dur)
                dw = dur

            ivl = model.new_interval_var(cs, dw if isinstance(dw, int) else dw,
                                         ce, f"ci_{ti}_{j}")
            cell_intervals[cell].append(ivl)
            prev_end = ce

        # PEZ dwell
        pez_id = trip["pez"]
        pez_s = model.new_int_var(0, max_t, f"pezs_{ti}")
        pez_e = model.new_int_var(0, max_t + pez_dwell, f"peze_{ti}")
        model.add(pez_s == prev_end)
        model.add(pez_e == pez_s + pez_dwell)
        pez_ivl = model.new_interval_var(pez_s, pez_dwell, pez_e, f"pezi_{ti}")
        cell_intervals[pez_id].append(pez_ivl)

        for neighbor in graph_adj.get(pez_id, []):
            if neighbor != pez_id:
                cell_intervals[neighbor].append(pez_ivl)

        trip_starts.append((ti, t_start))
        trip_ends.append((ti, pez_e))

    # ── Return paths (unloaded PEZ → next pallet) ──
    for b, trip_idxs in bot_trips_ordered.items():
        for i in range(len(trip_idxs) - 1):
            ti_curr = trip_idxs[i]
            ti_next = trip_idxs[i + 1]

            rp = return_paths.get((ti_curr, ti_next))
            _, pez_e = trip_ends[ti_curr]
            _, next_start = trip_starts[ti_next]

            if rp and rp["cells"]:
                prev_end = pez_e
                for rj, (rcell, rdur) in enumerate(zip(rp["cells"], rp["durs"])):
                    rcs = model.new_int_var(0, max_t, f"rcs_{ti_curr}_{rj}")
                    rce = model.new_int_var(0, max_t + rdur + 500, f"rce_{ti_curr}_{rj}")
                    model.add(rcs == prev_end)
                    model.add(rce >= rcs + rdur)
                    rdw = model.new_int_var(rdur, rdur + 500, f"rdw_{ti_curr}_{rj}")
                    model.add(rdw == rce - rcs)
                    rivl = model.new_interval_var(rcs, rdw, rce, f"rci_{ti_curr}_{rj}")
                    cell_intervals[rcell].append(rivl)
                    prev_end = rce

                # Next trip starts after return completes
                model.add(next_start >= prev_end)
                trip_return_ends[(ti_curr, ti_next)] = prev_end
            else:
                # No return path — just enforce ordering
                model.add(next_start >= pez_e)

    # ── Cell no-overlap ──
    for cell, ivals in cell_intervals.items():
        if len(ivals) > 1:
            model.add_no_overlap(ivals)

    # ── Objective: minimize makespan ──
    makespan = model.new_int_var(0, max_t, "makespan")
    for ti, end_var in trip_ends:
        model.add(makespan >= end_var)
    # Also include return path ends
    for (ti_curr, ti_next), ret_end in trip_return_ends.items():
        model.add(makespan >= ret_end)
    model.minimize(makespan)

    # ── Solve ──
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_s
    solver.parameters.num_search_workers = 8
    status = solver.solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    ms = solver.value(makespan)

    results = []
    bot_end_times = {}
    for ti, trip in enumerate(trips):
        _, ts = trip_starts[ti]
        _, te = trip_ends[ti]
        t_s = solver.value(ts)
        t_e = solver.value(te)
        results.append({
            "pallet": trip["pallet"],
            "bot": trip["bot"],
            "station": trip["station"],
            "start": t_s,
            "end": t_e,
            "duration": t_e - t_s,
        })
        bot_end_times[trip["bot"]] = max(
            bot_end_times.get(trip["bot"], 0), t_e)

    # Update end times to include return paths
    for (ti_curr, ti_next), ret_end in trip_return_ends.items():
        b = trips[ti_curr]["bot"]
        ret_val = solver.value(ret_end)
        bot_end_times[b] = max(bot_end_times.get(b, 0), ret_val)

    bot_last_pez = {}
    for trip in trips:
        bot_last_pez[trip["bot"]] = trip["pez"]

    return {
        "makespan": ms,
        "assignments": sorted(results, key=lambda a: a["start"]),
        "bot_end_times": bot_end_times,
        "bot_last_pez": bot_last_pez,
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "pallets_scheduled": len(results),
    }


def run_simulation(
    n_pallets: int = 150,
    window_size: int = 5,
    solver_budget_s: float = 30.0,
    balance_weight: float = 0.0,
    label: str = "nearest_first",
) -> dict:
    """Run full rolling-horizon simulation."""
    paths_data = load_paths()

    # Build graph adjacency for PEZ blocking
    with open("samsung_full_p1.json") as f:
        g_raw = json.load(f)
    graph_adj = defaultdict(list)
    for e in g_raw.get("links", g_raw.get("edges", [])):
        graph_adj[e["a"]].append(e["b"])
        graph_adj[e["b"]].append(e["a"])

    all_pallets = list(paths_data["storage_pallets"])
    random.seed(42)
    random.shuffle(all_pallets)
    pallets_to_process = all_pallets[:n_pallets]

    n_bots = 5
    bots = [{"id": b, "position": "", "available_at": 0} for b in range(n_bots)]

    # Track station counts across windows for load balancing
    station_counts = {s: 0 for s in paths_data["station_ops"]}

    total_assigned = 0
    window_num = 0
    all_assignments = []
    global_makespan = 0

    t0 = time.time()
    while total_assigned < n_pallets:
        remaining = pallets_to_process[total_assigned:]
        if not remaining:
            break

        bots_copy = [dict(b) for b in bots]
        trips = greedy_assign(
            bots=bots_copy,
            available_pallets=remaining,
            paths_data=paths_data,
            window_size=window_size,
            balance_weight=balance_weight,
            station_counts=station_counts,
        )

        if not trips:
            logger.warning(f"Window {window_num}: no trips assigned")
            break

        logger.info(f"Window {window_num}: {len(trips)} trips assigned, scheduling...")

        # CP-SAT schedule
        result = schedule_trips(
            trips=trips,
            bots=bots,
            paths_data=paths_data,
            graph_adj=dict(graph_adj),
            max_time_s=solver_budget_s,
        )

        if result is None:
            logger.warning(f"Window {window_num} INFEASIBLE with {len(trips)} trips. "
                          f"Trying window_size=1...")
            # Retry with 1 pallet per bot
            bots_copy = [dict(b) for b in bots]
            trips = greedy_assign(bots_copy, remaining, paths_data, window_size=1)
            result = schedule_trips(trips, bots, paths_data, dict(graph_adj), solver_budget_s)
            if result is None:
                logger.error(f"Window {window_num} still INFEASIBLE. Skipping.")
                total_assigned += len(trips) if trips else 1
                continue

        n_scheduled = result["pallets_scheduled"]
        total_assigned += n_scheduled
        global_makespan = max(global_makespan, result["makespan"])

        all_assignments.extend(result["assignments"])

        # Update bot state and station counts
        for b in range(n_bots):
            if b in result["bot_end_times"]:
                bots[b]["available_at"] = result["bot_end_times"][b]
            if b in result["bot_last_pez"]:
                bots[b]["position"] = result["bot_last_pez"][b]
        for a in result["assignments"]:
            station_counts[a["station"]] = station_counts.get(a["station"], 0) + 1

        logger.info(f"  → {n_scheduled} pallets, makespan={result['makespan']}s, "
                    f"status={result['status']}, total={total_assigned}/{n_pallets}")

        window_num += 1

    dt = time.time() - t0

    # ── Metrics ──
    pallets_hr = len(all_assignments) * 3600.0 / global_makespan if global_makespan else 0

    bot_stats = {}
    for b in range(n_bots):
        b_trips = [a for a in all_assignments if a["bot"] == b]
        busy = sum(a["duration"] for a in b_trips)
        bot_stats[b] = {
            "count": len(b_trips),
            "busy_s": busy,
            "idle_s": global_makespan - busy,
            "utilization": busy / global_makespan if global_makespan else 0,
            "avg_cycle_s": busy / len(b_trips) if b_trips else 0,
        }

    station_stats = {}
    for sop in paths_data["station_ops"]:
        s_trips = [a for a in all_assignments if a["station"] == sop]
        station_stats[sop] = {"count": len(s_trips)}

    return {
        "label": label,
        "pallets_processed": len(all_assignments),
        "makespan_s": global_makespan,
        "pallets_per_hr": round(pallets_hr, 1),
        "solve_time_s": round(dt, 1),
        "windows": window_num,
        "bot_stats": bot_stats,
        "station_stats": station_stats,
        "avg_cycle_s": round(global_makespan / (len(all_assignments) / n_bots), 1) if all_assignments else 0,
    }


def print_results(results: dict):
    label = results.get("label", "")
    print(f"\n{'=' * 60}")
    print(f"SAMSUNG P1 — {label} — {results['pallets_processed']} pallets")
    print(f"{'=' * 60}")
    print(f"Makespan:     {results['makespan_s']:,.0f}s ({results['makespan_s']/3600:.1f}h)")
    print(f"Pallets/hr:   {results['pallets_per_hr']:.1f}")
    print(f"Avg cycle:    {results['avg_cycle_s']:.0f}s per pallet per bot")
    print(f"Solve time:   {results['solve_time_s']:.0f}s ({results['windows']} windows)")

    print(f"\nBot utilization:")
    for b in range(5):
        s = results["bot_stats"].get(b, results["bot_stats"].get(str(b), {}))
        print(f"  Bot {b}: {s.get('count', 0):3d} pallets, "
              f"util={s.get('utilization', 0):.0%}, "
              f"avg_cycle={s.get('avg_cycle_s', 0):.0f}s")

    print(f"\nStation load:")
    for sop in ["op-2--1", "op-4--1", "op-6--1", "op-8--1"]:
        s = results["station_stats"].get(sop, {})
        pct = s.get('count', 0) / max(results['pallets_processed'], 1) * 100
        print(f"  {sop}: {s.get('count', 0):3d} pallets ({pct:.0f}%)")


def main():
    parser = argparse.ArgumentParser(description="Samsung P1 throughput simulation")
    parser.add_argument("--pallets", type=int, default=150)
    parser.add_argument("--window", type=int, default=3)
    parser.add_argument("--budget", type=float, default=30.0)
    args = parser.parse_args()

    out_path = Path("/tmp/samsung_throughput")
    out_path.mkdir(exist_ok=True)
    all_results = {}

    # Run 1: nearest-first (no balancing)
    logger.info(f"=== RUN 1: Nearest-First ===")
    r1 = run_simulation(n_pallets=args.pallets, window_size=args.window,
                        solver_budget_s=args.budget, balance_weight=0.0,
                        label="nearest_first")
    print_results(r1)
    all_results["nearest_first"] = r1

    # Run 2: load-balanced
    logger.info(f"\n=== RUN 2: Load-Balanced ===")
    r2 = run_simulation(n_pallets=args.pallets, window_size=args.window,
                        solver_budget_s=args.budget, balance_weight=10.0,
                        label="load_balanced")
    print_results(r2)
    all_results["load_balanced"] = r2

    # Save all
    with open(out_path / "results.json", "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\nResults: {out_path / 'results.json'}")


if __name__ == "__main__":
    main()
