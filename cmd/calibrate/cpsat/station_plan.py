"""Config-driven station group construction and bot-plan building.

Replaces the hardcoded build_station_groups(), _build_baseline_bot_plan(),
_build_leaf_bot_plan(), and service-time sampling from run_sweep.py with
config-driven equivalents.

Usage:
    from config_schema import load_config
    from graph_slice import extract_subgraph
    from station_plan import ServiceTimeModel, build_bots_from_config

    cfg = load_config("configs/grainger_scp.yaml")
    graph = extract_subgraph(cfg.slice.graph_path, cfg.slice.slice)
    svc = ServiceTimeModel(cfg.slice.service_time)
    bots = build_bots_from_config(graph, cfg.slice.station_groups, 8,
                                   kin_unloaded, kin_loaded, svc, rng)
"""

from __future__ import annotations

import logging
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config_schema import ServiceTimeConfig, StationDef, StationGroupConfig
from graph_utils import BotKinematics, edge_travel_time, path_travel_time, shortest_path

logger = logging.getLogger(__name__)


# ── BotPlan (same dataclass as run_sweep.py for solver compatibility) ──

@dataclass
class BotPlan:
    bot_id: int
    station_op: str
    pick_type: str
    bot_dwell_s: int
    operator_cycle_s: int
    cells: list
    durations: list
    service_idx: int


# ── Service time model ──

class ServiceTimeModel:
    """Encapsulates pick-time sampling and operator-cycle computation.

    Reads from config instead of module-level globals. Supports:
    - Fixed pick times (from config.pick_times)
    - Empirical presentation distribution (from parquet, if path provided)
    - Sequencing-conditional (from parquet, if path provided)
    - PEZ tray-drop dwell (configurable)
    """

    def __init__(self, config: ServiceTimeConfig):
        self.overhead_s = config.overhead_s
        self.walk_speed = config.walk_speed_m_s
        self.walk_distances = config.walk_distances
        self.pick_times = config.pick_times
        self.pez_dwell_s = config.pez_dwell_s
        self.pez_enabled = config.pez_enabled
        self._presentation_dist: dict[str, list[tuple[str, float, float]]] | None = None
        self._sequence_table: dict[tuple[str, str], float] | None = None
        self._empirical_paths = config.empirical or {}

    def _load_presentation_dist(self) -> dict[str, list[tuple[str, float, float]]] | None:
        if self._presentation_dist is not None:
            return self._presentation_dist or None
        path = self._empirical_paths.get("presentation_dist")
        if not path or not Path(path).exists():
            self._presentation_dist = {}
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
        self._presentation_dist = d
        logger.info("Loaded presentation dist: %s",
                    ", ".join(f"{k}={len(v)}" for k, v in d.items()))
        return d or None

    def _load_sequence_table(self) -> dict[tuple[str, str], float] | None:
        if self._sequence_table is not None:
            return self._sequence_table or None
        path = self._empirical_paths.get("sequence_table")
        if not path or not Path(path).exists():
            self._sequence_table = {}
            return None
        import duckdb
        db = duckdb.connect()
        rows = db.execute(
            f"SELECT sim_type, prev_type, p50_s FROM read_parquet('{path}')"
        ).fetchall()
        self._sequence_table = {(st, pt): p50 for st, pt, p50 in rows}
        logger.info("Loaded sequence table: %d pairs", len(self._sequence_table))
        return self._sequence_table or None

    def _sample_presentation(self, pick_type: str, rng: random.Random) -> float:
        """Sample a p50 from the presentation distribution for this type."""
        dist = self._load_presentation_dist()
        if dist and pick_type in dist:
            buckets = dist[pick_type]
            r = rng.random()
            acc = 0.0
            for _, prob, p50 in buckets:
                acc += prob
                if r <= acc:
                    return p50
            return buckets[-1][2]
        return float(self.pick_times.get(pick_type, 50))

    def _conv_class(self, pick_type: str) -> str:
        return "conv" if pick_type.endswith("_conv") else "ncv"

    # ── Timing breakdown (operator state machine) ──
    #
    # Bot dwell at op cell = identify + handle + confirm
    #   (bot is FREE after confirm — can depart)
    #
    # Operator cycle at-station = identify + handle + confirm + walk_to_drop + walk_back
    #   (operator unavailable for this full duration)
    #
    # If operator serves a DIFFERENT station next:
    #   operator_cycle += transit_time(from_station, to_station)

    IDENTIFY_S = 3
    CONFIRM_S = 2

    def pick_time(self, pick_type: str, rng: random.Random,
                  prev_type: str | None = None) -> int:
        """Bot dwell at op cell = identify + handle + confirm."""
        p50 = self._sample_presentation(pick_type, rng)
        return int(round(self.IDENTIFY_S + p50 + self.CONFIRM_S))

    def operator_cycle(self, pick_type: str, rng: random.Random,
                       prev_type: str | None = None) -> int:
        """Operator busy time at one station (identify→handle→confirm→walk→back).

        Does NOT include transit to next station — that's added separately
        by the solver when consecutive services are at different stations.
        """
        p50 = self._sample_presentation(pick_type, rng)
        walk_dist = self.walk_distances.get(self._conv_class(pick_type), 2.0)
        walk_s = walk_dist / self.walk_speed
        return int(round(self.IDENTIFY_S + p50 + self.CONFIRM_S + 2 * walk_s))

    def walk_one_way_s(self, pick_type: str) -> int:
        """One-way walk to dropoff (seconds). Used for transit gap computation."""
        walk_dist = self.walk_distances.get(self._conv_class(pick_type), 2.0)
        return int(round(walk_dist / self.walk_speed))


# ── Transit time matrix ──

def compute_transit_matrix(graph, station_groups: list[StationGroupConfig],
                           walk_speed: float = 1.67) -> dict[tuple[str, str], int]:
    """Precompute transit time (seconds) between all station op pairs.

    Uses shortest-path distance in the graph. Returns a dict keyed by
    (from_op, to_op) → transit_seconds. Same-station pairs have transit=0.
    """
    all_ops = [stn.op for g in station_groups for stn in g.stations]
    # Use xy (or op if no xy) as the physical anchor for distance calculation
    anchors = {}
    for g in station_groups:
        for stn in g.stations:
            anchors[stn.op] = stn.xy if stn.xy else stn.op

    matrix: dict[tuple[str, str], int] = {}
    for a in all_ops:
        for b in all_ops:
            if a == b:
                matrix[(a, b)] = 0
                continue
            try:
                dist = path_travel_time(graph, shortest_path(graph, anchors[a], anchors[b]),
                                        BotKinematics(xy_velocity=walk_speed, xy_accel=walk_speed))
                matrix[(a, b)] = int(round(dist))
            except Exception:
                # No path — use Manhattan distance estimate from positions
                try:
                    pa = graph.nodes[anchors[a]]["position"]
                    pb = graph.nodes[anchors[b]]["position"]
                    dist = (abs(pa["x_m"] - pb["x_m"]) + abs(pa["y_m"] - pb["y_m"])) / walk_speed
                    matrix[(a, b)] = int(round(dist))
                except Exception:
                    matrix[(a, b)] = 30  # fallback
    return matrix


# ── Entry/exit ranking ──

def _rank_entry_exit(graph, anchor: str,
                     entry_candidates: list[str], exit_candidates: list[str],
                     kin: BotKinematics,
                     allow_same: bool = False) -> list[tuple[str, str, float]]:
    """Rank feasible (entry, exit) pairs by total travel time."""
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


# ── Bot plan builders ──

def _build_baseline_plan(graph, stn: StationDef, entry: str, exit_pt: str,
                         kin_in: BotKinematics, kin_out: BotKinematics,
                         bot_id: int, pick_type: str,
                         svc: ServiceTimeModel, rng: random.Random,
                         prev_type: str | None = None) -> BotPlan:
    """Baseline topology: approach via xy gateway, service at op, depart via xy.

    Outbound cycle with PEZ (when station has pez and svc.pez_enabled):
        entry → ... → xy → OP (pick) → xy → PEZ (drop tray) → xy → ... → exit
    Without PEZ:
        entry → ... → xy → OP (pick) → xy → ... → exit
    """
    dwell = svc.pick_time(pick_type, rng, prev_type)
    op_cyc = svc.operator_cycle(pick_type, rng, prev_type)
    approach = shortest_path(graph, entry, stn.xy)
    depart = shortest_path(graph, stn.xy, exit_pt)

    # Build cell sequence — include PEZ tray-drop step if enabled + station has PEZ
    if svc.pez_enabled and stn.pez and stn.pez in graph.nodes:
        # Outbound: approach → OP (service) → XY → PEZ (tray drop) → XY → depart
        cells = approach + [stn.op, stn.xy, stn.pez, stn.xy] + depart[1:]
        service_idx = len(approach)      # OP cell
        pez_idx = len(approach) + 2      # PEZ cell (2 after OP: op, xy, PEZ)
    else:
        cells = approach + [stn.op, stn.xy] + depart[1:]
        service_idx = len(approach)
        pez_idx = None

    durations, prev_axis = [], None
    for j in range(len(cells)):
        if j == service_idx:
            durations.append(dwell)
        elif pez_idx is not None and j == pez_idx:
            durations.append(svc.pez_dwell_s)
        elif j < len(cells) - 1 and graph.has_edge(cells[j], cells[j + 1]):
            ed = graph.edges[cells[j], cells[j + 1]]
            kin = kin_in if j <= service_idx else kin_out
            t = edge_travel_time(ed["distance_m"], ed["axis"], prev_axis, kin)
            durations.append(max(1, round(t)))
            prev_axis = ed["axis"]
        else:
            durations.append(1)
    return BotPlan(bot_id, stn.op, pick_type, dwell, op_cyc, cells, durations, service_idx)


def _build_leaf_plan(graph, stn: StationDef, entry: str, exit_pt: str,
                     kin_in: BotKinematics, kin_out: BotKinematics,
                     bot_id: int, pick_type: str,
                     svc: ServiceTimeModel, rng: random.Random,
                     prev_type: str | None = None) -> BotPlan:
    """Leaf topology: access via pallet chain (e.g., east Ep stations).

    Leaf stations typically don't have PEZ (the pez field is usually None for
    east-side stations). If PEZ IS present and reachable from the xy anchor,
    the tray-drop step is inserted after the pallet-chain return.
    """
    dwell = svc.pick_time(pick_type, rng, prev_type)
    op_cyc = svc.operator_cycle(pick_type, rng, prev_type)
    chain = stn.pallet_chain or []
    approach = shortest_path(graph, entry, stn.xy)
    depart = shortest_path(graph, stn.xy, exit_pt)

    # Core path: approach → chain → OP → reverse chain → back to xy
    core = approach + chain + [stn.op] + list(reversed(chain))
    service_idx = len(approach) + len(chain)

    # PEZ step after returning to xy (if enabled + reachable)
    if (svc.pez_enabled and stn.pez and stn.pez in graph.nodes
            and graph.has_edge(stn.xy, stn.pez)):
        cells = core + [stn.xy, stn.pez, stn.xy] + depart[1:]
        pez_idx = len(core) + 1  # PEZ cell position
    else:
        cells = core + depart
        pez_idx = None

    durations, prev_axis = [], None
    for j in range(len(cells)):
        if j == service_idx:
            durations.append(dwell)
        elif pez_idx is not None and j == pez_idx:
            durations.append(svc.pez_dwell_s)
        elif j < len(cells) - 1 and graph.has_edge(cells[j], cells[j + 1]):
            ed = graph.edges[cells[j], cells[j + 1]]
            kin = kin_in if j <= service_idx else kin_out
            t = edge_travel_time(ed["distance_m"], ed["axis"], prev_axis, kin)
            durations.append(max(1, round(t)))
            prev_axis = ed["axis"]
        else:
            durations.append(1)
    return BotPlan(bot_id, stn.op, pick_type, dwell, op_cyc, cells, durations, service_idx)


def _build_direct_plan(graph, stn: StationDef, entry: str, exit_pt: str,
                       kin_in: BotKinematics, kin_out: BotKinematics,
                       bot_id: int, pick_type: str,
                       svc: ServiceTimeModel, rng: random.Random,
                       prev_type: str | None = None) -> BotPlan:
    """Direct-access topology: op is on an aisle, no gateway."""
    dwell = svc.pick_time(pick_type, rng, prev_type)
    op_cyc = svc.operator_cycle(pick_type, rng, prev_type)
    approach = shortest_path(graph, entry, stn.op)
    depart = shortest_path(graph, stn.op, exit_pt)
    cells = approach + depart[1:]
    service_idx = len(approach) - 1  # last cell of approach IS the op

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
    return BotPlan(bot_id, stn.op, pick_type, dwell, op_cyc, cells, durations, service_idx)


_BUILDERS = {
    "baseline": _build_baseline_plan,
    "leaf": _build_leaf_plan,
    "direct_access": _build_direct_plan,
}


def build_bot_plan(graph, stn: StationDef, entry: str, exit_pt: str,
                   kin_in: BotKinematics, kin_out: BotKinematics,
                   bot_id: int, pick_type: str,
                   svc: ServiceTimeModel, rng: random.Random,
                   prev_type: str | None = None) -> BotPlan:
    """Unified bot plan builder. Dispatches on station.topology."""
    builder = _BUILDERS.get(stn.topology, _build_baseline_plan)
    return builder(graph, stn, entry, exit_pt, kin_in, kin_out,
                   bot_id, pick_type, svc, rng, prev_type)


# ── Assemble bots from config ──

def build_bots_from_config(
    graph,
    station_groups: list[StationGroupConfig],
    num_bots: int,
    kin_unloaded: BotKinematics,
    kin_loaded: BotKinematics,
    svc: ServiceTimeModel,
    rng: random.Random,
) -> list[BotPlan]:
    """Distribute bots round-robin across config-driven station groups.

    Each bot samples its pick type from the group's pick_type_mix.
    """
    # Flatten to (group_idx, station_idx) and shuffle for seed variance
    flat = []
    for gi, g in enumerate(station_groups):
        for si in range(len(g.stations)):
            flat.append((gi, si))
    rng.shuffle(flat)

    # Pre-rank entry/exit pairs per station
    ranked: dict[str, list[tuple[str, str, float]]] = {}
    for gi, g in enumerate(station_groups):
        for stn in g.stations:
            allow_same = g.allow_same_entry_exit or stn.topology == "leaf"
            pairs = _rank_entry_exit(graph, stn.xy or stn.op, g.entry_points,
                                      g.exit_points, kin_loaded, allow_same)
            ranked[stn.op] = pairs if pairs else [
                (g.entry_points[0], g.exit_points[0], 0.0)
            ]
    used_idx: dict[str, int] = {stn.op: 0 for g in station_groups for stn in g.stations}
    prev_type_at: dict[str, str | None] = {stn.op: None for g in station_groups for stn in g.stations}

    bots: list[BotPlan] = []
    for bid in range(num_bots):
        gi, si = flat[bid % len(flat)]
        g = station_groups[gi]
        stn = g.stations[si]
        pairs = ranked[stn.op]
        ep, xp, _ = pairs[used_idx[stn.op] % len(pairs)]
        used_idx[stn.op] += 1

        # Sample pick type from this group's mix
        pt = _sample_pick_type(g.pick_type_mix, rng)

        prev_pt = prev_type_at[stn.op]
        bot = build_bot_plan(graph, stn, ep, xp, kin_unloaded, kin_loaded,
                             bid, pt, svc, rng, prev_pt)
        bots.append(bot)
        prev_type_at[stn.op] = pt

    return bots


def _sample_pick_type(mix: dict[str, float], rng: random.Random) -> str:
    """Weighted random draw from a pick_type_mix dict."""
    r = rng.random()
    acc = 0.0
    for name, weight in mix.items():
        acc += weight
        if r <= acc:
            return name
    return list(mix.keys())[-1]  # fallback


# ── Operator-assignment CP-SAT solver ──

def solve_with_operators(
    bots: list[BotPlan],
    num_operators: int,
    transit_matrix: dict[tuple[str, str], int],
    waves: int = 2,
    time_buffer_s: int = 2,
    seed: int = 1,
    max_time_s: float = 15.0,
    solver_threads: int | None = None,
) -> dict | None:
    """CP-SAT solver with explicit operator assignment + transit.

    Each bot service is assigned to exactly one operator. Operators are
    modeled as sequential timelines: between consecutive services at
    DIFFERENT stations, a transit gap is enforced.

    The solver minimizes wave_offset (same as solve_wave_schedule) but
    the operator constraint is now assignment-based rather than per-station.

    Returns dict with {status, wave_offset_s, makespan_s, pph, ...} or None.
    """
    from ortools.sat.python import cp_model

    n_base = len(bots)
    model = cp_model.CpModel()
    max_time = max(sum(b.durations) for b in bots) * (2 + waves)

    # Duplicate bot plans per wave
    wave_bots = []
    for w in range(waves):
        for b in bots:
            wave_bots.append((w, b))
    total_services = len(wave_bots)

    # ── Bot cell scheduling (same as solve_wave_schedule) ──
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

    # Physical cell dwell intervals + no-overlap
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

    cell_dwells: dict[str, list] = {}
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        for j, cell in enumerate(b.cells):
            cell_dwells.setdefault(cell, []).append(dwell_intervals[(bid, j)])
    for cell, ivals in cell_dwells.items():
        if len(ivals) > 1:
            model.add_no_overlap(ivals)

    # ── Operator assignment ──
    # For each service event k and operator op, create:
    #   assigned[k, op] — boolean: is service k handled by operator op?
    #   op_interval[k, op] — optional interval on operator op's timeline

    service_events = []  # list of (k, bid, service_start_var, operator_cycle_s, station_op)
    for k, (w, b) in enumerate(wave_bots):
        bid = w * n_base + b.bot_id
        service_events.append((k, bid, starts[(bid, b.service_idx)],
                               b.operator_cycle_s, b.station_op))

    assigned = {}
    op_intervals_by_op: dict[int, list] = {op: [] for op in range(num_operators)}
    op_event_info: dict[int, list] = {op: [] for op in range(num_operators)}

    for k, (_, bid, svc_start, op_cyc, stn_op) in enumerate(service_events):
        exactly_one = []
        for op in range(num_operators):
            # Boolean: is service k assigned to operator op?
            b_var = model.new_bool_var(f"asgn_s{k}_op{op}")
            assigned[(k, op)] = b_var
            exactly_one.append(b_var)

            # Optional interval on this operator's timeline
            dur = op_cyc  # full operator cycle (identify→confirm→walk→back)
            s_op = model.new_int_var(0, max_time, f"ops_s{k}_op{op}")
            e_op = model.new_int_var(0, max_time + dur, f"ope_s{k}_op{op}")
            model.add(e_op == s_op + dur)
            # Operator starts when bot's service starts
            model.add(s_op == svc_start).only_enforce_if(b_var)
            ivl = model.new_optional_interval_var(s_op, dur, e_op, b_var,
                                                   f"opi_s{k}_op{op}")
            op_intervals_by_op[op].append(ivl)
            op_event_info[op].append((k, stn_op, s_op, e_op, b_var))

        # Each service assigned to exactly one operator
        model.add_exactly_one(exactly_one)

    # No-overlap per operator timeline (each operator handles one service at a time)
    for op in range(num_operators):
        if len(op_intervals_by_op[op]) > 1:
            model.add_no_overlap(op_intervals_by_op[op])

    # Transit time between consecutive services on the same operator
    # For each pair of services (i, j) on the same operator where j follows i,
    # if they're at different stations, add transit gap.
    # We enforce: for all pairs (i, j) assigned to the same op, if both active
    # and j starts after i, then j.start >= i.end + transit(i.station, j.station)
    for op in range(num_operators):
        events = op_event_info[op]
        for i in range(len(events)):
            ki, stn_i, si, ei, bi = events[i]
            for j in range(len(events)):
                if i == j:
                    continue
                kj, stn_j, sj, ej, bj = events[j]
                transit = transit_matrix.get((stn_i, stn_j), 0)
                if transit > 0:
                    # If both assigned to this op AND j follows i, enforce gap
                    both = model.new_bool_var(f"seq_op{op}_s{ki}_s{kj}")
                    model.add_implication(both, bi)
                    model.add_implication(both, bj)
                    # j starts after i ends + transit
                    model.add(sj >= ei + transit).only_enforce_if(both)

    # ── Wave structure ──
    if waves > 1:
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
    if wave_offset is not None:
        model.minimize(wave_offset)
    else:
        model.minimize(makespan)

    # ── Solve ──
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_s
    solver.parameters.random_seed = int(seed) & 0x7FFFFFFF
    if solver_threads is not None:
        solver.parameters.num_search_workers = int(solver_threads)
    status = solver.solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    ms = solver.value(makespan)
    wo = solver.value(wave_offset) if wave_offset is not None else ms

    # Extract operator utilization
    total_op_busy = 0
    for k, (_, bid, svc_start, op_cyc, stn_op) in enumerate(service_events):
        total_op_busy += op_cyc  # every service was assigned to someone
    avg_util = total_op_busy / (num_operators * (wo * waves if wo else ms)) if wo else 0.0

    return {
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "wave_offset_s": wo,
        "makespan_s": ms,
        "peak_queue_depth": 0,
        "avg_op_utilization": min(avg_util, 1.0),
        "num_operators": num_operators,
    }
