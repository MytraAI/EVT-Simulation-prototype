// Standalone station-zone simulation for south dispatch.
//
// Models one-way bot flow per station:
//   Entry lane (north→south):  storage → entry aisle → station
//   Exit lane  (south→north):  station → transfer corridor → exit aisle → storage
//
// Rows 1-2 (y ≤ 3.81m) are treated as travel-only buffer (no storage).
// Cross-aisle transfers between entry and exit lanes go through pallet
// position nodes at these rows.
//
// Usage:
//   ./calibrate-bin --zone --pallets 200 --shifts 5

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
	Name      string
	StationOp string
	GatewayXY string
	EntryRow  int // gateway row — bots travel north→south
	ExitRow   int // adjacent row — bots travel south→north
}

var southZones = []StationZone{
	{"S1", "op-4-0", "xy-3-0", 3, 5},
	{"S2", "op-8-0", "xy-7-0", 7, 9},
	{"S3", "op-12-0", "xy-11-0", 11, 13},
	{"S4", "op-16-0", "xy-15-0", 15, 17},
}

// ─── Subgraph extraction ───

func extractSouthZone(raw *RawGraph, maxY float64) (*RawGraph, map[string]*RawNode) {
	nodeSet := make(map[string]bool)
	nodeIndex := make(map[string]*RawNode)
	var nodes []RawNode

	for i := range raw.Nodes {
		n := &raw.Nodes[i]
		if n.Position.ZM > 0.1 {
			continue // ground floor only
		}
		if n.Position.YM > maxY {
			continue
		}
		nodes = append(nodes, *n)
		nodeSet[n.ID] = true
	}
	for i := range nodes {
		nodeIndex[nodes[i].ID] = &nodes[i]
	}

	var edges []RawEdge
	for _, e := range raw.Edges {
		if nodeSet[e.A] && nodeSet[e.B] {
			edges = append(edges, e)
		}
	}

	return &RawGraph{Nodes: nodes, Edges: edges}, nodeIndex
}

// findDeepestAisleCell returns the aisle cell with highest Y in a given row
// within the zone. This is the entry/exit boundary point.
func findDeepestAisleCell(zoneRaw *RawGraph, row int) string {
	prefix := fmt.Sprintf("a-1-%d-", row)
	best := ""
	bestY := -1.0
	for _, n := range zoneRaw.Nodes {
		if strings.HasPrefix(n.ID, prefix) {
			if n.Position.YM > bestY {
				bestY = n.Position.YM
				best = n.ID
			}
		}
	}
	return best
}

// ─── Zone bot ───

type ZoneBot struct {
	ID             int
	State          string // "waiting", "to_station", "at_station", "to_exit", "done"
	CurrentNodeID  string
	Path           []string
	PathIndex      int
	StepsRemaining int
	EdgeWaitTicks  int
	EnteredAt      int
	WaitTicks      int
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

// ─── Simulation ───

func runZoneSim(
	raw *RawGraph,
	zone StationZone,
	numBots int,
	palletCount int,
	cfg SimConfig,
	seed int64,
) ZoneResult {
	maxY := 10.0
	zoneRaw, nodeIndex := extractSouthZone(raw, maxY)

	costs := CostParams{
		XYCostPerM:    1.0 / cfg.BotSpeedMps,
		ZUpCostPerM:   1.0 / cfg.ZUpSpeedMps,
		ZDownCostPerM: 1.0 / cfg.ZDownSpeedMps,
		XYTurnCost:    cfg.XYTurnTimeS,
		XYZTurnCost:   cfg.XYZTransitionTimeS,
	}
	dg := buildDirectedGraphFromRaw(zoneRaw, costs)

	entryCell := findDeepestAisleCell(zoneRaw, zone.EntryRow)
	exitCell := findDeepestAisleCell(zoneRaw, zone.ExitRow)

	if entryCell == "" || exitCell == "" {
		return ZoneResult{Zone: zone.Name, BotsPerStation: numBots}
	}

	// Verify paths exist
	toStation := Dijkstra(dg, entryCell, zone.StationOp)
	fromStation := Dijkstra(dg, zone.StationOp, exitCell)
	if toStation == nil || fromStation == nil {
		fmt.Printf("  WARNING: %s no path entry(%s)->stn or stn->exit(%s)\n",
			zone.Name, entryCell, exitCell)
		return ZoneResult{Zone: zone.Name, BotsPerStation: numBots}
	}

	rng := rand.New(rand.NewSource(seed))
	_ = rng
	botPositions := make(map[string]int)

	bots := make([]*ZoneBot, numBots)
	for i := range bots {
		bots[i] = &ZoneBot{ID: i, State: "waiting"}
	}

	completedBots := 0
	totalCycleTime := 0
	totalWaitTicks := 0
	tasksRemaining := palletCount
	maxSteps := palletCount * 500
	step := 0

	for step < maxSteps && completedBots < palletCount {
		step++

		// Inject one waiting bot per tick if entry is free
		for _, b := range bots {
			if b.State != "waiting" || tasksRemaining <= 0 {
				continue
			}
			if _, occ := botPositions[entryCell]; occ {
				break // entry occupied
			}
			tasksRemaining--
			b.CurrentNodeID = entryCell
			b.State = "to_station"
			b.EnteredAt = step
			b.WaitTicks = 0
			b.EdgeWaitTicks = 0
			botPositions[entryCell] = b.ID

			result := Dijkstra(dg, entryCell, zone.StationOp)
			if result != nil {
				b.Path = result.Path
				b.PathIndex = 0
			}
			break // one injection per tick
		}

		// Update bots
		for _, b := range bots {
			if b.State == "waiting" || b.State == "done" {
				continue
			}
			if b.EdgeWaitTicks > 0 {
				b.EdgeWaitTicks--
				continue
			}

			switch b.State {
			case "to_station":
				if b.PathIndex >= len(b.Path)-1 {
					b.State = "at_station"
					b.StepsRemaining = cfg.StationPickTimeS
					continue
				}
				nextNode := b.Path[b.PathIndex+1]
				// Collision in aisle cells only; station/gateway/pallet-transfer = pass-through
				if strings.HasPrefix(nextNode, "a-") {
					if occ, ok := botPositions[nextNode]; ok && occ != b.ID {
						b.WaitTicks++
						continue
					}
				}
				ticks := edgeTravelTicks(zoneRaw, nodeIndex, b.CurrentNodeID, nextNode, cfg)
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
					result := Dijkstra(dg, b.CurrentNodeID, exitCell)
					if result != nil {
						b.Path = result.Path
						b.PathIndex = 0
						b.State = "to_exit"
					} else {
						// Can't find exit, complete anyway
						completedBots++
						totalCycleTime += step - b.EnteredAt
						totalWaitTicks += b.WaitTicks
						delete(botPositions, b.CurrentNodeID)
						b.State = "waiting"
					}
				}

			case "to_exit":
				if b.PathIndex >= len(b.Path)-1 {
					completedBots++
					totalCycleTime += step - b.EnteredAt
					totalWaitTicks += b.WaitTicks
					delete(botPositions, b.CurrentNodeID)
					b.State = "waiting"
					continue
				}
				nextNode := b.Path[b.PathIndex+1]
				if strings.HasPrefix(nextNode, "a-") {
					if occ, ok := botPositions[nextNode]; ok && occ != b.ID {
						b.WaitTicks++
						continue
					}
				}
				ticks := edgeTravelTicks(zoneRaw, nodeIndex, b.CurrentNodeID, nextNode, cfg)
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
	if totalCycleTime > 0 {
		avgWait = float64(totalWaitTicks) / float64(totalCycleTime) * 100
	}

	return ZoneResult{
		Zone:            zone.Name,
		BotsPerStation:  numBots,
		CompletedTasks:  completedBots,
		AvgCycleTimeS:   avgCycle,
		ThroughputPerHr: throughput,
		AvgWaitPct:      avgWait,
		Steps:           step,
	}
}

// ─── Runner ───

func runZoneAnalysis(mapPath string, pallets int, shifts int) {
	raw, err := loadRawGraph(mapPath)
	if err != nil {
		fmt.Printf("Failed to load graph: %v\n", err)
		return
	}

	fmt.Println("=== Station Zone Analysis (South Dispatch) ===")
	fmt.Printf("Map:     %s\n", mapPath)
	fmt.Printf("Pallets: %d per run | Shifts: %d\n", pallets, shifts)
	fmt.Println()

	// Zone info
	zoneRaw, _ := extractSouthZone(raw, 10.0)
	kinds := map[string]int{}
	for _, n := range zoneRaw.Nodes {
		kinds[n.Kind]++
	}
	fmt.Printf("Zone slice (y < 10m, ground floor): %d nodes, %d edges\n",
		len(zoneRaw.Nodes), len(zoneRaw.Edges))
	fmt.Printf("  Aisles: %d | Pallet positions: %d | Station nodes: %d\n",
		kinds["AISLE_CELL"], kinds["PALLET_POSITION"],
		kinds["STATION_OP"]+kinds["STATION_XY"]+kinds["STATION_PEZ"])
	fmt.Println()

	// Show zone paths
	costs := CostParams{
		XYCostPerM: 1.0 / defaultSimConfig.BotSpeedMps,
		ZUpCostPerM: 1.0 / defaultSimConfig.ZUpSpeedMps,
		ZDownCostPerM: 1.0 / defaultSimConfig.ZDownSpeedMps,
		XYTurnCost: defaultSimConfig.XYTurnTimeS,
		XYZTurnCost: defaultSimConfig.XYZTransitionTimeS,
	}
	dg := buildDirectedGraphFromRaw(zoneRaw, costs)
	fmt.Println("Station zone paths:")
	for _, z := range southZones {
		entry := findDeepestAisleCell(zoneRaw, z.EntryRow)
		exit := findDeepestAisleCell(zoneRaw, z.ExitRow)
		toStn := Dijkstra(dg, entry, z.StationOp)
		toExit := Dijkstra(dg, z.StationOp, exit)
		entryHops, exitHops := 0, 0
		if toStn != nil { entryHops = len(toStn.Path) }
		if toExit != nil { exitHops = len(toExit.Path) }
		fmt.Printf("  %s: entry %s (%d hops) -> %s -> exit %s (%d hops)\n",
			z.Name, entry, entryHops, z.StationOp, exit, exitHops)
	}
	fmt.Println()

	botCounts := []int{1, 2, 3, 4, 5, 6, 8, 10, 12, 15}
	cfg := defaultSimConfig
	startTime := time.Now()

	type row struct {
		zone    string
		bots    int
		results []ZoneResult
	}
	var allRows []row

	for _, zone := range southZones {
		for _, bc := range botCounts {
			var results []ZoneResult
			for s := 0; s < shifts; s++ {
				seed := int64(zone.EntryRow*10000 + bc*100 + s)
				r := runZoneSim(raw, zone, bc, pallets, cfg, seed)
				results = append(results, r)
			}
			allRows = append(allRows, row{zone.Name, bc, results})
		}
	}

	fmt.Printf("Completed in %.1fs\n\n", time.Since(startTime).Seconds())

	// Per-zone table
	for _, zone := range southZones {
		fmt.Printf("%s (%s) | entry=row %d (N->S) | exit=row %d (S->N)\n",
			zone.Name, zone.StationOp, zone.EntryRow, zone.ExitRow)
		fmt.Println("  Bots  Thr/hr   Cycle(s)  Wait%%  Done")
		fmt.Println("  ----  ------   --------  -----  ----")
		for _, r := range allRows {
			if r.zone != zone.Name {
				continue
			}
			n := float64(len(r.results))
			var thr, cyc, wait float64
			done := 0
			for _, res := range r.results {
				thr += res.ThroughputPerHr
				cyc += res.AvgCycleTimeS
				wait += res.AvgWaitPct
				done += res.CompletedTasks
			}
			fmt.Printf("  %4d  %6.1f   %8.1f  %4.1f%%  %d/%d\n",
				r.bots, thr/n, cyc/n, wait/n, done/len(r.results), pallets)
		}
		fmt.Println()
	}

	// Sweet spot
	fmt.Println("Sweet Spot per Station")
	fmt.Println("  Zone  Bots  Peak Thr/hr  Cycle(s)  Wait%%")
	fmt.Println("  ----  ----  -----------  --------  -----")
	for _, zone := range southZones {
		bestThr, bestBots := 0.0, 0
		var bestCyc, bestWait float64
		for _, r := range allRows {
			if r.zone != zone.Name {
				continue
			}
			n := float64(len(r.results))
			var thr float64
			for _, res := range r.results {
				thr += res.ThroughputPerHr
			}
			avg := thr / n
			if avg > bestThr {
				bestThr = avg
				bestBots = r.bots
				var c, w float64
				for _, res := range r.results {
					c += res.AvgCycleTimeS
					w += res.AvgWaitPct
				}
				bestCyc = c / n
				bestWait = w / n
			}
		}
		fmt.Printf("  %s    %4d  %11.1f  %8.1f  %4.1f%%\n",
			zone.Name, bestBots, bestThr, bestCyc, bestWait)
	}

	_ = math.Max
	_ = sort.Strings
}
