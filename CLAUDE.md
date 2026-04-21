# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
make setup          # First-time: install npm deps + build Go WASM pathfinder
make dev            # Vite dev server on localhost:5173
make wasm           # Rebuild Go WASM after editing wasm/*.go
make build          # Production build
make clean          # Remove all build artifacts
```

**Go calibration runner** (headless congestion sweep):
```bash
go run ./cmd/calibrate --map grainger-pilot-Scp.json \
    --bots 1,2,4,6,8,10,15,20 --shifts 10 --pallets 200
```

**CP-SAT station capacity sweep** (Python, requires `.venv`):
```bash
python3 -m venv .venv && .venv/bin/pip install ortools networkx pandas matplotlib duckdb pyarrow plotly pillow
.venv/bin/python cmd/calibrate/cpsat/run_sweep.py --layout Scp \
    --bots 4,6,8,10,12,16,20 --seeds 1,2,3 --max-waves 2 --workers 3 \
    --output output/sweep
.venv/bin/python cmd/calibrate/cpsat/analyze_sweep.py --dir output/sweep
```

**Station-sim web UI** (interactive CP-SAT solver):
```bash
cd station-sim && python server.py  # localhost:8090
```

**Empirical pick-time extraction** (needs GCS access to `gs://solution-design-raw`):
```bash
.venv/bin/python cmd/calibrate/cpsat/extract_pick_times.py --output output/empirical
```

## Architecture

Five engines that share the same warehouse graph format but serve different purposes:

1. **React/Vite frontend** (`app/src/`) — Interactive 3D/2D sim with animated bot playback. TypeScript time-stepped engine (`simulation/engine.ts`) ticks at 1 tick = 1 second.
2. **Go WASM pathfinder** (`wasm/`) — Dijkstra with direction-dependent costs (XY turn: 2s, XY↔Z transition: 3s). Compiled to `app/public/pathfinder.wasm`. JS fallback in `wasm-bridge.ts`.
3. **Go calibration runner** (`cmd/calibrate/main.go`) — Headless goroutine-parallel congestion calibration. Runs time-stepped sim with Cooperative A\* (`mapf.go`) at sampled bot counts, producing a congestion penalty curve. Operator model in `operator.go` (identify → handle → confirm state machine).
4. **Python CP-SAT solver** (`cmd/calibrate/cpsat/`) — Wave-based job-shop scheduler using OR-Tools. Sweeps bot count × operator count × seeds. Models bot cell-dwell vs operator cycle (cumulative resource). Also handles async scheduling mode for persistent-fleet validation.
5. **DES engine** (`app/src/simulation/des-engine.ts`) — Fast event-driven sim for fleet sizing. Congestion penalty from Go calibration applied via interpolation (`congestion-calibration.ts`).

### Data flow

```
Pilot graph JSON (grainger-pilot-{Scp,Ep-Sc}.json)
  → extract_south_zone() slices to grid_y ≤ 12 (south stations)
  → CP-SAT builds per-bot cell paths + operator intervals
  → solve_wave_schedule() minimizes wave_offset (or makespan in async)
  → sweep aggregates per (bot_count, operator_count, seed)
  → analyze_sweep.py produces chart + capacity table + INTERPRETATION.md
```

Empirical service times flow separately:
```
GCS outbound CSVs → extract_pick_times.py → presentation_distribution.parquet
  → run_sweep.py samples (sim_type, Cases/Line bucket) per bot
  → pick_time_s = p50 of that bucket + 5s overhead
```

## Key Conventions

**Axis convention (Grainger pilot):** grid_y=0 is SOUTH (y_m ≈ 0.51m), grid_y=46 is NORTH (y_m ≈ 71.12m). Defined in `cmd/calibrate/cpsat/graph_utils.py`. The Go zone sim (`cmd/calibrate/zone.go`) and the CP-SAT path use the same convention.

**Station specialization:** South baseline stations (`op-{4,8,12,16}-0`) do casepick only. East Ep stations (`op-21-{4,7,10}`) do full-case only. Enforced by `build_station_groups()` in `run_sweep.py`.

**Bot dwell vs operator cycle:** The bot physically stays at the op cell for `pick_time_s` (the picking portion). The operator continues walking to drop-off after the bot leaves. CP-SAT enforces both: cell no-overlap on `pick_time_s`, cumulative operator resource on `operator_cycle_s`. With `operators_per_station > 1`, multiple operators can overlap (cumulative constraint).

**Node ID format:** `a-{level}-{gx}-{gy}` for aisles, `p-{level}-{gy}-{gx}-{depth}` for pallets, `op-{gx}-{gy}` for stations, `xy-{gx}-{gy}` for gateways, `pez-{gx}-{gy}` for PEZ cells.

**Timing:** 1 tick = 1 second in both the TS engine and Go calibration runner. CP-SAT durations are integer seconds.

**Pick-type classification (Grainger Master Codes):**
- CON1 → `full_case_conv` (Bulk Conveyables, Pallets)
- CON2 → `casepick_conv` (Conveyables, Top-Offs / pick bins)
- NC01/LTL\*/NRAW → `full_case_ncv`
- NC02/NC03 → `casepick_ncv`

## CP-SAT Solver Performance

- Per-solve budget: 15s (tight — infeasible cases bail fast)
- `--workers 3` with default CP-SAT threading gives ~3× speedup on 22-CPU VM
- Full sweep (8 bot counts × 3 seeds × 2 waves): ~5 min serial, ~2 min with workers=3
- Wave mode cliff at n=8–10 (Scp) / n=10–14 (Ep-Sc) is a scheduler artifact, not physical collapse — validated by async mode producing a monotonic curve

## Loom Integration

The canonical copy of station-capacity code lives in `loom` repo at `projects/grainger_pilot/experiments/station_capacity/` on branch `pranav/bot-count-analysis`. This EVT repo is the development sandbox. Sync changes to loom via copy + commit.

Profile report integration: `analysis/profiling/report.py` Section 9 auto-renders station capacity deliverables if present under `experiments/station_capacity/deliverables/`.
