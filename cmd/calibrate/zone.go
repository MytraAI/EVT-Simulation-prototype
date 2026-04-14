// Standalone station-zone simulation.
//
// Extracts a subgraph slice around the south dispatch stations (y < cutoff)
// and stress-tests station throughput by spawning bots at the entry aisle,
// routing them one-way through the station, and out the exit aisle.
//
// Usage:
//   ./calibrate-bin --zone --pallets 200 --shifts 3

package main

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"time"
)

// ─── Zone definitions ───

type StationZone struct {
	Name       string // e.g. "S1"
	StationOp  string // e.g. "op-4-0"
	GatewayXY  string // e.g. "xy-3-0"
	GatewayRow int    // e.g. 3
	EntryRow   int    // aisle row bots enter from
	ExitRow    int    // aisle row bots leave via
}

var southZones = []StationZone{
	{"S1", "op-4-0", "xy-3-0", 3, 1, 5},
	{"S2", "op-8-0", "xy-7-0", 7, 5, 9},
	{"S3", "op-12-0", "xy-11-0", 11, 9, 13},
	{"S4", "op-16-0", "xy-15-0", 15, 13, 17},
}

// ─── Subgraph extraction ───

type ZoneGraph struct {
	Nodes     []RawNode
	Edges     []RawEdge
	NodeSet   map[string]bool
	NodeIndex map[string]*RawNode
}

// extractSouthZone pulls out ground-floor nodes with y < maxY.
func extractSouthZone(raw *RawGraph, maxY float64) *ZoneGraph {
	nodeSet := make(map[string]bool)
	nodeIndex := make(map[string]*RawNode)
	var nodes []RawNode

	for i := range raw.Nodes {
		n := &raw.Nodes[i]
		// Ground floor only (level 1 or z=0)
		if n.Position.ZM > 0.1 {
			continue
		}
		// Within south zone Y cutoff
		if n.Position.YM > maxY {
			continue
		}
		nodes = append(nodes, *n)
		nodeSet[n.ID] = true
		nodeIndex[n.ID] = &nodes[len(nodes)-1]
	}

	// Only keep edges where both endpoints are in the zone
	var edges []RawEdge
	for _, e := range raw.Edges {
		if nodeSet[e.A] && nodeSet[e.B] {
			edges = append(edges, e)
		}
	}

	return &ZoneGraph{
		Nodes:     nodes,
		Edges:     edges,
		NodeSet:   nodeSet,
		NodeIndex: nodeIndex,
	}
}

// ─── Zone bot simulation ───

type ZoneBot struct {
	ID               int
	State            string // "entering", "at_station", "exiting", "done"
	CurrentNodeID    string
	Path             []string
	PathIndex        int
	StepsRemaining   int
	EdgeWaitTicks    int
	Zone             *StationZone
	EnteredAt        int // tick entered zone
	DoneAt           int // tick exited zone
	WaitTicks        int // total ticks spent waiting (collision)
}

type ZoneSimState struct {
	Step           int
	Bots           []*ZoneBot
	BotPositions   map[string]int // nodeID -> botID
	CompletedBots  int
	TotalCycleTime int

	zg        *ZoneGraph
	dg        *DirectedGraph
	cfg       SimConfig
	rng       *rand.Rand
}

type ZoneResult struct {
	Zone            string
	BotsPerStation  int
	CompletedTasks  int
	AvgCycleTimeS   float64
	ThroughputPerHr float64
	AvgWaitPct      float64
	Steps           int
}

// findZoneEntryNodes returns the aisle cells at the boundary of the zone
// for a given aisle row (the deepest Y position in the zone).
func findZoneEntryNodes(zg *ZoneGraph, row int, maxCol int) []string {
	prefix := fmt.Sprintf("a-1-%d-", row)
	var nodes []string
	for id := range zg.NodeSet {
		if strings.HasPrefix(id, prefix) {
			parts := strings.Split(id, "-")
			if len(parts) >= 4 {
				col := 0
				fmt.Sscanf(parts[3], "%d", &col)
				if col >= maxCol-1 && col <= maxCol {
					nodes = append(nodes, id)
				}
			}
		}
	}
	sort.Strings(nodes)
	return nodes
}

// findZoneExitNodes returns aisle cells at zone boundary for exit row.
func findZoneExitNodes(zg *ZoneGraph, row int, maxCol int) []string {
	return findZoneEntryNodes(zg, row, maxCol)
}

// runZoneSim runs a standalone zone simulation for one station zone.
func runZoneSim(
	raw *RawGraph,
	zone StationZone,
	botsPerStation int,
	palletCount int,
	cfg SimConfig,
	seed int64,
) ZoneResult {
	// Extract south zone subgraph (up to ~10m Y)
	maxY := 10.0
	zg := extractSouthZone(raw, maxY)

	// Find the deepest column in the zone for this station's rows
	maxCol := 0
	gwPrefix := fmt.Sprintf("a-1-%d-", zone.GatewayRow)
	for id := range zg.NodeSet {
		if strings.HasPrefix(id, gwPrefix) {
			parts := strings.Split(id, "-")
			if len(parts) >= 4 {
				col := 0
				fmt.Sscanf(parts[3], "%d", &col)
				if col > maxCol {
					maxCol = col
				}
			}
		}
	}

	// Build directed graph for the zone
	costs := CostParams{
		XYCostPerM:    1.0 / cfg.BotSpeedMps,
		ZUpCostPerM:   1.0 / cfg.ZUpSpeedMps,
		ZDownCostPerM: 1.0 / cfg.ZDownSpeedMps,
		XYTurnCost:    cfg.XYTurnTimeS,
		XYZTurnCost:   cfg.XYZTransitionTimeS,
	}
	zoneRaw := &RawGraph{Nodes: zg.Nodes, Edges: zg.Edges}
	dg := buildDirectedGraphFromRaw(zoneRaw, costs)

	// Find entry/exit spawn points
	entryNodes := findZoneEntryNodes(zg, zone.EntryRow, maxCol)
	exitNodes := findZoneExitNodes(zg, zone.ExitRow, maxCol)

	if len(entryNodes) == 0 {
		// Fallback: use first aisle cell in entry row
		prefix := fmt.Sprintf("a-1-%d-", zone.EntryRow)
		for id := range zg.NodeSet {
			if strings.HasPrefix(id, prefix) {
				entryNodes = append(entryNodes, id)
			}
		}
		sort.Strings(entryNodes)
		if len(entryNodes) > 2 {
			entryNodes = entryNodes[len(entryNodes)-2:]
		}
	}
	if len(exitNodes) == 0 {
		prefix := fmt.Sprintf("a-1-%d-", zone.ExitRow)
		for id := range zg.NodeSet {
			if strings.HasPrefix(id, prefix) {
				exitNodes = append(exitNodes, id)
			}
		}
		sort.Strings(exitNodes)
		if len(exitNodes) > 2 {
			exitNodes = exitNodes[len(exitNodes)-2:]
		}
	}

	rng := rand.New(rand.NewSource(seed))
	botPositions := make(map[string]int)

	// Spawn queue model: maintain a pool of N bot "slots".
	// A bot only enters the zone when the entry cell is free.
	bots := make([]*ZoneBot, botsPerStation)
	for i := range bots {
		bots[i] = &ZoneBot{
			ID:    i,
			State: "waiting", // waiting to enter
			Zone:  &zone,
		}
	}

	completedBots := 0
	totalCycleTime := 0
	totalWaitTicks := 0
	tasksRemaining := palletCount
	maxSteps := palletCount * 500
	step := 0

	for step < maxSteps && completedBots < palletCount {
		step++

		// Try to inject waiting bots at free entry cells
		for _, b := range bots {
			if b.State != "waiting" || tasksRemaining <= 0 {
				continue
			}
			entry := entryNodes[rng.Intn(len(entryNodes))]
			if _, occupied := botPositions[entry]; occupied {
				continue // entry blocked, try next tick
			}
			// Spawn into zone
			tasksRemaining--
			b.CurrentNodeID = entry
			b.State = "entering"
			b.EnteredAt = step
			b.WaitTicks = 0
			b.EdgeWaitTicks = 0
			botPositions[entry] = b.ID
			result := Dijkstra(dg, entry, zone.StationOp)
			if result != nil {
				b.Path = result.Path
				b.PathIndex = 0
			} else {
				b.State = "waiting"
				tasksRemaining++
				delete(botPositions, entry)
			}
			break // only inject one per tick to avoid entry collision
		}

		// Update active bots
		for _, b := range bots {
			if b.State == "waiting" || b.State == "done" {
				continue
			}
			if b.EdgeWaitTicks > 0 {
				b.EdgeWaitTicks--
				continue
			}

			switch b.State {
			case "entering":
				if b.PathIndex >= len(b.Path)-1 {
					b.State = "at_station"
					b.StepsRemaining = cfg.StationPickTimeS
					continue
				}
				nextNode := b.Path[b.PathIndex+1]
				// Enforce collision only in aisle cells (not station/gateway
				// nodes where bots pass through briefly in real operations)
				isAisle := strings.HasPrefix(nextNode, "a-")
				if isAisle {
					if occ, ok := botPositions[nextNode]; ok && occ != b.ID {
						b.WaitTicks++
						continue
					}
				}
				ticks := edgeTravelTicks(zoneRaw, zg.NodeIndex, b.CurrentNodeID, nextNode, cfg)
				delete(botPositions, b.CurrentNodeID)
				b.PathIndex++
				b.CurrentNodeID = b.Path[b.PathIndex]
				botPositions[b.CurrentNodeID] = b.ID
				if ticks > 1 {
					b.EdgeWaitTicks = ticks - 1
				}

			case "at_station":
				b.StepsRemaining--
				if b.StepsRemaining <= 0 {
					exitNode := exitNodes[rng.Intn(len(exitNodes))]
					result := Dijkstra(dg, b.CurrentNodeID, exitNode)
					if result != nil {
						b.Path = result.Path
						b.PathIndex = 0
						b.State = "exiting"
					} else {
						b.DoneAt = step
						completedBots++
						totalCycleTime += step - b.EnteredAt
						totalWaitTicks += b.WaitTicks
						delete(botPositions, b.CurrentNodeID)
						b.State = "waiting"
					}
				}

			case "exiting":
				if b.PathIndex >= len(b.Path) - 1 {
					b.DoneAt = step
					completedBots++
					totalCycleTime += step - b.EnteredAt
					totalWaitTicks += b.WaitTicks
					delete(botPositions, b.CurrentNodeID)
					b.State = "waiting" // ready for next task
					continue
				}
				nextNode := b.Path[b.PathIndex+1]
				isAisle := strings.HasPrefix(nextNode, "a-")
				if isAisle {
					if occ, ok := botPositions[nextNode]; ok && occ != b.ID {
						b.WaitTicks++
						continue
					}
				}
				ticks := edgeTravelTicks(zoneRaw, zg.NodeIndex, b.CurrentNodeID, nextNode, cfg)
				delete(botPositions, b.CurrentNodeID)
				b.PathIndex++
				b.CurrentNodeID = b.Path[b.PathIndex]
				botPositions[b.CurrentNodeID] = b.ID
				if ticks > 1 {
					b.EdgeWaitTicks = ticks - 1
				}
			}
		}
	}

	avgCycle := 0.0
	if completedBots > 0 {
		avgCycle = float64(totalCycleTime) / float64(completedBots)
	}
	throughput := 0.0
	if step > 0 {
		throughput = float64(completedBots) / (float64(step) / 3600.0)
	}
	avgWait := 0.0
	if completedBots > 0 {
		avgWait = float64(totalWaitTicks) / float64(totalCycleTime) * 100
	}

	return ZoneResult{
		Zone:            zone.Name,
		BotsPerStation:  botsPerStation,
		CompletedTasks:  completedBots,
		AvgCycleTimeS:   avgCycle,
		ThroughputPerHr: throughput,
		AvgWaitPct:      avgWait,
		Steps:           step,
	}
}

// ─── Zone analysis runner ───

func runZoneAnalysis(mapPath string, pallets int, shifts int) {
	raw, err := loadRawGraph(mapPath)
	if err != nil {
		fmt.Printf("Failed to load graph: %v\n", err)
		return
	}

	fmt.Println("=== Station Zone Congestion Analysis (South Dispatch) ===")
	fmt.Printf("Map:     %s\n", mapPath)
	fmt.Printf("Pallets: %d per run\n", pallets)
	fmt.Printf("Shifts:  %d per (zone, botCount)\n", shifts)
	fmt.Println()

	// Show zone graph info
	zg := extractSouthZone(raw, 10.0)
	fmt.Printf("Zone slice: %d nodes, %d edges (y < 10m, ground floor)\n", len(zg.Nodes), len(zg.Edges))

	// Count nodes per type
	kinds := map[string]int{}
	for _, n := range zg.Nodes {
		kinds[n.Kind]++
	}
	fmt.Printf("  Aisle cells: %d, Pallet positions: %d, Station nodes: %d\n",
		kinds["AISLE_CELL"], kinds["PALLET_POSITION"],
		kinds["STATION_OP"]+kinds["STATION_XY"]+kinds["STATION_PEZ"])
	fmt.Println()

	botCounts := []int{1, 2, 3, 4, 5, 6, 8, 10, 12, 15}
	cfg := defaultSimConfig

	startTime := time.Now()

	type zoneRow struct {
		zone string
		bots int
		results []ZoneResult
	}
	var allRows []zoneRow

	for _, zone := range southZones {
		for _, bc := range botCounts {
			var results []ZoneResult
			for s := 0; s < shifts; s++ {
				seed := int64(zone.GatewayRow*10000 + bc*100 + s)
				r := runZoneSim(raw, zone, bc, pallets, cfg, seed)
				results = append(results, r)
			}
			allRows = append(allRows, zoneRow{zone.Name, bc, results})
		}
	}

	elapsed := time.Since(startTime).Seconds()
	fmt.Printf("Completed in %.1fs\n\n", elapsed)

	// Print per-zone results
	for _, zone := range southZones {
		fmt.Printf("Station %s (%s) | entry=row %d, exit=row %d\n",
			zone.Name, zone.StationOp, zone.EntryRow, zone.ExitRow)
		fmt.Println("  Bots | Throughput/hr | Avg Cycle(s) | Wait%  | Completed")
		fmt.Println("  -----+--------------+--------------+--------+----------")
		for _, row := range allRows {
			if row.zone != zone.Name {
				continue
			}
			// Average across shifts
			n := float64(len(row.results))
			var thrSum, cycSum, waitSum float64
			totalComp := 0
			for _, r := range row.results {
				thrSum += r.ThroughputPerHr
				cycSum += r.AvgCycleTimeS
				waitSum += r.AvgWaitPct
				totalComp += r.CompletedTasks
			}
			fmt.Printf("  %4d | %12.1f | %12.1f | %5.1f%% | %d/%d\n",
				row.bots, thrSum/n, cycSum/n, waitSum/n,
				totalComp/len(row.results), pallets)
		}
		fmt.Println()
	}

	// Summary: find sweet spot per zone
	fmt.Println("Sweet Spot Summary")
	fmt.Println("  Zone | Best Bots | Peak Thr/hr | Cycle(s) | Wait%")
	fmt.Println("  -----+-----------+-------------+----------+------")
	for _, zone := range southZones {
		bestThr := 0.0
		bestBots := 0
		bestCyc := 0.0
		bestWait := 0.0
		for _, row := range allRows {
			if row.zone != zone.Name {
				continue
			}
			n := float64(len(row.results))
			var thrSum float64
			for _, r := range row.results {
				thrSum += r.ThroughputPerHr
			}
			avgThr := thrSum / n
			if avgThr > bestThr {
				bestThr = avgThr
				bestBots = row.bots
				var cycSum, waitSum float64
				for _, r := range row.results {
					cycSum += r.AvgCycleTimeS
					waitSum += r.AvgWaitPct
				}
				bestCyc = cycSum / n
				bestWait = waitSum / n
			}
		}
		fmt.Printf("  %s   | %9d | %11.1f | %8.1f | %4.1f%%\n",
			zone.Name, bestBots, bestThr, bestCyc, bestWait)
	}

	_ = math.Max // keep import
}
