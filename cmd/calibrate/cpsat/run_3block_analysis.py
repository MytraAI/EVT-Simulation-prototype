#!/usr/bin/env python3
"""Full 3-block station analysis: sweep, Pareto chart, report, GIF.

Runs the operator × bot Pareto sweep on the 3-block west slice with:
  - Full station lock (own XY + shared XY blocked during service)
  - Arrival clearance penalty (operator clears station while bot arrives)
  - Empirical case sampling from SFDC outbound data
  - Detailed metrics: picks/hr, cases/pres, bot subsystem time,
    operator util, station util

Outputs to GCS bucket and local /tmp.
"""

from __future__ import annotations
import sys, json, csv, time, random, logging, os, dataclasses
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import defaultdict
sys.path.insert(0, str(Path(__file__).parent))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from config_schema import load_config
from graph_slice import extract_subgraph
from station_plan import (ServiceTimeModel, build_bots_from_config,
                          compute_transit_matrix, solve_with_operators)
from graph_utils import DEFAULT_UNLOADED, DEFAULT_LOADED

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger()
REPO = Path(__file__).resolve().parents[3]


# ── Worker pool ──

def worker_init(graph_path, slice_dict, groups_dicts, svc_dict, transit_dict):
    global _G, _GROUPS, _SVC, _TRANSIT
    from config_schema import SliceSpec, StationGroupConfig, ServiceTimeConfig, _dict_to_dataclass
    _G = extract_subgraph(graph_path, _dict_to_dataclass(SliceSpec, slice_dict))
    _GROUPS = [_dict_to_dataclass(StationGroupConfig, d) for d in groups_dicts]
    _SVC = ServiceTimeModel(_dict_to_dataclass(ServiceTimeConfig, svc_dict))
    _TRANSIT = transit_dict


def worker_solve(task):
    n_bots, n_ops, seed, max_time_s = task
    rng = random.Random(seed)
    bots = build_bots_from_config(_G, _GROUPS, n_bots, DEFAULT_UNLOADED, DEFAULT_LOADED, _SVC, rng)
    total_cases = sum(b.cases_picked for b in bots)
    avg_cases_per_pres = total_cases / n_bots if n_bots else 1

    t0 = time.time()
    best = None
    for w in [2, 1]:
        res = solve_with_operators(bots, n_ops, _TRANSIT, waves=w, seed=seed,
                                    max_time_s=max_time_s, solver_threads=1,
                                    station_groups_cfg=_GROUPS, graph=_G)
        if res is None:
            if best is not None: break
            continue
        wo = res["wave_offset_s"]
        picks_ph = total_cases * 3600.0 / wo if wo else 0
        pres_ph = n_bots * 3600.0 / wo if wo else 0
        if best is None or picks_ph > (best.get("picks_ph") or 0):
            best = {
                **res,
                "picks_ph": round(picks_ph, 1),
                "presentations_ph": round(pres_ph, 1),
                "cases_per_pres": round(avg_cases_per_pres, 2),
                "total_cases": total_cases,
                "waves_used": w,
            }
    dt = time.time() - t0
    if best is None:
        best = {"status": "INFEASIBLE", "picks_ph": 0, "presentations_ph": 0,
                "cases_per_pres": avg_cases_per_pres, "total_cases": total_cases,
                "avg_bot_subsystem_s": 0, "avg_op_utilization": 0,
                "avg_station_utilization": 0, "wave_offset_s": 0, "waves_used": 0}
    return {"bots": n_bots, "ops": n_ops, "seed": seed, "dt": dt, **best}


# ── Pareto ──

def compute_pareto(agg):
    frontier = []
    for pt in sorted(agg, key=lambda p: -p["mean_picks_ph"]):
        if pt["mean_picks_ph"] <= 0: continue
        if not any(f["bots"] <= pt["bots"] and f["operators"] <= pt["operators"]
                  and f["mean_picks_ph"] >= pt["mean_picks_ph"] for f in frontier):
            frontier.append(pt)
    return sorted(frontier, key=lambda p: (p["operators"], p["bots"]))


# ── Chart ──

def plot_pareto(agg, frontier, n_stn, out_path):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 7), facecolor="#0d1117")
    for ax in [ax1, ax2]:
        ax.set_facecolor("#0d1117")
        ax.tick_params(colors="#c9d1d9")
        for sp in ax.spines.values(): sp.set_color("#30363d")

    # Left: Picks/hr heatmap (ops × bots)
    ops_vals = sorted(set(r["operators"] for r in agg))
    bot_vals = sorted(set(r["bots"] for r in agg))
    grid = np.zeros((len(ops_vals), len(bot_vals)))
    for r in agg:
        i = ops_vals.index(r["operators"])
        j = bot_vals.index(r["bots"])
        grid[i, j] = r["mean_picks_ph"]

    im = ax1.imshow(grid, aspect="auto", cmap="YlOrRd", origin="lower",
                    extent=[bot_vals[0]-0.5, bot_vals[-1]+0.5, ops_vals[0]-0.5, ops_vals[-1]+0.5])
    for r in agg:
        if r["mean_picks_ph"] > 0:
            ax1.text(r["bots"], r["operators"], f"{r['mean_picks_ph']:.0f}",
                    ha="center", va="center", fontsize=7, color="black" if r["mean_picks_ph"] > 200 else "white")
    # Mark Pareto points
    for f in frontier:
        ax1.scatter(f["bots"], f["operators"], s=100, marker="*", color="#00e5ff", zorder=5, edgecolors="white")
    ax1.set_xlabel("Bots", color="#c9d1d9")
    ax1.set_ylabel("Operators", color="#c9d1d9")
    ax1.set_title(f"Picks/hr Heatmap ({n_stn} stations)\n★ = Pareto optimal", color="#c9d1d9", fontsize=12)
    plt.colorbar(im, ax=ax1, label="Picks/hr")

    # Right: Pareto frontier curve
    if frontier:
        f_ops = [f["operators"] for f in frontier]
        f_pph = [f["mean_picks_ph"] for f in frontier]
        f_ppo = [f["mean_picks_ph"] / f["operators"] for f in frontier]
        ax2.plot(f_ops, f_pph, "o-", color="#00e5ff", linewidth=2, markersize=8, label="Picks/hr")
        ax2_r = ax2.twinx()
        ax2_r.plot(f_ops, f_ppo, "s--", color="#ff7043", linewidth=1.5, markersize=6, label="Picks/op/hr")
        ax2_r.set_ylabel("Picks / operator / hr", color="#ff7043")
        ax2_r.tick_params(colors="#ff7043")
        for sp in ax2_r.spines.values(): sp.set_color("#30363d")
        ax2.set_xlabel("Operators", color="#c9d1d9")
        ax2.set_ylabel("Picks/hr (total)", color="#00e5ff")
        ax2.set_title("Pareto Frontier: Throughput vs Labor", color="#c9d1d9", fontsize=12)
        ax2.legend(loc="upper left", facecolor="#161b22", edgecolor="#30363d", labelcolor="#c9d1d9")
        ax2_r.legend(loc="lower right", facecolor="#161b22", edgecolor="#30363d", labelcolor="#c9d1d9")

    fig.suptitle(f"Station Subsystem Capacity — 3-Block West Slice ({n_stn} stations)",
                 color="#58a6ff", fontsize=14, y=0.98)
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(out_path, dpi=150, facecolor="#0d1117")
    plt.close(fig)
    logger.info(f"Chart → {out_path}")


# ── Report ──

def write_report(agg, frontier, cfg, svc, transit, n_stn, out_path):
    lines = []
    lines.append("# Station Subsystem Capacity Analysis — 3-Block West Slice")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Layout:** 3 station blocks (7 rows each), gap=1, {n_stn} stations")
    lines.append(f"**Graph:** `{cfg.slice.graph_path}`")
    lines.append("")

    # Data source
    lines.append("## Data Sources & Distributions")
    lines.append("")
    lines.append("### Pick-time distribution")
    lines.append("- **Source:** Grainger W004 SFDC outbound data (Q1-Q4 2025), ~2.5M PICK rows")
    lines.append("- **Bucket:** `gs://solution-design-raw/machine_readable_data/`")
    lines.append("- **Classification:** Grainger Master Code Definitions")
    lines.append("  - `CON2` (casepick conveyable, top-offs): 1.27M rows → `casepick_conv`")
    lines.append("- **Type mix at stations:** 100% `casepick_conv` (conveyable only — NCV excluded)")
    lines.append("- **Rationale:** west slice stations handle only conveyable casepick; non-conveyable goes to separate NCV stations")
    lines.append("- **Cases/Line distribution** (per presentation):")
    lines.append("  | Bucket | Probability | p50 cycle (s) | Avg cases/line |")
    lines.append("  |---|---:|---:|---:|")
    lines.append("  | 1 case | 82.3% | 48s | 1.0 |")
    lines.append("  | 2-3 cases | 11.1% | 63s | 2.3 |")
    lines.append("  | 4-6 cases | 4.0% | 75s | 4.7 |")
    lines.append("  | 7-12 cases | 1.6% | 88s | 9.4 |")
    lines.append("  | 13+ cases | 1.0% | 109s | 62.9 |")
    lines.append("  - **Weighted avg: ~1.7 cases/presentation** (CON2 conveyable only)")
    lines.append("")

    lines.append("### Operator timing model")
    lines.append(f"- **Arrival clearance:** {svc.arrival_clearance_s}s (operator clears station area for safety while bot docks)")
    lines.append(f"- **Identify:** {svc.IDENTIFY_S}s (scan pallet label)")
    lines.append(f"- **Handle:** variable (sampled from empirical distribution above)")
    lines.append(f"- **Confirm:** {svc.CONFIRM_S}s")
    lines.append(f"- **Bot dwell at station** = clearance + identify + handle + confirm")
    lines.append(f"- **Operator cycle** = bot dwell + 2 × walk to drop-off ({svc.walk_distances}m at {svc.walk_speed}m/s)")
    lines.append(f"- **PEZ tray drop:** {svc.pez_dwell_s}s (bot drops empty tray after service)")
    lines.append("")

    lines.append("### Station constraints")
    lines.append("- **Block lock:** shared XY gateway between station pairs acts as mutex — only 1 service per block at a time")
    lines.append("- **XY lock:** each station's dedicated XY is reserved from approach through service end")
    lines.append("- **Station wall:** north-south (y-axis) travel only; x-axis access exclusively through XY gateways")
    t_vals = [v for v in transit.values() if v > 0]
    lines.append(f"- **Operator transit:** {min(t_vals)}–{max(t_vals)}s between stations (shortest-path walking)")
    lines.append("")

    lines.append("### Assumptions")
    lines.append("- Empty pallet zones (all positions traversable)")
    lines.append("- Bots enter/exit from east boundary (gx=-47 aisle)")
    lines.append("- Wave-based scheduling (CP-SAT optimal coordination, 2 waves)")
    lines.append("- Operators assigned via FCFS with transit (solver optimizes assignment)")
    lines.append("- Picks/hr = total cases per wave × 3600 / wave_offset")
    lines.append("")

    # Results table
    lines.append("## Results")
    lines.append("")
    lines.append("| Ops | Bots | Picks/hr | Pres/hr | Cases/pres | Bot time (s) | Op util | Stn util | Feasible |")
    lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in sorted(agg, key=lambda x: (x["operators"], x["bots"])):
        m = " **★**" if r in frontier else ""
        lines.append(f"| {r['operators']} | {r['bots']} | {r['mean_picks_ph']:.0f}{m} | "
                     f"{r['mean_pres_ph']:.0f} | {r['mean_cases_per_pres']:.1f} | "
                     f"{r['mean_bot_subsystem_s']:.0f} | {r['mean_op_util']:.0%} | "
                     f"{r['mean_stn_util']:.0%} | {r['feasible']}/{r['total']} |")
    lines.append("")

    # Pareto
    lines.append("## Pareto Frontier")
    lines.append("")
    lines.append("| Ops | Bots | Picks/hr | Picks/op/hr | Insight |")
    lines.append("|---:|---:|---:|---:|---|")
    for i, f in enumerate(frontier):
        ppo = f["mean_picks_ph"] / f["operators"] if f["operators"] else 0
        if i == 0:
            insight = "Min labor, best efficiency"
        elif i == len(frontier) - 1:
            insight = "Max throughput"
        elif ppo > 60:
            insight = "High efficiency"
        else:
            insight = "Sweet spot" if 40 < ppo < 70 else ""
        lines.append(f"| {f['operators']} | {f['bots']} | {f['mean_picks_ph']:.0f} | {ppo:.0f} | {insight} |")
    lines.append("")

    out_path.write_text("\n".join(lines))
    logger.info(f"Report → {out_path}")


# ── Main ──

def main():
    cfg = load_config(REPO / 'cmd/calibrate/cpsat/configs/west_3block.yaml', config_dir=REPO)
    graph = extract_subgraph(cfg.slice.graph_path, cfg.slice.slice)
    svc = ServiceTimeModel(cfg.slice.service_time)
    transit = compute_transit_matrix(graph, cfg.slice.station_groups, svc.walk_speed)
    n_stn = sum(len(g.stations) for g in cfg.slice.station_groups)

    logger.info(f"3-block: {n_stn} stations, clearance={svc.arrival_clearance_s}s")

    # Sweep grid: ops from 0.25× to 4× stations, bots from n to 4n by 1
    n_blocks = n_stn // 2  # 3 blocks
    op_counts = sorted(set([max(1, n_blocks // 2), n_blocks, n_stn, n_stn + n_blocks,
                            n_stn * 2, n_stn * 3, n_stn * 4]))
    bot_counts = list(range(n_stn, n_stn * 4 + 1))
    seeds = [1, 2, 3]

    # Prune infeasible: skip ops < bots/6
    tasks = [(nb, no, s, 25) for no in op_counts for nb in bot_counts for s in seeds
             if no >= max(1, nb // 6)]
    logger.info(f"ops={op_counts}, bots={bot_counts}, {len(tasks)} tasks")

    slice_d = dataclasses.asdict(cfg.slice.slice)
    groups_d = [dataclasses.asdict(g) for g in cfg.slice.station_groups]
    svc_d = dataclasses.asdict(cfg.slice.service_time)

    results = []
    t0 = time.time()
    workers = min(os.cpu_count() or 8, len(tasks))
    with ProcessPoolExecutor(max_workers=workers,
                              initializer=worker_init,
                              initargs=(cfg.slice.graph_path, slice_d, groups_d, svc_d,
                                       {k: v for k, v in transit.items()})) as pool:
        futs = {pool.submit(worker_solve, t): t for t in tasks}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            s = f"{r['picks_ph']:.0f}" if r.get('picks_ph') else "INFEAS"
            logger.info(f"  ops={r['ops']:2d} n={r['bots']:2d} seed={r['seed']} → {s} picks/hr ({r['dt']:.1f}s)")

    logger.info(f"Pool done in {time.time()-t0:.0f}s ({len(tasks)} tasks, {workers} workers)")

    # Aggregate
    by_key = defaultdict(list)
    for r in results: by_key[(r["ops"], r["bots"])].append(r)

    agg = []
    for (ops, bots), rs in sorted(by_key.items()):
        good = [r for r in rs if r.get("picks_ph", 0) > 0]
        if not good:
            agg.append({"operators": ops, "bots": bots, "mean_picks_ph": 0, "mean_pres_ph": 0,
                        "mean_cases_per_pres": 0, "mean_bot_subsystem_s": 0,
                        "mean_op_util": 0, "mean_stn_util": 0,
                        "feasible": 0, "total": len(rs)})
            continue
        agg.append({
            "operators": ops, "bots": bots,
            "mean_picks_ph": round(sum(r["picks_ph"] for r in good) / len(good), 1),
            "mean_pres_ph": round(sum(r["presentations_ph"] for r in good) / len(good), 1),
            "mean_cases_per_pres": round(sum(r["cases_per_pres"] for r in good) / len(good), 2),
            "mean_bot_subsystem_s": round(sum(r.get("avg_bot_subsystem_s", 0) for r in good) / len(good), 1),
            "mean_op_util": round(sum(r.get("avg_op_utilization", 0) for r in good) / len(good), 3),
            "mean_stn_util": round(sum(r.get("avg_station_utilization", 0) for r in good) / len(good), 3),
            "feasible": len(good), "total": len(rs),
        })

    frontier = compute_pareto(agg)

    # Output
    out = Path("/tmp/3block_analysis")
    out.mkdir(exist_ok=True)

    # Chart
    plot_pareto(agg, frontier, n_stn, out / "pareto_chart.png")

    # Report
    write_report(agg, frontier, cfg, svc, transit, n_stn, out / "ANALYSIS.md")

    # CSV
    csv_path = out / "sweep_results.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["operators", "bots", "mean_picks_ph", "mean_pres_ph",
                                           "mean_cases_per_pres", "mean_bot_subsystem_s",
                                           "mean_op_util", "mean_stn_util", "feasible", "total"])
        w.writeheader()
        for r in agg: w.writerow(r)

    # JSON
    with open(out / "pareto.json", "w") as f:
        json.dump({"n_stations": n_stn, "results": agg, "frontier": frontier,
                   "config": {"arrival_clearance_s": svc.arrival_clearance_s,
                              "pez_dwell_s": svc.pez_dwell_s}}, f, indent=2)

    # Find sweet spot for GIF
    sweet = max((f for f in frontier if f["operators"] <= n_stn),
                key=lambda f: f["mean_picks_ph"] / f["operators"],
                default=frontier[0] if frontier else None)
    if sweet:
        logger.info(f"\nSweet spot: ops={sweet['operators']} bots={sweet['bots']} → {sweet['mean_picks_ph']:.0f} picks/hr")
        # Generate GIF
        import visualize
        all_ops = {n for n, d in graph.nodes(data=True) if d.get("kind") == "STATION_OP"}
        visualize.ALL_OPS = all_ops
        visualize.SOUTH_CASEPICK_OPS = all_ops
        visualize.EAST_FULLCASE_OPS = set()
        visualize.ALL_ENTRIES = set(cfg.slice.station_groups[0].entry_points)
        visualize.ALL_EXITS = set(cfg.slice.station_groups[0].exit_points)

        rng = random.Random(1)
        bots = build_bots_from_config(graph, cfg.slice.station_groups, sweet["bots"],
                                       DEFAULT_UNLOADED, DEFAULT_LOADED, svc, rng)
        res = solve_with_operators(bots, sweet["operators"], transit, waves=2, seed=1,
                                   max_time_s=30, station_groups_cfg=cfg.slice.station_groups, graph=graph)
        if res:
            wo = res["wave_offset_s"]
            steps = []
            for wi in range(2):
                t_off = wi * wo
                for b in bots:
                    t = t_off
                    for cell, dur in zip(b.cells, b.durations):
                        steps.append({"bot_id": b.bot_id + wi * len(bots), "cell_id": cell,
                                      "start": int(t), "end": int(t + dur), "duration": dur})
                        t += dur
            schedule = {"steps": steps, "waves": 2, "wave_offset_s": wo,
                        "pph": sweet["mean_picks_ph"], "bots": sweet["bots"],
                        "bot_configs": [{"type": b.pick_type, "station": b.station_op} for b in bots] * 2}
            visualize.render_gif(graph, schedule,
                                 out / f"anim_sweet_ops{sweet['operators']}_bots{sweet['bots']}.gif",
                                 layout=f"Sweet Spot ({sweet['operators']}ops, {sweet['bots']}bots, {sweet['mean_picks_ph']:.0f} picks/hr)",
                                 step_s=2.0, fps=8, max_frames=80)

    # Upload to bucket
    logger.info("\nUploading to GCS...")
    import subprocess
    for f in out.glob("*"):
        if f.is_file():
            subprocess.run(["gsutil", "cp", str(f),
                           f"gs://solution-design-raw/project_maps/grainger/results/3block_analysis/{f.name}"],
                          capture_output=True)
            logger.info(f"  ↑ {f.name}")

    logger.info("\nDone. Results at gs://solution-design-raw/project_maps/grainger/results/3block_analysis/")

    # Print Pareto summary
    print(f"\n{'='*60}")
    print(f"PARETO FRONTIER — 3-Block West Slice ({n_stn} stations)")
    print(f"{'='*60}")
    print(f"{'Ops':>4s} {'Bots':>5s} {'Picks/hr':>9s} {'Picks/op':>9s} {'Op util':>8s} {'Stn util':>9s}")
    print("-" * 50)
    for f in frontier:
        ppo = f["mean_picks_ph"] / f["operators"] if f["operators"] else 0
        print(f"{f['operators']:>4d} {f['bots']:>5d} {f['mean_picks_ph']:>9.0f} {ppo:>9.0f} "
              f"{f['mean_op_util']:>7.0%} {f['mean_stn_util']:>8.0%}")


if __name__ == "__main__":
    main()
