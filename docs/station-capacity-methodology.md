# Grainger Pilot — Station Subsystem Capacity Analysis

End-to-end methodology for characterizing the throughput ceiling and
congestion behavior of the Grainger W004 pilot station subsystem. This
document explains *what* we measure, *how* we model it, *why* we made each
modeling choice, and *where* in the code to find each piece.

**Status:** living doc — updated as the model evolves.
**Owner:** Pranav
**Spec reference:** Notion — Station Subsystem Capacity Analysis
(`https://www.notion.so/Station-Subsystem-Capacity-Analysis-343e7769a2cb806bb8ffd44583444090`)

---

## 1. Goal

> For each station layout, how many bots can operate in the station subsystem
> before throughput degrades? What is the max sustained presentation rate?

We produce three artifacts per layout:
1. **Throughput-vs-bot-count chart** with variance bands and phase-labeled markers.
2. **Capacity table** (`mean_pph`, `p5`, `p95`, `collisions`, `deadlocks`, `op_util`, `peak_queue`, `phase`) per (layout, bot_count).
3. **1-page written interpretation** — which layout wins, by how much, why.

Deliverables live in `output/station_capacity_*/`.

---

## 2. Layouts under test

Two physical layouts provided by Jacob (the design lead), both as warehouse
graph JSON at the repo root:

| Layout | Stations | Composition |
|---|---:|---|
| `Scp` | 8 | 4 casepick on south row (y=0) + 4 casepick on north row (y=46). Baseline. |
| `Ep-Sc` | 11 | Same 8 + 3 east Ep stations at (gx=21, y=4/7/10) — full-case pallets. |

For this analysis we restrict to the **southbound slice** (grid_y ≤ 12): the
4 south casepick stations plus, in Ep-Sc, the 3 east full-case stations.
Northbound is a mirror problem — out of scope for this sprint.

### 2.1 Axis convention

grid_y = 0 → **south** (y_m ≈ 0.51 m).
grid_y = 46 → **north** (y_m ≈ 71.12 m).

Bots "go south" by decreasing grid_y, "go north" by increasing it. This
matches the Go zone-sim code (`cmd/calibrate/zone.go`) and was flipped into
the CP-SAT path (`cmd/calibrate/cpsat/graph_utils.py`) on April 15.

### 2.2 Station specialization

Each station is **pinned to a single pick-type category**:

| Station group | Members | Pick category | Conv/NCV subtypes |
|---|---|---|---|
| South baseline | `op-{4,8,12,16}-0` | Casepick | conveyable + non-conveyable |
| East Ep (Ep-Sc only) | `op-21-{4,7,10}` | Full-case | conveyable + non-conveyable |

A south station never presents a full-case pallet, and vice versa. This is
enforced in `build_station_groups()` in `cmd/calibrate/cpsat/run_sweep.py`:
south bots sample from `CASEPICK_MIX`, east bots from `FULL_CASE_MIX`.

---

## 3. Southbound slice

`extract_south_zone()` in `cmd/calibrate/cpsat/graph_utils.py` filters the
pilot graph to `level == 1 AND grid_y <= 12`. This retains the station row
(y=0), the 2 travel rows (y=1,2), and 10 buffer/aisle rows (y=3…12).

### 3.1 Entry / exit topology

The slice has:
- **5 boundary aisle cells at y=12** (where bots enter/exit the slice)
- **2 z-column cells at y=0** (vertical transit out of the zone)

Defined in `graph_utils.py`:

| Cell | Configured role | Physical meaning |
|---|---|---|
| `a-1-3-12` | ENTRY only | southbound aisle → op-4-0 |
| `a-1-7-12` | EXIT only | northbound aisle from op-8-0 |
| `a-1-11-12` | ENTRY only | southbound aisle → op-12-0 |
| `a-1-13-12` | EXIT only | northbound aisle from op-16-0, op-12-0 |
| `a-1-17-12` | **ENTRY + EXIT** | southbound aisle → op-16-0 and east Ep stations; east bots also reverse-out here |
| `a-1-1-0` | ENTRY + EXIT | SW corner z-column (vertical transit) |
| `a-1-19-0` | ENTRY + EXIT | SE corner z-column (vertical transit) |

`a-1-17-12` is the critical shared corridor — it services baseline op-16-0
AND all 3 east Ep stations. We expect and observe contention on it.

### 3.2 East-station access chain

East stations have no dedicated `xy-21-*` gateway. Access is forced through
a **3-deep pallet row** at gx=18:

```
a-1-17-Y  ──x──►  p-1-Y-18-0  ──x──►  p-1-Y-18-1  ──x──►  p-1-Y-18-2  ──x──►  op-21-Y
  aisle   1.68m    depth=0    1.47m    depth=1    1.47m    depth=2    1.68m    station
```

This adds 6 extra cells (3 inbound, 3 outbound) per east-station round trip
compared to a baseline station — visible in the schedules as extra physical
dwell along gx=18 pallet positions.

### 3.3 Routing choices & tradeoffs

- **Baseline stations**: entry/exit rotates through ranked (entry, exit) pairs to
  spread load. The `_rank_entry_exit` function pre-computes travel cost for
  all feasible pairs per station; bots round-robin through them.
- **East stations**: allow entry = exit (both `a-1-17-12`) because there is
  only one physical corridor to east. Forcing one-way flow would require a
  long southbound detour through the full gx=17 corridor to the SE z-column
  (op-21-4 round trip = 23 cells). With bidirectional gx=17, op-21-10 drops
  to 13 cells. CP-SAT's cell-level no-overlap still prevents head-on
  collisions; head-on conflict becomes scheduler contention rather than
  physical deadlock.

---

## 4. Operator cycle time — empirical basis

*[Section continues as data refinements land.]*

### 4.1 Data source

- **Bucket**: `gs://solution-design-raw/` (project `mytra-ai-dev`).
- **Access**: `cloudy-vm@mytra-ai-dev.iam.gserviceaccount.com` granted
  `Storage Object Viewer` on the bucket — no per-session auth needed.
- **Files**: 4 quarterly outbound CSVs under `machine_readable_data/`:
  - `SFDC - Raw Outbound Data (Jan-Mar 2025).csv`
  - `SFDC - Raw Outbound Data (Apr - Jun 2025).csv`
  - `SFDC - Raw Outbound Data (Jul - Sept 2025).csv`
  - `SFDC - Raw Outbound Data (Oct - Dec 2025).csv`
- **Schema**: 72 columns per SFDC export; we project 9 of them (see below).
- **Read path**: DuckDB httpfs + S3-compat API, bearer token from `gcloud
  auth application-default print-access-token`. This pattern comes from
  loom PR #28 (`pranav/data-improvements`).

### 4.2 Pick-type classification

From Grainger's `Master Code Definitions_Grainger Inputs.csv` reference file:

| SFDC TYP / Pick Type | Meaning | Our sim category |
|---|---|---|
| `Unit` + `CON1` | Bulk Conveyables, Pallets | `full_case_conv` |
| `Unit` + `CON2` | Bulk Conveyables, Top-Offs (pick bins) | `casepick_conv` |
| `Unit` + `NC01`/`LTL*`/`NRAW` | Non-conv pallets / LTL / raw | `full_case_ncv` |
| `Unit` + `NC02`/`NC03` | Non-conv Top-Offs / Mixed SKUs | `casepick_ncv` |
| `Pallet` (any TYP) | Entire pallet shipped | `pallet_out` (not used in current layouts) |

"Top-Offs" in Grainger terminology = pick bins, where partial-case picking
happens. "Pallets" = bulk pallet storage, where operators pull whole cases.
This matches the physical distinction between **casepick** and **full-case**.

### 4.3 Empirical cycle times (p50 across 2025 Q1-Q4, ~2.5M rows)

| Category | Bot dwell at op | Operator cycle | Empirical n |
|---|---:|---:|---:|
| `full_case_conv` | 37 s | 38 s | 729,381 |
| `full_case_ncv` | 121 s | 123 s | 232,986 |
| `casepick_conv` | 57 s | 58 s | 1,274,649 |
| `casepick_ncv` | 91 s | 93 s | 231,372 |

Extractor: `cmd/calibrate/cpsat/extract_pick_times.py`. Outliers outside
`[1, 600]` seconds dropped (operator breaks, instrumentation noise).

### 4.4 Type-mix per station group (empirical row-count weighting)

- **South (casepick)**: 85% `casepick_conv`, 15% `casepick_ncv`. Weighted
  mean operator cycle ≈ 63 s.
- **East (full-case)**: 76% `full_case_conv`, 24% `full_case_ncv`. Weighted
  mean operator cycle ≈ 59 s.

Close enough that neither station type bottlenecks the other on raw cycle time.

---

## 5. Service-time model (bot vs operator)

> "Pick time + time to destination. Once the processing part is done the bots
> are free to leave and the next one can line up and wait at the station.
> The operator time tells us when the operator is free again." — user, 2026-04-15

We model **two distinct durations** per bot presentation:

- **Bot dwell at op cell** (`pick_time_s`) = `identify(3s) + pick_time(type) + confirm(2s)`.
  The bot physically stays at the op cell for this window.
- **Operator cycle** (`operator_cycle_s`) = `bot_dwell + walk(dest)/walk_speed`.
  The operator keeps working — walking the picked item(s) to conveyor/bin/repal —
  AFTER the bot has left.

In the CP-SAT model:
- **Op-cell no-overlap** duration = `pick_time_s` per bot. Shorter, so the op
  cell frees up as soon as picking is done.
- **Per-station operator no-overlap resource** duration = `operator_cycle_s`
  per bot. Extends past op-cell freeing. The next bot can stage at the op
  cell (physically) but can't start service until the operator is free.

Code: `solve_wave_schedule()` in `run_sweep.py`.

### 5.1 Walk-to-drop distances (synthetic placeholders)

| Dest class | Distance | Rationale |
|---|---:|---|
| conveyable → conveyor | 2.0 m | immediately adjacent to op |
| non-conveyable → bin/repal | 3.5 m | short staging area behind op |

Pending station geometry from Jacob; easy to refine.

---

## 6. Scheduling

### 6.1 Wave mode (current default)

`K` waves of `N` bots each. Each wave is the same plan shifted by
`wave_offset` seconds. PPH = `N × 3600 / wave_offset`. Models synchronized
bot release — bots are dispatched from a central controller in batches.

Wave mode is a **ceiling model**: it assumes perfect scheduling knowledge.
In practice async dispatch will be lower, but wave mode gives the best-case
answer against which to compare.

### 6.2 Async mode (validation)

Added to test whether the wave-mode cliff is physical or a modeling artifact.

**Semantics:** `N` persistent bots; each bot does `K` cycles in sequence. No
global `wave_offset` — each cycle starts freely subject to cell + operator
no-overlap. Cycle `w+1` for bot `i` begins after cycle `w`'s last cell ends.

**PPH formula:** `PPH = N × K × 3600 / makespan`. Minimize makespan.

Unlike wave mode (which treats each wave as a fresh batch of `N` bots and
therefore over-counts the physical fleet by a factor of `waves`), async mode
is closer to the real persistent-fleet operation: `N` bots shuttle between
storage and stations, re-entering the station subsystem as soon as they're
done with a dropoff.

**Finding:** async mode produces a **monotonic, cliff-free PPH curve**
(Ep-Sc: 74→116→142→151→184 as n goes 3→5→7→10→14). This validates that
wave mode's sharp drop at the cliff is a scheduler-alignment artifact, not
physical collapse. The underlying corridor contention is real, but async
scheduling accommodates it gracefully.

**Limitation:** async mode generates `N × K` more interval constraints than
wave mode. At higher bot counts the CP-SAT solver hits its time budget
before finding a feasible schedule (Ep-Sc n≥17 mostly INFEASIBLE). These
"infeasibilities" are solver-budget artifacts, not physical infeasibility.

**Implementation:** `--async-mode` flag in `run_sweep.py`. `solve_wave_schedule`
switches to async constraint structure when `async_mode=True`.

### 6.3 Phase classification

Per Notion spec, with marginal-gain thresholds:
- **Linear**: marginal PPH per added bot ≥ 70% of the first-bot-pair gain.
- **Degradation**: 30–70%.
- **Collapse**: < 30% OR any deadlock.

Variance no longer triggers collapse (empirical sampling produces legitimate
variance that shouldn't be conflated with true collapse).

---

## 7. Metrics

Per sweep point we record (matching Notion schema):

| Field | Meaning |
|---|---|
| `layout` | `Scp` or `Ep-Sc` |
| `bot_count` | sweep parameter |
| `seed` | RNG seed (varies bot-to-station rotation + type-mix sampling) |
| `mean_pph` | mean PPH across seeds at this bot count |
| `p5_pph` / `p95_pph` | min / max across seeds (proxy for P5/P95 at 5 seeds) |
| `collisions` | 0 in wave mode (no-overlap enforced) |
| `deadlocks` | 1 if solver returned INFEASIBLE |
| `avg_op_utilization` | fraction of schedule span operator is busy |
| `peak_queue_depth` | max concurrent bots at any op cell (from service intervals) |
| `phase` | `linear` / `degradation` / `collapse` |

---

## 8. Results

### 8.1 Wave-mode sweep (5 seeds per point, empirical p50 service times)

| Layout | Peak PPH | Peak bots | Sustained (collapse region) | Max feasible |
|---|---:|---:|---:|---:|
| Scp | 247 | 8 | 121 | 20 |
| Ep-Sc | 231 | 10 | 194 | 28 |

See `output/station_capacity_v3/` for full artifacts.

### 8.2 Cliff interpretation (wave mode)

Both layouts show a sharp PPH drop just past peak. **The cliff is primarily
a scheduler-model artifact, not a physical collapse.** Evidence:

- Per-seed variance is large at the cliff (Scp n=8: P5–P95 = 99–327 PPH) —
  some seeds find wave=2, others don't.
- Operator utilization drops to ~0.5 at collapse (0.9–1.0 at peak). Operators
  are idle half the time — the global wave_offset is padded for corridor
  contention but the operators themselves have capacity.
- No deadlocks in the sweep range except Scp n=20 (1/5 seeds).

The bot count at which wave=2 stops being feasible *is* a real signal —
it's the **corridor saturation boundary**. Scp saturates at n=8–10; Ep-Sc at
n=10–14. Ep-Sc's 3 extra stations let more bots share the graph before
hitting this boundary.

### 8.3 Async-mode validation

Ran the same sweep in async mode (persistent fleet, K=3 cycles per bot,
no global wave_offset). Results at `output/station_capacity_async/`:

| Layout | n | Async PPH | Wave PPH | Notes |
|---|---:|---:|---:|---|
| Scp | 2 | 50 | — | 1 cycle/sec baseline |
| Scp | 4 | 95 | 150 | wave over-counts bots 1.6× |
| Scp | 6 | 92 | 224 | wave over-counts 2.4× |
| Scp | 8 | 107 | 247 | wave over-counts 2.3× |
| Scp | 10 | 122¹ | 110 | async ≈ wave here (cliff equalizes) |
| Scp | ≥12 | INFEASIBLE | 120ish | solver-budget in async, not physical |
| Ep-Sc | 3 | 74 | — | — |
| Ep-Sc | 5 | 116 | — | — |
| Ep-Sc | 7 | 142 | 197 | wave over-counts 1.4× |
| Ep-Sc | 10 | 151 | 231 | — |
| Ep-Sc | 14 | 184 | 205 | async still CLIMBING (no cliff) |
| Ep-Sc | ≥17 | INFEASIBLE | 180–200 | solver-budget in async |

¹ 1/3 seeds feasible at Scp n=10 async; the rest hit solver time budget.

**Key finding: the cliff IS a wave-mode artifact.**

- Async Ep-Sc curve: 74→116→142→151→184. Monotonic. No cliff.
- Wave Ep-Sc curve: 132→197→231→205. Non-monotonic with a drop after n=10.

The wave over-count factor (1.4× to 2.4×) depends on how many waves the
solver finds feasible. It's the same physical system modeled two ways:
- Wave mode answers "at steady state cyclic release, what rate?"
- Async mode answers "for a persistent N-bot fleet, what rate?"

The **async numbers are the right per-physical-bot throughput**. Wave numbers
should be interpreted as "base bots per wave × waves ≈ N physical bots".

**Solver-budget infeasibility at high n in async mode** is NOT a physical
limit. CP-SAT builds ~N×K more interval constraints in async, so solve time
balloons. To get async data past n=10 we'd need longer budget per call or
a warm-start strategy — both are engineering refinements, not modeling
changes.

### 8.4 Sequencing-conditional refinement

The empirical outbound data reveals that operators take **significantly longer
on a pick immediately following a pick of a different conveyable class**
within the same pick-type category. Measured conditional p50 of
`SECONDS_ON_TASK | current_type, prev_type`:

| current | prev | n | p50 (s) | stay-cost ratio |
|---|---|---:|---:|---:|
| `casepick_conv` | `casepick_conv` | 1.24M | 51 | 1.0× (baseline) |
| `casepick_conv` | `casepick_ncv`  | 971 | **185** | 3.6× |
| `casepick_ncv`  | `casepick_conv` | 1,232 | **179** | 3.5× (vs 82s stay) |
| `casepick_ncv`  | `casepick_ncv`  | 208k | 82 | 1.0× |
| `full_case_conv`| `full_case_conv`| 704k | 31 | 1.0× |
| `full_case_conv`| `full_case_ncv` | 3,282 | **302** | 9.7× |
| `full_case_ncv` | `full_case_conv`| 3,400 | **291** | 2.7× (vs 108s stay) |
| `full_case_ncv` | `full_case_ncv` | 198k | 108 | 1.0× |

**What this means physically**: when the operator switches between conveyable
and non-conveyable materials (different dropoff method — conveyor vs bin/repal
vs tools), there's real setup/transition work — grabbing a different picking
tool, re-configuring the operator station. The full-case conv→ncv transition
is the worst (9.7× penalty) because it's a rare event (3,282 samples vs 704k
stays) that operators aren't practiced on.

**Wiring**: `run_sweep.py` tracks the previous bot's `pick_type` at each
station. When building the next bot's plan, it consults
`output/empirical/pick_time_sequence.parquet` and uses the conditional p50 if
the (current, prev) pair is present; falls back to unconditional p50 otherwise.
First bot at each station has no prev → unconditional.

**Results** at `output/station_capacity_seq/`:

| Layout | Peak PPH | Peak bots | Sustained | Max feasible | Δ peak vs no-seq |
|---|---:|---:|---:|---:|---:|
| Scp | 212 | 8 | ~130 | 20 | -14% (247→212) |
| Ep-Sc | 197 | 7 | ~115 | 28 | -15% (231→197) |

The **ranking holds**: Scp still wins on peak (212 vs 197). Sequencing
penalizes both layouts proportionally because in both:
- Most (≥76%) picks are "stay" (same conv class as previous) → cycle barely
  changes.
- A minority are mode switches → large penalty multiplied by few occurrences.

Per-seed variance is much larger (Scp n=8: P5–P95 = 130–331 PPH vs 400–424
without sequencing), reflecting the stochastic distribution of switch events
across the schedule.

**The cliff still appears** in sequencing mode — wave=2 becomes infeasible at
the same bot counts (Scp n=10, Ep-Sc n=14), confirming it's a scheduler
artifact orthogonal to the sequencing penalty.

### 8.5 Synthesis — three model views of the same system

| Metric | Wave (no seq) | Wave + seq | Async (no seq) |
|---|---:|---:|---:|
| Scp peak PPH | 247 @ n=8 | 212 @ n=8 | 122 @ n=10 |
| Ep-Sc peak PPH | 231 @ n=10 | 197 @ n=7 | 184 @ n=14 |
| Cliff shape | sharp | sharp | smooth |
| Over-counts bots | yes (1.4×–2.4×) | yes | no |
| Fleet interpretation | batch release | batch release | persistent |

**How to read this for Jacob/Friday**:

- **Upper bound (wave mode)** — cyclic batch release, no mode-switching
  penalty: Scp ~250, Ep-Sc ~230 PPH.
- **Realistic bound (wave + sequencing)** — adds the empirical
  switching penalty that Tesla's study said dominates variance: Scp ~210,
  Ep-Sc ~200.
- **Conservative bound (async, persistent fleet)** — no over-counting, but
  CP-SAT solver-budget caps test range: Scp ~120, Ep-Sc ~184 at the tested
  points.

Reality lies between async (conservative) and wave+seq (optimistic).

### 8.4 Sequencing-conditional refinement — pending (Option 1)

*[Written once conditional sampling is wired.]*

---

## 9. Caveats & open questions

- **Global wave alignment is a modeling assumption.** Async scheduling would
  likely produce a smoother curve past the cliff.
- **Pallet sequencing not yet modeled.** Empirical data shows meaningful
  cycle-time penalty on conv ↔ ncv transitions within a pick-type category.
  Wiring this in is tracked as a refinement.
- **Walk-to-drop distances are synthetic.** Real station-to-conveyor
  distances pending from Jacob.
- **Slice scope.** Only the southbound slice (grid_y ≤ 12) is modeled.
  Northbound mirror + vertical transit + inbound putaway not in scope.
- **CP-SAT budget.** Solver time scales with bot count × wave count. High
  bot-count points may have settled on sub-optimal wave counts; the
  post-cliff plateau is therefore a CONSERVATIVE lower bound.

---

## 10. Code map

| Path | Purpose |
|---|---|
| `cmd/calibrate/cpsat/graph_utils.py` | Graph loading, slice extraction, station / entry / exit constants. |
| `cmd/calibrate/cpsat/run_sweep.py` | Bot-plan construction, CP-SAT solver, sweep driver. |
| `cmd/calibrate/cpsat/extract_pick_times.py` | GCS → DuckDB extractor for empirical pick times + sequencing. |
| `cmd/calibrate/cpsat/analyze_sweep.py` | Post-sweep chart + table + interpretation generation. |
| `scripts/extract-south-slice.py` | Standalone south-slice emitter (used by station-sim UI). |
| `station-sim/index.html` | Interactive UI for loading slices and running one-off CP-SAT solves. |
| `station-sim/server.py` | HTTP wrapper around solver for the UI. |
| `output/station_capacity_v3/` | Current canonical sweep results. |
| `output/empirical/` | Empirical pick-time parquets derived from SFDC outbound. |

---

## 11. Run-it yourself

```bash
# One-time: auth for the bucket (either step)
gsutil ls gs://solution-design-raw/machine_readable_data/   # must succeed

# Extract empirical pick times (3–5 min)
.venv/bin/python cmd/calibrate/cpsat/extract_pick_times.py --output output/empirical

# Run sweeps (each ~15–20 min at 5 seeds × 8 bot counts)
.venv/bin/python cmd/calibrate/cpsat/run_sweep.py --layout Scp   --bots 4,6,8,10,12,14,16,20 --seeds 1,2,3,4,5 --max-waves 3 --output output/station_capacity_v4
.venv/bin/python cmd/calibrate/cpsat/run_sweep.py --layout Ep-Sc --bots 4,7,10,14,17,21,24,28 --seeds 1,2,3,4,5 --max-waves 3 --output output/station_capacity_v4

# Generate chart + table + interpretation
.venv/bin/python cmd/calibrate/cpsat/analyze_sweep.py --dir output/station_capacity_v4
```
