#!/usr/bin/env python3
"""Generate the EVT Congestion Calibration design document as PDF."""

import json
from fpdf import FPDF

# ─── Load calibration results ───
with open("calibration-results.json") as f:
    results = json.load(f)
samples = results["samples"]

# ─── Custom PDF ───

class DesignDoc(FPDF):
    def header(self):
        if self.page_no() > 1:
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(120, 120, 120)
            self.cell(0, 5, "EVT Congestion Calibration  - Design Document", align="L")
            self.cell(0, 5, f"Page {self.page_no()}", align="R", new_x="LMARGIN", new_y="NEXT")
            self.line(10, 12, 200, 12)
            self.ln(4)

    def footer(self):
        self.set_y(-10)
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(150, 150, 150)
        self.cell(0, 5, "Confidential  - Grainger / EVT Robotics", align="C")

    def section(self, num, title):
        self.set_font("Helvetica", "B", 14)
        self.set_text_color(0, 51, 102)
        self.ln(4)
        self.cell(0, 8, f"{num}. {title}", new_x="LMARGIN", new_y="NEXT")
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(3)
        self.set_text_color(0, 0, 0)

    def subsection(self, title):
        self.set_font("Helvetica", "B", 11)
        self.set_text_color(0, 70, 130)
        self.ln(2)
        self.cell(0, 6, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)
        self.set_text_color(0, 0, 0)

    def body_text(self, text):
        self.set_font("Helvetica", "", 10)
        self.multi_cell(0, 5, text)
        self.ln(1)

    def bullet(self, text):
        self.set_font("Helvetica", "", 10)
        self.set_x(14)
        self.multi_cell(182, 5, "- " + text)
        self.set_x(10)  # reset to left margin

    def code_block(self, text):
        self.set_font("Courier", "", 8)
        self.set_fill_color(240, 240, 240)
        self.multi_cell(0, 4, text, fill=True)
        self.ln(1)
        self.set_font("Helvetica", "", 10)

    def flow_box(self, x, y, w, h, text, color=(0, 102, 204)):
        r, g, b = color
        self.set_fill_color(r, g, b)
        self.set_draw_color(r - 30 if r > 30 else 0, g - 30 if g > 30 else 0, b - 30 if b > 30 else 0)
        self.rect(x, y, w, h, "DF")
        self.set_font("Helvetica", "B", 8)
        self.set_text_color(255, 255, 255)
        self.set_xy(x, y + h / 2 - 3)
        self.cell(w, 6, text, align="C")
        self.set_text_color(0, 0, 0)

    def flow_arrow(self, x1, y1, x2, y2):
        self.set_draw_color(80, 80, 80)
        self.set_line_width(0.4)
        self.line(x1, y1, x2, y2)
        # arrowhead
        import math
        angle = math.atan2(y2 - y1, x2 - x1)
        sz = 2
        self.line(x2, y2, x2 - sz * math.cos(angle - 0.4), y2 - sz * math.sin(angle - 0.4))
        self.line(x2, y2, x2 - sz * math.cos(angle + 0.4), y2 - sz * math.sin(angle + 0.4))
        self.set_line_width(0.2)

    def flow_label(self, x, y, text):
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(80, 80, 80)
        self.set_xy(x, y)
        self.cell(30, 4, text, align="C")
        self.set_text_color(0, 0, 0)


pdf = DesignDoc()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()

# ─── Title page ───
pdf.ln(40)
pdf.set_font("Helvetica", "B", 28)
pdf.set_text_color(0, 51, 102)
pdf.cell(0, 12, "EVT Warehouse Simulation", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.set_font("Helvetica", "B", 22)
pdf.cell(0, 10, "Congestion Calibration", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.set_font("Helvetica", "", 16)
pdf.set_text_color(80, 80, 80)
pdf.cell(0, 10, "Design Document", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.ln(10)
pdf.set_font("Helvetica", "", 11)
pdf.cell(0, 6, "Grainger Pilot  - April 2026", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.ln(30)
pdf.set_draw_color(0, 51, 102)
pdf.line(60, pdf.get_y(), 150, pdf.get_y())
pdf.ln(8)
pdf.set_font("Helvetica", "", 10)
pdf.set_text_color(100, 100, 100)
pdf.cell(0, 5, "Graph: 3,820 nodes | 4,572 edges | 8 stations | 2,800 pallet positions", align="C", new_x="LMARGIN", new_y="NEXT")
pdf.cell(0, 5, "Calibration: 400 pallets/shift | 5 shifts/sample | 2-200 bots", align="C", new_x="LMARGIN", new_y="NEXT")

# ─── 1. Executive Summary ───
pdf.add_page()
pdf.section("1", "Executive Summary")
pdf.body_text(
    "This document describes the congestion calibration system for the EVT warehouse "
    "simulation. The system uses a dual-model architecture: a detailed time-stepped "
    "engine with Cooperative A* (CA*) pathfinding measures real congestion penalties, "
    "which are then applied to a fast Discrete Event Simulation (DES) for fleet sizing."
)
pdf.body_text(
    "The calibration pipeline runs in Go for performance (120 work units in ~2 minutes), "
    "producing a congestion penalty curve that maps bot count to throughput discount and "
    "cycle time inflation. This curve is the bridge between the high-fidelity CA* engine "
    "and the scalable DES model."
)

pdf.subsection("Key Results")
pdf.bullet("Sweet spot: 50-75 bots (800-1000 pallets/hr, >90% utilization)")
pdf.bullet("Throughput ceiling: ~992 pallets/hr at 100 bots (85% utilization)")
pdf.bullet("Breakdown threshold: 150+ bots (graph cannot accommodate)")
pdf.bullet("Station bottleneck: NOT the limiter  - stations reach only 25% util at 100 bots")
pdf.bullet("Primary bottleneck: Aisle congestion (shared corridors)")

# ─── 2. Architecture ───
pdf.add_page()
pdf.section("2", "System Architecture")
pdf.body_text(
    "The calibration system is a dual-engine architecture. The time-stepped engine "
    "provides ground-truth congestion measurements via CA* pathfinding with physical "
    "collision enforcement. The DES engine provides fast fleet-size sweeps. The congestion "
    "curve bridges the two."
)

pdf.subsection("2.1 Calibration Flow Diagram")
pdf.ln(2)

# Draw the flow diagram
y0 = pdf.get_y()
bw, bh = 42, 12  # box width, height
gap = 8

# Row 1: Time-stepped engine
pdf.flow_box(15, y0, bw, bh, "Load Graph", (60, 60, 60))
pdf.flow_arrow(15 + bw, y0 + bh / 2, 15 + bw + gap, y0 + bh / 2)

pdf.flow_box(15 + bw + gap, y0, bw + 8, bh, "No-Collision Sim", (46, 139, 87))
pdf.flow_arrow(15 + 2 * bw + gap + 8, y0 + bh / 2, 15 + 2 * bw + 2 * gap + 8, y0 + bh / 2)

pdf.flow_box(15 + 2 * bw + 2 * gap + 8, y0, bw + 4, bh, "CA* Sim", (0, 102, 204))
pdf.flow_arrow(15 + 3 * bw + 2 * gap + 12, y0 + bh / 2, 15 + 3 * bw + 3 * gap + 12, y0 + bh / 2)

pdf.flow_box(15 + 3 * bw + 3 * gap + 12, y0, bw + 6, bh, "Compute Penalty", (204, 102, 0))

# Labels
pdf.flow_label(15 + bw + gap, y0 + bh + 1, "baseline throughput")
pdf.flow_label(15 + 2 * bw + 2 * gap + 8, y0 + bh + 1, "congested throughput")

# Row 2: DES
y1 = y0 + bh + 16
pdf.flow_box(15, y1, bw + 6, bh, "Build Curve", (204, 102, 0))
pdf.flow_arrow(15 + bw + 6, y1 + bh / 2, 15 + bw + gap + 6, y1 + bh / 2)

pdf.flow_box(15 + bw + gap + 6, y1, bw + 4, bh, "DES Sweep", (102, 51, 153))
pdf.flow_arrow(15 + 2 * bw + gap + 10, y1 + bh / 2, 15 + 2 * bw + 2 * gap + 10, y1 + bh / 2)

pdf.flow_box(15 + 2 * bw + 2 * gap + 10, y1, bw + 8, bh, "Apply Curve", (204, 102, 0))
pdf.flow_arrow(15 + 3 * bw + 2 * gap + 18, y1 + bh / 2, 15 + 3 * bw + 3 * gap + 18, y1 + bh / 2)

pdf.flow_box(15 + 3 * bw + 3 * gap + 18, y1, bw, bh, "Results", (0, 51, 102))

# Vertical arrow connecting rows
mid_x = 15 + 3 * bw + 3 * gap + 15
pdf.flow_arrow(mid_x, y0 + bh, mid_x, y1)
pdf.flow_label(mid_x - 15, y0 + bh + 3, "penalty curve")

pdf.set_xy(10, y1 + bh + 8)
pdf.ln(2)

pdf.subsection("2.2 Engine Comparison")
# Table
pdf.set_font("Helvetica", "B", 9)
pdf.set_fill_color(0, 51, 102)
pdf.set_text_color(255, 255, 255)
col_w = [45, 70, 70]
headers = ["Aspect", "Time-Stepped (CA*)", "DES"]
for i, h in enumerate(headers):
    pdf.cell(col_w[i], 6, h, border=1, fill=True, align="C")
pdf.ln()
pdf.set_text_color(0, 0, 0)
pdf.set_font("Helvetica", "", 8)
rows = [
    ("Tick model", "1-second discrete steps", "Event queue (float-time)"),
    ("Collision", "CA* reservation table", "None (station queue only)"),
    ("Pathfinding", "Space-time A* + Dijkstra", "Dijkstra shortest path"),
    ("Speed", "~30s for 120 runs (Go)", "Sub-second per sweep"),
    ("Purpose", "Measure congestion penalty", "Fleet sizing & throughput"),
    ("Bot limit tested", "2-200 bots", "Unlimited"),
]
for i, (a, b, c) in enumerate(rows):
    fill = i % 2 == 0
    if fill:
        pdf.set_fill_color(240, 245, 250)
    pdf.cell(col_w[0], 5, a, border=1, fill=fill)
    pdf.cell(col_w[1], 5, b, border=1, fill=fill)
    pdf.cell(col_w[2], 5, c, border=1, fill=fill)
    pdf.ln()
pdf.ln(3)

# ─── 3. CA* Algorithm ───
pdf.add_page()
pdf.section("3", "Cooperative A* Algorithm")
pdf.body_text(
    "The CA* implementation uses a reactive reroute-on-conflict model. Bots normally "
    "follow Dijkstra shortest paths. When a collision is detected at runtime, the "
    "blocked bot triggers a space-time A* replan using a reservation table built from "
    "all bots' current positions and planned paths."
)

pdf.subsection("3.1 Collision Handling Flow")
pdf.ln(2)
y0 = pdf.get_y()
bw, bh = 38, 11

pdf.flow_box(10, y0, bw, bh, "Bot moves", (60, 60, 60))
pdf.flow_arrow(10 + bw, y0 + bh / 2, 10 + bw + 5, y0 + bh / 2)

pdf.flow_box(10 + bw + 5, y0, bw + 4, bh, "Next occupied?", (204, 153, 0))
pdf.flow_label(10 + bw + 5, y0 + bh + 1, "no -> proceed")

# Yes branch down
pdf.flow_arrow(10 + bw + 5 + (bw + 4) / 2, y0 + bh, 10 + bw + 5 + (bw + 4) / 2, y0 + bh + 10)
pdf.flow_label(10 + bw + 5 + (bw + 4) / 2 - 15, y0 + bh + 2, "yes")

y1 = y0 + bh + 12
pdf.flow_box(10 + bw + 5 - 10, y1, bw + 24, bh, "Wait + count ticks", (204, 51, 51))

# Tick 3 branch
pdf.flow_arrow(10 + bw + 5 + (bw + 4) / 2 + 15, y1 + bh / 2, 10 + bw + 5 + (bw + 4) / 2 + 25, y1 + bh / 2)
pdf.flow_box(10 + bw + 5 + (bw + 4) / 2 + 25, y1 - 3, bw + 10, bh + 6, "Tick 3: ST-A*\nreroute", (0, 102, 204))

# Tick 15 branch
pdf.flow_arrow(10 + bw + 5 - 10 + (bw + 24) / 2, y1 + bh, 10 + bw + 5 - 10 + (bw + 24) / 2, y1 + bh + 10)
y2 = y1 + bh + 12
pdf.flow_box(10 + bw - 8, y2, bw + 30, bh, "Tick 15: phase-through", (102, 51, 153))
pdf.flow_label(10 + bw - 8, y2 + bh + 1, "(models fleet controller)")

pdf.set_xy(10, y2 + bh + 10)
pdf.ln(2)

pdf.subsection("3.2 Design Decisions & Justifications")
pdf.set_font("Helvetica", "B", 9)
pdf.body_text("Reactive vs. Cooperative Planning:")
pdf.body_text(
    "We use reactive rerouting (plan on conflict) rather than cooperative planning every "
    "tick. Full cooperative replanning of all bots each tick was implemented and tested "
    "but proved too expensive for this graph size (3,820 nodes). Reactive rerouting runs "
    "space-time A* only for conflicting bots, reducing compute cost by >100x while "
    "achieving equivalent congestion measurements."
)
pdf.set_font("Helvetica", "B", 9)
pdf.body_text("Phase-Through at 15 Ticks:")
pdf.body_text(
    "In real warehouse operations, deadlocks are resolved by a fleet controller "
    "(e.g., telling one bot to yield). Our 15-tick phase-through models this intervention "
    "delay. The collision wait time IS counted in the metrics, so the congestion penalty "
    "accurately reflects the cost of deadlock resolution. Testing showed that without "
    "this safety valve, head-on corridor deadlocks cause permanent stalls."
)
pdf.set_font("Helvetica", "B", 9)
pdf.body_text("Fill-Then-Drain Task Generation:")
pdf.body_text(
    "Tasks use fill-then-drain ordering (first half inductions, second half retrievals) "
    "rather than random mixed mode. This guarantees every task can be fulfilled  - mixed "
    "mode with an empty warehouse causes 50% of retrieval attempts to fail, distorting "
    "measurements. Fill-then-drain provides deterministic, reproducible task sequences."
)
pdf.set_font("Helvetica", "B", 9)
pdf.body_text("Reservation Table for Rerouting:")
pdf.body_text(
    "The space-time A* reroute builds a reservation table from ALL bots' current "
    "positions and planned paths. Stationary bots (idle, picking, placing) are reserved "
    "for a 200-tick horizon. Mobile bots' paths are reserved at 1-tick-per-hop. This "
    "enables the rerouting bot to plan waits and detours around occupied space-time cells."
)

# ─── 4. Calibration Results ───
pdf.add_page()
pdf.section("4", "Calibration Results")

pdf.subsection("4.1 Congestion Penalty Curve")
pdf.set_font("Helvetica", "B", 9)
pdf.set_fill_color(0, 51, 102)
pdf.set_text_color(255, 255, 255)
cols = [16, 18, 22, 18, 18, 22, 18, 18, 20, 20]
hdrs = ["Bots", "NC Cyc", "NC Thr/hr", "NC Util", "CA Cyc", "CA Thr/hr", "CA Util", "Coll%", "Cyc x", "Thr x"]
for i, h in enumerate(hdrs):
    pdf.cell(cols[i], 6, h, border=1, fill=True, align="C")
pdf.ln()
pdf.set_text_color(0, 0, 0)
pdf.set_font("Helvetica", "", 8)

for idx, s in enumerate(samples):
    nc = s["noCollision"]
    ca = s["cooperativeAStar"]
    fill = idx % 2 == 0
    if fill:
        pdf.set_fill_color(240, 245, 250)
    vals = [
        str(s["botCount"]),
        f"{nc['avgCycleTimeS']:.0f}",
        f"{nc['throughputPerHour']:.0f}",
        f"{nc['avgUtilization'] * 100:.0f}%",
        f"{ca['avgCycleTimeS']:.0f}",
        f"{ca['throughputPerHour']:.0f}",
        f"{ca['avgUtilization'] * 100:.0f}%",
        f"{ca['avgCollisionWaitPct'] * 100:.1f}%",
        f"{s['cycleTimePenalty']:.3f}",
        f"{s['throughputPenalty']:.3f}",
    ]
    for i, v in enumerate(vals):
        pdf.cell(cols[i], 5, v, border=1, fill=fill, align="C")
    pdf.ln()
pdf.ln(3)

pdf.subsection("4.2 Throughput Analysis")
pdf.body_text(
    "The throughput penalty shows clear diminishing returns as bot count increases. "
    "Key inflection points:"
)
pdf.bullet("2-10 bots: Near-linear scaling, <8% congestion loss")
pdf.bullet("10-50 bots: Sublinear scaling, 7-21% congestion loss  - good operating range")
pdf.bullet("50-100 bots: Diminishing returns, 21-26% congestion  - approaching ceiling")
pdf.bullet("100+ bots: Rapidly diminishing returns, aisle saturation dominates")
pdf.bullet("150+ bots: System breakdown  - bots cannot complete all 400 tasks within time limit")

pdf.body_text(
    "The optimal fleet size depends on target throughput and cost constraints. "
    "For this Grainger pilot layout (3,820-node graph, 8 stations):"
)
pdf.bullet("Cost-efficient: 30-40 bots (~420-520 CA* pallets/hr)")
pdf.bullet("High-throughput: 75-100 bots (~820-990 CA* pallets/hr)")
pdf.bullet("Maximum capacity: ~100 bots before congestion dominates")

# ─── 5. Station Congestion ───
pdf.add_page()
pdf.section("5", "Station Congestion Analysis")
pdf.body_text(
    "All 8 STATION_OP nodes are on the ground floor, arranged in two rows of 4 "
    "(front: y=0.5m, back: y=71.1m). Each station connects to the aisle network "
    "through a dedicated STATION_XY gateway node. This gateway is a potential "
    "bottleneck as ALL traffic to/from a station funnels through it."
)

pdf.subsection("5.1 Station Layout")
pdf.body_text(
    "Front row: op-4-0, op-8-0, op-12-0, op-16-0\n"
    "Back row:  op-4-46, op-8-46, op-12-46, op-16-46\n"
    "Each station pair (front/back at same X) shares an aisle column. "
    "Station spacing is ~6.3m in X."
)

pdf.subsection("5.2 Station Metrics by Fleet Size")
pdf.set_font("Helvetica", "B", 9)
pdf.set_fill_color(0, 51, 102)
pdf.set_text_color(255, 255, 255)
scols = [18, 24, 24, 24, 24]
shdrs = ["Bots", "Avg Util%", "Avg Queue", "Max Queue", "Tasks/stn"]
for i, h in enumerate(shdrs):
    pdf.cell(scols[i], 6, h, border=1, fill=True, align="C")
pdf.ln()
pdf.set_text_color(0, 0, 0)
pdf.set_font("Helvetica", "", 8)

for idx, s in enumerate(samples):
    stns = s.get("stationCongestion", [])
    if not stns:
        continue
    fill = idx % 2 == 0
    if fill:
        pdf.set_fill_color(240, 245, 250)
    avg_util = sum(st["utilPct"] for st in stns) / len(stns)
    avg_q = sum(st["avgQueue"] for st in stns) / len(stns)
    max_q = max(st["maxQueue"] for st in stns)
    avg_tasks = sum(st["tasks"] for st in stns) / len(stns)
    vals = [
        str(s["botCount"]),
        f"{avg_util:.1f}%",
        f"{avg_q:.1f}",
        str(max_q),
        f"{avg_tasks:.0f}",
    ]
    for i, v in enumerate(vals):
        pdf.cell(scols[i], 5, v, border=1, fill=fill, align="C")
    pdf.ln()
pdf.ln(3)

pdf.subsection("5.3 Key Finding: Stations Are NOT the Bottleneck")
pdf.body_text(
    "Even at 100 bots, stations average only ~24% utilization with an average queue "
    "depth of 5.2. The theoretical station capacity (8 stations x ~450 ops/hr at 8s "
    "pick time) is ~3,600 ops/hr. The observed CA* throughput at 100 bots is ~992/hr, "
    "well below station saturation."
)
pdf.body_text(
    "The primary bottleneck is AISLE CONGESTION  - bots competing for shared corridor "
    "space. The STATION_XY gateway nodes (8 total) do create chokepoints, but the aisle "
    "network itself is the limiting factor. This is confirmed by the 26% collision wait "
    "at 100 bots, which occurs in aisles, not at stations."
)

# ─── 6. Implementation ───
pdf.add_page()
pdf.section("6", "Implementation Details")

pdf.subsection("6.1 Go Calibration Runner")
pdf.body_text(
    "The calibration runs as a standalone Go binary (cmd/calibrate/) using goroutines "
    "for parallelism. Each work unit (botCount x algorithm x shift) runs independently. "
    "With 22 CPU cores, the full 120-unit sweep completes in ~2 minutes."
)
pdf.bullet("Graph: axis-aware directed graph with turn costs (XY turn: 2s, XY-Z transition: 3s)")
pdf.bullet("Dijkstra: heap-based O(V log V) with axis-aware DirNode states")
pdf.bullet("Space-time A*: reservation table with FNV-1a hash keys, 150-tick search horizon")
pdf.bullet("Task generation: fill-then-drain, seeded RNG for reproducibility")

pdf.subsection("6.2 TypeScript Frontend Engine")
pdf.body_text(
    "The browser-based engine (app/src/simulation/engine.ts) mirrors the Go logic "
    "for interactive visualization. Key improvements made during this calibration work:"
)
pdf.bullet("findPathBlocked fallback: occlusion-aware paths fall back to unblocked when stuck")
pdf.bullet("Task unassignment on failure: dropped tasks are reassigned instead of stuck forever")
pdf.bullet("Heuristic caching: module-level cache for Dijkstra heuristics across ticks")
pdf.bullet("Runtime collision enforcement: CA* mode checks collisions as safety net")

pdf.subsection("6.3 DES Integration")
pdf.body_text(
    "The congestion curve (cycleTimePenalty, throughputPenalty per bot count) is applied "
    "to DES sweep results via linear interpolation. For each DES sweep point:"
)
pdf.code_block(
    "  adjustedThroughput = desThroughput x getThroughputFactor(botCount)\n"
    "  adjustedCycleTime  = desCycleTime  x getTravelTimeMultiplier(botCount)"
)
pdf.body_text(
    "Below the minimum sample bot count, the penalty is clamped to the lowest sample. "
    "Above the maximum, the curve extrapolates linearly from the last two points."
)

# ─── 7. Recommendations ───
pdf.add_page()
pdf.section("7", "Recommendations")

pdf.subsection("7.1 Fleet Sizing")
pdf.body_text("Based on the calibration results for the Grainger pilot layout:")
pdf.ln(1)
pdf.set_font("Helvetica", "B", 10)
pdf.set_fill_color(230, 245, 230)
pdf.cell(0, 7, "  Recommended: 50-75 bots for 800-1000 pallets/hr at >90% utilization", border=1, fill=True, new_x="LMARGIN", new_y="NEXT")
pdf.ln(2)
pdf.set_font("Helvetica", "", 10)
pdf.body_text(
    "This range offers the best throughput-per-bot efficiency. Adding bots beyond 75 "
    "yields diminishing returns as collision wait exceeds 24%. Beyond 100 bots, the "
    "marginal throughput gain is negligible."
)

pdf.subsection("7.2 Station Capacity")
pdf.body_text(
    "With 8 stations at 25% utilization at 100 bots, there is significant station "
    "headroom. If aisle congestion could be reduced (wider aisles, additional cross-"
    "aisles), station capacity would support 3-4x the current throughput."
)

pdf.subsection("7.3 Graph Topology Improvements")
pdf.body_text(
    "The primary bottleneck is aisle congestion. Potential improvements to the graph "
    "topology that would increase the fleet ceiling:"
)
pdf.bullet("Add cross-aisles: more routing alternatives reduce head-on conflicts")
pdf.bullet("Widen main corridors: allow bots to pass each other (2-lane aisles)")
pdf.bullet("Add bypass routes around station gateways: reduce funnel effect at STATION_XY nodes")
pdf.bullet("Consider one-way aisle conventions: eliminates head-on deadlocks entirely")

pdf.subsection("7.4 Next Steps")
pdf.bullet("Run DES sweep with congestion curve applied for final fleet size recommendation")
pdf.bullet("Validate against physical pilot data when available")
pdf.bullet("Test PICO (case-out) mode with variable pick times from distribution data")
pdf.bullet("Explore multi-level effects (Z-axis contention between levels)")

# ─── Output ───
out_path = "docs/congestion-calibration-design.pdf"
import os
os.makedirs("docs", exist_ok=True)
pdf.output(out_path)
print(f"PDF generated: {out_path}")
print(f"  Pages: {pdf.pages_count}")
