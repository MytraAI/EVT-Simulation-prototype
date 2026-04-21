#!/usr/bin/env python3
"""Config-driven station capacity sweep with Pareto frontier.

Reads YAML configs (layered), builds station plans from config-driven
station groups, runs the CP-SAT wave scheduler, and produces a Pareto
frontier of (bots × operators → PPH).

Usage:
    python run_sweep_v2.py --config configs/grainger_scp.yaml configs/sweep_default.yaml
    python run_sweep_v2.py --config configs/grainger_ep_sc.yaml --set sweep.workers=3
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from config_schema import FullConfig, load_config, parse_cli_overrides, validate_config
from graph_slice import extract_subgraph
from graph_utils import DEFAULT_LOADED, DEFAULT_UNLOADED, BotKinematics
from run_sweep import solve_wave_schedule
from station_plan import BotPlan, ServiceTimeModel, build_bots_from_config

logger = logging.getLogger(__name__)


# ── Worker pool globals (set by _worker_init) ──

_W_GRAPH = None
_W_GROUPS = None
_W_SVC = None
_W_KIN_UL = None
_W_KIN_LD = None
_W_THREADS = None


def _worker_init(graph_path: str, slice_spec_dict: dict,
                 groups_dicts: list[dict], svc_dict: dict,
                 solver_threads: int | None):
    """Initialize worker process: load graph + build service model."""
    global _W_GRAPH, _W_GROUPS, _W_SVC, _W_KIN_UL, _W_KIN_LD, _W_THREADS
    from config_schema import SliceSpec, StationGroupConfig, ServiceTimeConfig, _dict_to_dataclass
    _W_GRAPH = extract_subgraph(graph_path, _dict_to_dataclass(SliceSpec, slice_spec_dict))
    _W_GROUPS = [_dict_to_dataclass(StationGroupConfig, d) for d in groups_dicts]
    _W_SVC = ServiceTimeModel(_dict_to_dataclass(ServiceTimeConfig, svc_dict))
    _W_KIN_UL = DEFAULT_UNLOADED
    _W_KIN_LD = DEFAULT_LOADED
    _W_THREADS = solver_threads


def _worker_solve(task: tuple) -> dict:
    """Solve one (bots, operators, seed) point in a worker process."""
    n_bots, ops, seed, max_waves, time_buffer_s, budget_s = task
    rng = random.Random(seed)
    bots = build_bots_from_config(_W_GRAPH, _W_GROUPS, n_bots,
                                   _W_KIN_UL, _W_KIN_LD, _W_SVC, rng)
    total_cases = sum(b.cases_picked for b in bots)
    t0 = time.time()
    best = None
    for w in range(1, max_waves + 1):
        res = solve_wave_schedule(bots, waves=w, time_buffer_s=time_buffer_s,
                                  seed=seed, max_time_s=budget_s,
                                  operators_per_station=ops,
                                  solver_threads=_W_THREADS)
        if res is None:
            if best is not None:
                break
            continue
        presentations_ph = n_bots * 3600.0 / res["wave_offset_s"] if res["wave_offset_s"] else 0.0
        picks_ph = total_cases * 3600.0 / res["wave_offset_s"] if res["wave_offset_s"] else 0.0
        res["presentations_ph"] = presentations_ph
        res["picks_ph"] = picks_ph
        res["pph"] = picks_ph  # primary metric is now picks/hr
        res["total_cases_per_wave"] = total_cases
        res["waves"] = w
        if best is None or picks_ph > best["picks_ph"]:
            best = res
    dt = time.time() - t0
    if best is None:
        best = {"pph": 0.0, "presentations_ph": 0.0, "picks_ph": 0.0,
                "wave_offset_s": 0, "makespan_s": 0, "waves": 0,
                "peak_queue_depth": 0, "avg_op_utilization": 0.0,
                "total_cases_per_wave": 0, "status": "INFEASIBLE"}
    return {"n_bots": n_bots, "ops": ops, "seed": seed, "res": best, "dt": dt}


# ── Pareto frontier ──

def compute_pareto_frontier(aggregates: list[dict]) -> list[dict]:
    """Extract Pareto-optimal (bots, operators) → PPH points.

    A point is Pareto-optimal if no other point achieves ≥ PPH with both
    ≤ bots AND ≤ operators.
    """
    sorted_pts = sorted(aggregates, key=lambda p: -p["mean_pph"])
    frontier = []
    for pt in sorted_pts:
        if pt["mean_pph"] <= 0:
            continue
        dominated = False
        for f in frontier:
            if (f["bot_count"] <= pt["bot_count"] and
                f["operators_per_station"] <= pt["operators_per_station"] and
                f["mean_pph"] >= pt["mean_pph"]):
                dominated = True
                break
        if not dominated:
            frontier.append(pt)
    return sorted(frontier, key=lambda p: (p["operators_per_station"], p["bot_count"]))


# ── Phase classification (optional) ──

def classify_phase(prev_marginal: float | None, first_marginal: float | None,
                   any_deadlock: bool) -> str:
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


# ── Main sweep ──

def run_sweep(cfg: FullConfig, output_dir: Path) -> dict:
    """Execute the full (bots × operators × seeds) sweep grid."""
    output_dir.mkdir(parents=True, exist_ok=True)
    sc = cfg.slice
    sw = cfg.sweep

    logger.info("Loading graph: %s", sc.graph_path)
    graph = extract_subgraph(sc.graph_path, sc.slice)
    logger.info("  %d nodes, %d edges", graph.number_of_nodes(), graph.number_of_edges())

    errors = validate_config(cfg, graph)
    if errors:
        for e in errors:
            logger.error("Config error: %s", e)
        raise ValueError(f"{len(errors)} config validation error(s)")

    total_stations = sum(len(g.stations) for g in sc.station_groups)
    logger.info("  %d stations across %d groups", total_stations, len(sc.station_groups))

    # Build task grid
    tasks = [(n, ops, seed, sw.max_waves, sw.time_buffer_s, sw.solver_budget_s)
             for ops in sw.operator_counts
             for n in sw.bot_counts
             for seed in sw.seeds]

    # Serialize config for workers (dataclasses → dicts)
    import dataclasses
    slice_dict = dataclasses.asdict(sc.slice)
    groups_dicts = [dataclasses.asdict(g) for g in sc.station_groups]
    svc_dict = dataclasses.asdict(sc.service_time)

    # Dispatch
    results: list[dict] = []
    if sw.workers > 1:
        ncpu = os.cpu_count() or 8
        st = sw.solver_threads if sw.solver_threads else max(1, ncpu // sw.workers)
        logger.info("Parallel: %d workers × %d threads across %d tasks", sw.workers, st, len(tasks))
        t0 = time.time()
        with ProcessPoolExecutor(
            max_workers=sw.workers,
            initializer=_worker_init,
            initargs=(sc.graph_path, slice_dict, groups_dicts, svc_dict, st),
        ) as pool:
            futures = {pool.submit(_worker_solve, t): t for t in tasks}
            for fut in as_completed(futures):
                r = fut.result()
                results.append(r)
                res = r["res"]
                logger.info("  [ops=%d n=%d seed=%d] %s w=%d pph=%.1f (%.1fs)",
                            r["ops"], r["n_bots"], r["seed"],
                            res["status"], res["waves"], res["pph"], r["dt"])
        logger.info("Pool wall time: %.1fs", time.time() - t0)
    else:
        svc = ServiceTimeModel(sc.service_time)
        for n, ops, seed, mw, tb, budget in tasks:
            rng = random.Random(seed)
            bots = build_bots_from_config(graph, sc.station_groups, n,
                                           DEFAULT_UNLOADED, DEFAULT_LOADED, svc, rng)
            t0 = time.time()
            best = None
            for w in range(1, mw + 1):
                res = solve_wave_schedule(bots, waves=w, time_buffer_s=tb,
                                          seed=seed, max_time_s=budget,
                                          operators_per_station=ops)
                if res is None:
                    if best is not None:
                        break
                    continue
                pph = n * 3600.0 / res["wave_offset_s"] if res["wave_offset_s"] else 0.0
                res["pph"] = pph
                res["waves"] = w
                if best is None or pph > best["pph"]:
                    best = res
            dt = time.time() - t0
            if best is None:
                best = {"pph": 0.0, "wave_offset_s": 0, "makespan_s": 0, "waves": 0,
                        "peak_queue_depth": 0, "avg_op_utilization": 0.0,
                        "status": "INFEASIBLE"}
            results.append({"n_bots": n, "ops": ops, "seed": seed, "res": best, "dt": dt})
            logger.info("  [ops=%d n=%d seed=%d] %s w=%d pph=%.1f (%.1fs)",
                        ops, n, seed, best["status"], best["waves"], best["pph"], dt)

    # Aggregate per (ops, n_bots)
    per_key: dict[tuple[int, int], list[dict]] = {}
    for r in results:
        per_key.setdefault((r["ops"], r["n_bots"]), []).append(r)

    rows: list[dict] = []
    aggregates: list[dict] = []

    for ops in sw.operator_counts:
        prev_agg = None
        first_marginal = None
        for bi, n in enumerate(sw.bot_counts):
            pts = sorted(per_key.get((ops, n), []), key=lambda x: x["seed"])
            pphs = [p["res"]["pph"] for p in pts]
            good = [p for p in pphs if p > 0]
            deadlock = any(p == 0 for p in pphs)

            mean_pph = sum(good) / len(good) if good else 0.0
            p5 = min(good) if good else 0.0
            p95 = max(good) if good else 0.0

            if bi == 0 or prev_agg is None:
                first_marginal = mean_pph / n if n else 0.0
                marginal = first_marginal
            else:
                dn = n - prev_agg["bot_count"]
                marginal = (mean_pph - prev_agg["mean_pph"]) / dn if dn else 0.0

            phase = classify_phase(marginal, first_marginal, deadlock) if sw.classify_phases else ""

            agg = {
                "bot_count": n,
                "operators_per_station": ops,
                "mean_pph": round(mean_pph, 1),
                "p5_pph": round(p5, 1),
                "p95_pph": round(p95, 1),
                "phase": phase,
                "seeds": len(good),
            }
            aggregates.append(agg)
            prev_agg = agg
            logger.info("  AGG ops=%d n=%d pph=%.1f phase=%s", ops, n, mean_pph, phase)

            for p in pts:
                res = p["res"]
                rows.append({
                    "bot_count": n,
                    "operators_per_station": ops,
                    "seed": p["seed"],
                    "mean_pph": round(res["pph"], 1),
                    "p5_pph": round(p5, 1),
                    "p95_pph": round(p95, 1),
                    "waves": res["waves"],
                    "wave_offset_s": res.get("wave_offset_s", 0),
                    "peak_queue_depth": res.get("peak_queue_depth", 0),
                    "avg_op_utilization": round(res.get("avg_op_utilization", 0), 3),
                    "deadlocks": 1 if res["pph"] == 0 else 0,
                    "phase": phase,
                    "status": res["status"],
                    "solver_s": round(p["dt"], 2),
                })

    # Pareto frontier
    frontier = compute_pareto_frontier(aggregates)
    logger.info("Pareto frontier: %d points", len(frontier))
    for f in frontier:
        logger.info("  ops=%d n=%d → %.1f PPH", f["operators_per_station"], f["bot_count"], f["mean_pph"])

    # Derive a name from the config (first station group label or graph filename)
    name = sc.station_groups[0].label if sc.station_groups else Path(sc.graph_path).stem

    # Write CSV
    csv_path = output_dir / f"sweep_results_{name}.csv"
    fieldnames = ["bot_count", "operators_per_station", "seed", "mean_pph",
                  "p5_pph", "p95_pph", "deadlocks", "peak_queue_depth",
                  "avg_op_utilization", "phase", "waves", "wave_offset_s",
                  "status", "solver_s"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})
    logger.info("Wrote %s (%d rows)", csv_path, len(rows))

    # Write aggregates JSON
    agg_path = output_dir / f"sweep_aggregates_{name}.json"
    with open(agg_path, "w") as f:
        json.dump({
            "name": name,
            "graph_path": sc.graph_path,
            "num_stations": total_stations,
            "station_groups": [{"label": g.label, "count": len(g.stations)}
                               for g in sc.station_groups],
            "sweep": {"bot_counts": sw.bot_counts, "operator_counts": sw.operator_counts,
                      "seeds": sw.seeds, "max_waves": sw.max_waves},
            "points": aggregates,
            "pareto_frontier": frontier,
        }, f, indent=2)
    logger.info("Wrote %s", agg_path)

    return {"csv_path": str(csv_path), "agg_path": str(agg_path),
            "aggregates": aggregates, "pareto_frontier": frontier}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", nargs="+", required=True,
                    help="YAML config file(s), merged left to right")
    ap.add_argument("--set", nargs="*", default=[],
                    help="CLI overrides as dotted key=value (e.g., sweep.workers=3)")
    ap.add_argument("--output", default="output/sweep_v2",
                    help="Output directory")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    overrides = parse_cli_overrides(args.set)

    # Resolve config file paths relative to CWD (they're CLI arguments)
    resolved_configs = [str(Path(c).resolve()) for c in args.config]

    # Graph paths in config should resolve relative to repo root
    repo_root = Path(__file__).resolve().parent
    for anc in repo_root.parents:
        if (anc / ".git").exists():
            repo_root = anc
            break

    cfg = load_config(*resolved_configs, overrides=overrides, config_dir=repo_root)

    t0 = time.time()
    result = run_sweep(cfg, Path(args.output))
    logger.info("Total time: %.1fs", time.time() - t0)

    # Print Pareto summary
    print("\n=== Pareto Frontier ===")
    print(f"{'Ops':>4s} {'Bots':>5s} {'PPH':>8s}")
    for f in result["pareto_frontier"]:
        print(f"{f['operators_per_station']:>4d} {f['bot_count']:>5d} {f['mean_pph']:>8.1f}")


if __name__ == "__main__":
    main()
