// Headless congestion calibration runner.
//
// Runs time-stepped warehouse sim at sampled bot counts with both
// no-collision and strict CA* (cooperative A*), using goroutines
// to saturate all CPU cores.
//
// Usage:
//
//	go run ./cmd/calibrate --map app/public/grainger-pilot-04102026-graph.json \
//	    --bots 1,2,4,6,8,10,15,20,30,50 --shifts 10 --pallets 200

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Graph loading ───

type RawGraph struct {
	Nodes []RawNode `json:"nodes"`
	Edges []RawEdge `json:"edges"`
}

type RawNode struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Level    int    `json:"level"`
	Position struct {
		XM float64 `json:"x_m"`
		YM float64 `json:"y_m"`
		ZM float64 `json:"z_m"`
	} `json:"position"`
	MaxPalletHeightM float64 `json:"max_pallet_height_m"`
	MaxPalletMassKg  float64 `json:"max_pallet_mass_kg"`
	SizeXM           float64 `json:"size_x_m"`
	SizeYM           float64 `json:"size_y_m"`
	Computed         *struct {
		BotOcclusionIDs []string `json:"bot_occupancy_occlusions"`
	} `json:"computed,omitempty"`
}

type RawEdge struct {
	ID               string  `json:"id"`
	A                string  `json:"a"`
	B                string  `json:"b"`
	Axis             string  `json:"axis"`
	DistanceM        float64 `json:"distance_m"`
	MaxPalletHeightM float64 `json:"max_pallet_height_m"`
}

func loadRawGraph(path string) (*RawGraph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var g RawGraph
	if err := json.Unmarshal(data, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

func buildDirectedGraphFromRaw(raw *RawGraph, costs CostParams) *DirectedGraph {
	nodes := make([]PhysicalNode, len(raw.Nodes))
	for i, n := range raw.Nodes {
		nodes[i] = PhysicalNode{
			ID: n.ID, Kind: n.Kind, Level: n.Level,
			XM: n.Position.XM, YM: n.Position.YM, ZM: n.Position.ZM,
			MaxPalletHeightM: n.MaxPalletHeightM, MaxPalletMassKg: n.MaxPalletMassKg,
			SizeXM: n.SizeXM, SizeYM: n.SizeYM,
		}
	}
	edges := make([]PhysicalEdge, len(raw.Edges))
	for i, e := range raw.Edges {
		edges[i] = PhysicalEdge{
			ID: e.ID, A: e.A, B: e.B, Axis: e.Axis,
			DistanceM: e.DistanceM, MaxPalletHeightM: e.MaxPalletHeightM,
		}
	}
	return BuildDirectedGraph(nodes, edges, costs)
}

// ─── Sim types ───

type BotState int

const (
	BotIdle BotState = iota
	BotTravelingToPickup
	BotEdgeWait
	BotPicking
	BotTravelingToDropoff
	BotEdgeWaitDrop
	BotPlacing
)

type Bot struct {
	ID                  int
	State               BotState
	CurrentNodeID       string
	Path                []string
	PathIndex           int
	Task                *Task
	StepsRemaining      int
	EdgeWaitTicks       int
	CollisionWaitTicks  int
	TotalIdleSteps      int
	TotalBusySteps      int
	TotalCollisionWaits int
	TasksCompleted      int
}

type TaskType int

const (
	TaskInduction TaskType = iota
	TaskRetrieval
)

type Task struct {
	ID              int
	Type            TaskType
	SKU             string
	StationNodeID   string
	PositionNodeID  string
	AssignedBotID   int
	CreatedAtStep   int
	CompletedAtStep int
}

type SimConfig struct {
	BotCount           int
	Algorithm          string // "no-collision" or "ca-star"
	BotSpeedMps        float64
	ZUpSpeedMps        float64
	ZDownSpeedMps      float64
	XYTurnTimeS        float64
	XYZTransitionTimeS float64
	StationPickTimeS   int
	StationDropTimeS   int
	PositionPickTimeS  int
	PositionDropTimeS  int
	ShiftPalletCount   int
	InitialFillPct     float64
}

var defaultSimConfig = SimConfig{
	BotCount: 5, Algorithm: "no-collision",
	BotSpeedMps: 1.0, ZUpSpeedMps: 0.1, ZDownSpeedMps: 0.5,
	XYTurnTimeS: 2, XYZTransitionTimeS: 3,
	StationPickTimeS: 8, StationDropTimeS: 6,
	PositionPickTimeS: 4, PositionDropTimeS: 5,
	ShiftPalletCount: 100, InitialFillPct: 0.0,
}

type SimState struct {
	Step                int
	Bots                []*Bot
	Tasks               []*Task
	CompletedTasks      []*Task
	Pallets             map[string]bool
	BotPositions        map[string]int // nodeID -> botID
	ShiftTasksGenerated int
	ShiftDone           bool
	TaskCounter         int

	// Station congestion tracking
	StationBusyTicks map[string]int // station -> ticks a bot was operating there
	StationQueueSum  map[string]int // station -> cumulative queue-depth-ticks
	StationMaxQueue  map[string]int // station -> peak queue depth seen
	StationTasks     map[string]int // station -> tasks completed through this station

	// Zone congestion: each node mapped to nearest station by X coordinate
	NodeZone        map[string]string // nodeID -> stationOp ID
	ZoneBotSum      map[string]int    // station -> cumulative bots-in-zone-ticks
	ZoneMaxBots     map[string]int    // station -> peak bots in zone
	ZoneGatewaySum  map[string]int    // station -> cumulative bots-at-gateway-ticks
	ZoneGatewayMax  map[string]int    // station -> peak bots at gateway
	GatewayNodes    map[string]string // STATION_XY nodeID -> stationOp ID

	graph           *DirectedGraph
	raw             *RawGraph
	adjIndex        *AdjIndex
	nodeIndex       map[string]*RawNode
	stationOps      []string
	palletPositions []string
	aisles          []string
	rng             *rand.Rand
	heurCache       map[string]map[string]float64 // target -> {nodeID -> cost}
}

func newSimState(raw *RawGraph, g *DirectedGraph, cfg SimConfig, seed int64) *SimState {
	rng := rand.New(rand.NewSource(seed))
	nodeIndex := make(map[string]*RawNode, len(raw.Nodes))
	var stationOps, palletPositions, aisles []string

	for i := range raw.Nodes {
		n := &raw.Nodes[i]
		nodeIndex[n.ID] = n
		switch n.Kind {
		case "STATION_OP":
			stationOps = append(stationOps, n.ID)
		case "PALLET_POSITION":
			palletPositions = append(palletPositions, n.ID)
		case "AISLE_CELL":
			aisles = append(aisles, n.ID)
		}
	}

	startNodes := aisles
	if len(startNodes) == 0 {
		startNodes = stationOps
	}

	bots := make([]*Bot, cfg.BotCount)
	botPositions := make(map[string]int)
	for i := 0; i < cfg.BotCount; i++ {
		startNode := startNodes[i%len(startNodes)]
		bots[i] = &Bot{ID: i, State: BotIdle, CurrentNodeID: startNode}
		botPositions[startNode] = i
	}

	pallets := make(map[string]bool)
	fillCount := int(float64(len(palletPositions)) * cfg.InitialFillPct)
	perm := rng.Perm(len(palletPositions))
	for i := 0; i < fillCount && i < len(perm); i++ {
		pallets[palletPositions[perm[i]]] = true
	}

	stBusy := make(map[string]int, len(stationOps))
	stQueue := make(map[string]int, len(stationOps))
	stMax := make(map[string]int, len(stationOps))
	stTasks := make(map[string]int, len(stationOps))

	// Build node-to-zone mapping: assign every node to nearest station by X
	stationXYs := make(map[string]string) // STATION_XY id -> nearest station op
	nodeZone := make(map[string]string, len(raw.Nodes))
	// Collect station X positions
	type stnPos struct {
		id string
		x  float64
	}
	var stns []stnPos
	for _, sid := range stationOps {
		n := nodeIndex[sid]
		stns = append(stns, stnPos{sid, n.Position.XM})
	}
	// Map STATION_XY to nearest station
	for i := range raw.Nodes {
		n := &raw.Nodes[i]
		if n.Kind == "STATION_XY" {
			best := ""
			bestDist := math.MaxFloat64
			for _, s := range stns {
				d := math.Abs(n.Position.XM - s.x)
				if d < bestDist {
					bestDist = d
					best = s.id
				}
			}
			stationXYs[n.ID] = best
		}
	}
	// Map all nodes to nearest station
	for i := range raw.Nodes {
		n := &raw.Nodes[i]
		best := ""
		bestDist := math.MaxFloat64
		for _, s := range stns {
			d := math.Abs(n.Position.XM - s.x)
			if d < bestDist {
				bestDist = d
				best = s.id
			}
		}
		nodeZone[n.ID] = best
	}

	zoneBotSum := make(map[string]int, len(stationOps))
	zoneMaxBots := make(map[string]int, len(stationOps))
	zoneGwSum := make(map[string]int, len(stationOps))
	zoneGwMax := make(map[string]int, len(stationOps))

	return &SimState{
		Bots: bots, Tasks: make([]*Task, 0), CompletedTasks: make([]*Task, 0),
		Pallets: pallets, BotPositions: botPositions,
		StationBusyTicks: stBusy, StationQueueSum: stQueue,
		StationMaxQueue: stMax, StationTasks: stTasks,
		NodeZone: nodeZone, ZoneBotSum: zoneBotSum, ZoneMaxBots: zoneMaxBots,
		ZoneGatewaySum: zoneGwSum, ZoneGatewayMax: zoneGwMax, GatewayNodes: stationXYs,
		graph: g, raw: raw, adjIndex: BuildAdjIndex(raw), nodeIndex: nodeIndex, rng: rng,
		stationOps: stationOps, palletPositions: palletPositions, aisles: aisles,
		heurCache: make(map[string]map[string]float64),
	}
}

// ─── Task generation (aggressive) ───

// Fill-then-drain: first half inductions, second half retrievals.
// This guarantees every task can be fulfilled.
func (s *SimState) generateTask(cfg SimConfig) *Task {
	if len(s.stationOps) == 0 {
		return nil
	}

	station := s.stationOps[s.rng.Intn(len(s.stationOps))]
	half := cfg.ShiftPalletCount / 2

	// Build sets of targeted positions
	inductTargets := make(map[string]bool)
	retrieveTargets := make(map[string]bool)
	for _, t := range s.Tasks {
		if t.Type == TaskInduction {
			inductTargets[t.PositionNodeID] = true
		} else {
			retrieveTargets[t.PositionNodeID] = true
		}
	}

	// First half: inductions. Second half: retrievals.
	wantInduction := s.ShiftTasksGenerated < half

	if wantInduction {
		perm := s.rng.Perm(len(s.palletPositions))
		for _, idx := range perm {
			pid := s.palletPositions[idx]
			if !s.Pallets[pid] && !inductTargets[pid] {
				s.TaskCounter++
				return &Task{
					ID: s.TaskCounter, Type: TaskInduction, SKU: "SKU-001",
					StationNodeID: station, PositionNodeID: pid,
					AssignedBotID: -1, CreatedAtStep: s.Step, CompletedAtStep: -1,
				}
			}
		}
		return nil // no empty positions
	}

	// Retrieval phase
	candidates := make([]string, 0)
	for pid := range s.Pallets {
		if !retrieveTargets[pid] {
			candidates = append(candidates, pid)
		}
	}
	if len(candidates) > 0 {
		pid := candidates[s.rng.Intn(len(candidates))]
		s.TaskCounter++
		return &Task{
			ID: s.TaskCounter, Type: TaskRetrieval, SKU: "SKU-001",
			StationNodeID: station, PositionNodeID: pid,
			AssignedBotID: -1, CreatedAtStep: s.Step, CompletedAtStep: -1,
		}
	}
	return nil
}

// ─── Edge travel time ───

func edgeTravelTicks(raw *RawGraph, nodeIndex map[string]*RawNode, fromID, toID string, cfg SimConfig) int {
	for _, e := range raw.Edges {
		if (e.A == fromID && e.B == toID) || (e.B == fromID && e.A == toID) {
			var travelS float64
			if e.Axis == "z" {
				fromN := nodeIndex[fromID]
				toN := nodeIndex[toID]
				if fromN != nil && toN != nil && toN.Position.ZM > fromN.Position.ZM {
					travelS = e.DistanceM / cfg.ZUpSpeedMps
				} else {
					travelS = e.DistanceM / cfg.ZDownSpeedMps
				}
			} else {
				travelS = e.DistanceM / cfg.BotSpeedMps
			}
			ticks := int(math.Ceil(travelS))
			if ticks < 1 {
				ticks = 1
			}
			return ticks
		}
	}
	return 1
}

// ─── Simulation step ───

// getBotTarget returns the navigation target for a bot, or "" if stationary.
func getBotTarget(b *Bot) string {
	if b.Task == nil {
		return ""
	}
	switch b.State {
	case BotTravelingToPickup, BotEdgeWait:
		if b.Task.Type == TaskInduction {
			return b.Task.StationNodeID
		}
		return b.Task.PositionNodeID
	case BotTravelingToDropoff, BotEdgeWaitDrop:
		if b.Task.Type == TaskInduction {
			return b.Task.PositionNodeID
		}
		return b.Task.StationNodeID
	default:
		return ""
	}
}

func stepSimulation(s *SimState, cfg SimConfig) {
	if s.ShiftDone {
		return
	}
	s.Step++

	// Aggressive task generation: fill task queue so all idle bots can get work
	idleBots := 0
	for _, b := range s.Bots {
		if b.State == BotIdle {
			idleBots++
		}
	}
	unassigned := 0
	for _, t := range s.Tasks {
		if t.AssignedBotID == -1 {
			unassigned++
		}
	}

	// Generate up to (idleBots - unassigned + buffer) tasks per step
	needed := idleBots - unassigned + 3
	for i := 0; i < needed && s.ShiftTasksGenerated < cfg.ShiftPalletCount; i++ {
		t := s.generateTask(cfg)
		if t != nil {
			s.Tasks = append(s.Tasks, t)
			s.ShiftTasksGenerated++
		} else {
			break // can't generate more
		}
	}

	// Shift done when all generated tasks are completed
	if s.ShiftTasksGenerated >= cfg.ShiftPalletCount && len(s.Tasks) == 0 {
		s.ShiftDone = true
		return
	}
	// Also done if all active tasks are complete and we can't generate more
	// (e.g. retrieval impossible because no pallets left)
	if len(s.Tasks) == 0 && len(s.CompletedTasks) > 0 {
		// Try one more generation attempt
		t := s.generateTask(cfg)
		if t != nil {
			s.Tasks = append(s.Tasks, t)
			s.ShiftTasksGenerated++
		} else {
			// Can't generate, all current tasks done — end shift
			s.ShiftDone = true
			return
		}
	}

	// CA* uses reactive rerouting — plans are computed on conflict,
	// not every tick, for performance.
	var caPlans map[int][]string
	_ = caPlans

	// Update bots
	for _, b := range s.Bots {
		// Edge wait
		if b.State == BotEdgeWait || b.State == BotEdgeWaitDrop {
			b.TotalBusySteps++
			b.EdgeWaitTicks--
			if b.EdgeWaitTicks <= 0 {
				if b.PathIndex >= len(b.Path)-1 {
					if b.State == BotEdgeWait {
						b.State = BotPicking
						if b.Task.Type == TaskInduction {
							b.StepsRemaining = cfg.StationPickTimeS
						} else {
							b.StepsRemaining = cfg.PositionPickTimeS
						}
					} else {
						b.State = BotPlacing
						if b.Task.Type == TaskInduction {
							b.StepsRemaining = cfg.PositionDropTimeS
						} else {
							b.StepsRemaining = cfg.StationDropTimeS
						}
					}
				} else {
					if b.State == BotEdgeWait {
						b.State = BotTravelingToPickup
					} else {
						b.State = BotTravelingToDropoff
					}
				}
			}
			continue
		}

		switch b.State {
		case BotIdle:
			b.TotalIdleSteps++
			for _, t := range s.Tasks {
				if t.AssignedBotID == -1 {
					t.AssignedBotID = b.ID
					b.Task = t
					var target string
					if t.Type == TaskInduction {
						target = t.StationNodeID
					} else {
						target = t.PositionNodeID
					}
					// Use cooperative plan if available, else Dijkstra
					if plan, ok := caPlans[b.ID]; ok && len(plan) > 1 {
						b.Path = plan
					} else {
						result := Dijkstra(s.graph, b.CurrentNodeID, target)
						if result != nil {
							b.Path = result.Path
						} else {
							t.AssignedBotID = -1
							b.Task = nil
							break
						}
					}
					b.PathIndex = 0
					b.State = BotTravelingToPickup
					break
				}
			}

		case BotTravelingToPickup, BotTravelingToDropoff:
			b.TotalBusySteps++
			if b.PathIndex < len(b.Path)-1 {
				nextNode := b.Path[b.PathIndex+1]

				// Soft-collision: wait up to 5 ticks, then phase through
				if cfg.Algorithm == "soft-collision" {
					if occupant, ok := s.BotPositions[nextNode]; ok && occupant != b.ID {
						b.CollisionWaitTicks++
						b.TotalCollisionWaits++
						if b.CollisionWaitTicks < 5 {
							continue
						}
					}
				}
				// CA*: strict block with space-time A* reroute.
				// At 3 ticks: reroute using reservation-aware space-time A*.
				// At 15 ticks: orchestrator intervention (phase-through).
				if cfg.Algorithm == "ca-star" {
					if occupant, ok := s.BotPositions[nextNode]; ok && occupant != b.ID {
						b.CollisionWaitTicks++
						b.TotalCollisionWaits++

						if b.CollisionWaitTicks == 3 && b.Task != nil {
							var target string
							if b.State == BotTravelingToPickup {
								if b.Task.Type == TaskInduction {
									target = b.Task.StationNodeID
								} else {
									target = b.Task.PositionNodeID
								}
							} else {
								if b.Task.Type == TaskInduction {
									target = b.Task.PositionNodeID
								} else {
									target = b.Task.StationNodeID
								}
							}
							rt := buildReservationTable(s.Bots, s.Step)
							newPath := PlanCAStarPath(
								s.graph, s.adjIndex, s.nodeIndex,
								b.CurrentNodeID, target, s.Step, b.ID,
								rt, cfg, s.heurCache,
							)
							if newPath != nil && len(newPath) > 1 {
								b.Path = newPath
								b.PathIndex = 0
								// Don't reset CollisionWaitTicks —
								// phase-through timer must keep ticking.
								continue
							}
						}

						if b.CollisionWaitTicks >= 15 {
							b.CollisionWaitTicks = 0
						} else {
							continue
						}
					}
				}
				b.CollisionWaitTicks = 0

				// Movement
				ticks := edgeTravelTicks(s.raw, s.nodeIndex, b.CurrentNodeID, nextNode, cfg)
				delete(s.BotPositions, b.CurrentNodeID)
				b.PathIndex++
				b.CurrentNodeID = b.Path[b.PathIndex]
				s.BotPositions[b.CurrentNodeID] = b.ID

				if ticks > 1 {
					b.EdgeWaitTicks = ticks - 1
					if b.State == BotTravelingToPickup {
						b.State = BotEdgeWait
					} else {
						b.State = BotEdgeWaitDrop
					}
					continue
				}

				if b.PathIndex >= len(b.Path)-1 {
					if b.State == BotTravelingToPickup {
						b.State = BotPicking
						if b.Task.Type == TaskInduction {
							b.StepsRemaining = cfg.StationPickTimeS
						} else {
							b.StepsRemaining = cfg.PositionPickTimeS
						}
					} else {
						b.State = BotPlacing
						if b.Task.Type == TaskInduction {
							b.StepsRemaining = cfg.PositionDropTimeS
						} else {
							b.StepsRemaining = cfg.StationDropTimeS
						}
					}
				}
			}
		case BotPicking:
			b.TotalBusySteps++
			b.StepsRemaining--
			if b.StepsRemaining <= 0 && b.Task != nil {
				var target string
				if b.Task.Type == TaskInduction {
					target = b.Task.PositionNodeID
				} else {
					target = b.Task.StationNodeID
				}
				result := Dijkstra(s.graph, b.CurrentNodeID, target)
				if result != nil {
					b.Path = result.Path
					b.PathIndex = 0
					b.State = BotTravelingToDropoff
				} else {
					b.State = BotIdle
					b.Task = nil
				}
			}

		case BotPlacing:
			b.TotalBusySteps++
			b.StepsRemaining--
			if b.StepsRemaining <= 0 && b.Task != nil {
				if b.Task.Type == TaskInduction {
					s.Pallets[b.Task.PositionNodeID] = true
				} else {
					delete(s.Pallets, b.Task.PositionNodeID)
				}
				b.Task.CompletedAtStep = s.Step
				s.CompletedTasks = append(s.CompletedTasks, b.Task)
				// Remove from active
				for i, t := range s.Tasks {
					if t.ID == b.Task.ID {
						s.Tasks = append(s.Tasks[:i], s.Tasks[i+1:]...)
						break
					}
				}
				s.StationTasks[b.Task.StationNodeID]++
				b.TasksCompleted++
				b.State = BotIdle
				b.Task = nil
			}
		}
	}

	// Station congestion: count bots at/targeting each station this tick
	stationQueue := make(map[string]int, len(s.stationOps))
	for _, b := range s.Bots {
		if b.Task == nil {
			continue
		}
		stn := b.Task.StationNodeID
		switch b.State {
		case BotPicking:
			// At station for induction pickup or retrieval dropoff
			if b.Task.Type == TaskInduction {
				s.StationBusyTicks[stn]++
			}
			stationQueue[stn]++
		case BotPlacing:
			if b.Task.Type == TaskRetrieval {
				s.StationBusyTicks[stn]++
			}
			stationQueue[stn]++
		case BotTravelingToPickup, BotEdgeWait:
			if b.Task.Type == TaskInduction {
				stationQueue[stn]++ // heading to station
			}
		case BotTravelingToDropoff, BotEdgeWaitDrop:
			if b.Task.Type == TaskRetrieval {
				stationQueue[stn]++ // heading to station
			}
		}
	}
	for stn, q := range stationQueue {
		s.StationQueueSum[stn] += q
		if q > s.StationMaxQueue[stn] {
			s.StationMaxQueue[stn] = q
		}
	}

	// Zone congestion: count bots in each station's zone (aisles + gateway)
	zoneBots := make(map[string]int)
	gatewayBots := make(map[string]int)
	for _, b := range s.Bots {
		if zone, ok := s.NodeZone[b.CurrentNodeID]; ok {
			zoneBots[zone]++
		}
		if stn, ok := s.GatewayNodes[b.CurrentNodeID]; ok {
			gatewayBots[stn]++
		}
	}
	for stn, n := range zoneBots {
		s.ZoneBotSum[stn] += n
		if n > s.ZoneMaxBots[stn] {
			s.ZoneMaxBots[stn] = n
		}
	}
	for stn, n := range gatewayBots {
		s.ZoneGatewaySum[stn] += n
		if n > s.ZoneGatewayMax[stn] {
			s.ZoneGatewayMax[stn] = n
		}
	}
}

// ─── Work items ───

type WorkItem struct {
	BotCount   int
	Algorithm  string
	ShiftIndex int
}

type StationMetrics struct {
	ID            string  `json:"id"`
	Tasks         int     `json:"tasks"`
	UtilPct       float64 `json:"utilPct"`
	AvgQueue      float64 `json:"avgQueue"`
	MaxQueue      int     `json:"maxQueue"`
	ZoneAvgBots   float64 `json:"zoneAvgBots"`
	ZoneMaxBots   int     `json:"zoneMaxBots"`
	GwAvgBots     float64 `json:"gwAvgBots"`
	GwMaxBots     int     `json:"gwMaxBots"`
}

type WorkResult struct {
	WorkItem
	AvgCycleTimeS     float64
	ThroughputPerHour float64
	AvgUtilization    float64
	CollisionWaitPct  float64
	CompletedTasks    int
	Steps             int
	Stations          []StationMetrics
}

func runShift(raw *RawGraph, costs CostParams, item WorkItem, palletCount int) WorkResult {
	g := buildDirectedGraphFromRaw(raw, costs)
	cfg := defaultSimConfig
	cfg.BotCount = item.BotCount
	cfg.Algorithm = item.Algorithm
	cfg.ShiftPalletCount = palletCount

	seed := int64(item.BotCount*1000 + item.ShiftIndex)
	state := newSimState(raw, g, cfg, seed)
	maxSteps := palletCount * 1000 // generous limit

	for !state.ShiftDone && state.Step < maxSteps {
		stepSimulation(state, cfg)
	}

	var totalCycleTime int
	for _, t := range state.CompletedTasks {
		if t.CompletedAtStep >= 0 {
			totalCycleTime += t.CompletedAtStep - t.CreatedAtStep
		}
	}

	completed := len(state.CompletedTasks)
	avgCycle := 0.0
	if completed > 0 {
		avgCycle = float64(totalCycleTime) / float64(completed)
	}
	throughput := 0.0
	if state.Step > 0 {
		throughput = float64(completed) / (float64(state.Step) / 3600.0)
	}

	var utilSum float64
	var totalCollision, totalBusy int
	for _, b := range state.Bots {
		total := b.TotalBusySteps + b.TotalIdleSteps
		if total > 0 {
			utilSum += float64(b.TotalBusySteps) / float64(total)
		}
		totalCollision += b.TotalCollisionWaits
		totalBusy += b.TotalBusySteps
	}

	avgUtil := 0.0
	if cfg.BotCount > 0 {
		avgUtil = utilSum / float64(cfg.BotCount)
	}
	collPct := 0.0
	if totalBusy+totalCollision > 0 {
		collPct = float64(totalCollision) / float64(totalBusy+totalCollision)
	}

	// Station metrics
	var stMetrics []StationMetrics
	for _, stn := range state.stationOps {
		util := 0.0
		if state.Step > 0 {
			util = float64(state.StationBusyTicks[stn]) / float64(state.Step) * 100
		}
		avgQ := 0.0
		if state.Step > 0 {
			avgQ = float64(state.StationQueueSum[stn]) / float64(state.Step)
		}
		zAvg := 0.0
		if state.Step > 0 {
			zAvg = float64(state.ZoneBotSum[stn]) / float64(state.Step)
		}
		gwAvg := 0.0
		if state.Step > 0 {
			gwAvg = float64(state.ZoneGatewaySum[stn]) / float64(state.Step)
		}
		stMetrics = append(stMetrics, StationMetrics{
			ID:          stn,
			Tasks:       state.StationTasks[stn],
			UtilPct:     util,
			AvgQueue:    avgQ,
			MaxQueue:    state.StationMaxQueue[stn],
			ZoneAvgBots: zAvg,
			ZoneMaxBots: state.ZoneMaxBots[stn],
			GwAvgBots:   gwAvg,
			GwMaxBots:   state.ZoneGatewayMax[stn],
		})
	}

	return WorkResult{
		WorkItem:          item,
		AvgCycleTimeS:     avgCycle,
		ThroughputPerHour: throughput,
		AvgUtilization:    avgUtil,
		CollisionWaitPct:  collPct,
		CompletedTasks:    completed,
		Steps:             state.Step,
		Stations:          stMetrics,
	}
}

// ─── Main ───

func main() {
	debugMode := flag.Bool("debug", false, "Run diagnostic trace instead of calibration")
	zoneMode := flag.Bool("zone", false, "Run station zone congestion analysis (south dispatch)")
	mapPath := flag.String("map", "app/public/grainger-pilot-04102026-graph.json", "Graph JSON path")
	botsStr := flag.String("bots", "2,5,10,15,20,30,40,50,75,100,150,200", "Comma-separated bot counts")
	shifts := flag.Int("shifts", 5, "Shifts per (botCount, algo) pair")
	pallets := flag.Int("pallets", 200, "Tasks per shift")
	workers := flag.Int("workers", runtime.NumCPU(), "Max goroutines")
	outPath := flag.String("out", "calibration-results.json", "Output JSON path")
	csvPath := flag.String("csv", "", "Also output CSV")
	flag.Parse()

	if *debugMode {
		runDiagnostic(*mapPath)
		return
	}
	if *zoneMode {
		runZoneAnalysis(*mapPath, *pallets, *shifts)
		return
	}

	runtime.GOMAXPROCS(*workers)

	var botCounts []int
	for _, s := range strings.Split(*botsStr, ",") {
		n, _ := strconv.Atoi(strings.TrimSpace(s))
		if n > 0 {
			botCounts = append(botCounts, n)
		}
	}

	fmt.Println("=== EVT Congestion Calibration (Go, CA*) ===")
	fmt.Printf("Map:        %s\n", *mapPath)
	fmt.Printf("Bot counts: %v\n", botCounts)
	fmt.Printf("Shifts:     %d per (botCount, algorithm)\n", *shifts)
	fmt.Printf("Pallets:    %d per shift\n", *pallets)
	fmt.Printf("Workers:    %d goroutines (of %d cores)\n", *workers, runtime.NumCPU())
	fmt.Println()

	raw, err := loadRawGraph(*mapPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load graph: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Graph: %d nodes, %d edges\n", len(raw.Nodes), len(raw.Edges))

	// no-collision baseline + ca-star (strict block + replan-on-conflict)
	algorithms := []string{"no-collision", "ca-star"}
	var items []WorkItem
	for _, bc := range botCounts {
		for _, algo := range algorithms {
			for s := 0; s < *shifts; s++ {
				items = append(items, WorkItem{BotCount: bc, Algorithm: algo, ShiftIndex: s})
			}
		}
	}
	fmt.Printf("Total work units: %d\n\n", len(items))

	costs := CostParams{
		XYCostPerM:    1.0 / defaultSimConfig.BotSpeedMps,
		ZUpCostPerM:   1.0 / defaultSimConfig.ZUpSpeedMps,
		ZDownCostPerM: 1.0 / defaultSimConfig.ZDownSpeedMps,
		XYTurnCost:    defaultSimConfig.XYTurnTimeS,
		XYZTurnCost:   defaultSimConfig.XYZTransitionTimeS,
	}

	startTime := time.Now()
	results := make([]WorkResult, len(items))
	var completed int64
	total := int64(len(items))

	sem := make(chan struct{}, *workers)
	var wg sync.WaitGroup

	for i, item := range items {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, it WorkItem) {
			defer wg.Done()
			defer func() { <-sem }()

			results[idx] = runShift(raw, costs, it, *pallets)
			c := atomic.AddInt64(&completed, 1)

			elapsed := time.Since(startTime).Seconds()
			rate := float64(c) / elapsed
			eta := float64(total-c) / rate
			r := results[idx]
			fmt.Printf("\r  [%d%%] %d/%d | %.1fs | %.1f/s | ETA %.0fs | %d bots %s s%d → %d tasks in %d steps   ",
				c*100/total, c, total, elapsed, rate, eta,
				it.BotCount, it.Algorithm, it.ShiftIndex, r.CompletedTasks, r.Steps)
		}(i, item)
	}
	wg.Wait()
	fmt.Printf("\n\nCompleted in %.1fs\n\n", time.Since(startTime).Seconds())

	// Aggregate
	aggMap := make(map[string][]WorkResult)
	for _, r := range results {
		key := fmt.Sprintf("%d:%s", r.BotCount, r.Algorithm)
		aggMap[key] = append(aggMap[key], r)
	}

	type AggResult struct {
		AvgCycleTimeS     float64 `json:"avgCycleTimeS"`
		ThroughputPerHour float64 `json:"throughputPerHour"`
		AvgUtilization    float64 `json:"avgUtilization"`
		CollisionWaitPct  float64 `json:"avgCollisionWaitPct"`
		TotalTasks        int     `json:"totalTasks"`
		ShiftsRun         int     `json:"shiftsRun"`
	}

	agg := func(rs []WorkResult) AggResult {
		n := len(rs)
		if n == 0 {
			return AggResult{}
		}
		var a AggResult
		for _, r := range rs {
			a.AvgCycleTimeS += r.AvgCycleTimeS
			a.ThroughputPerHour += r.ThroughputPerHour
			a.AvgUtilization += r.AvgUtilization
			a.CollisionWaitPct += r.CollisionWaitPct
			a.TotalTasks += r.CompletedTasks
		}
		a.AvgCycleTimeS /= float64(n)
		a.ThroughputPerHour /= float64(n)
		a.AvgUtilization /= float64(n)
		a.CollisionWaitPct /= float64(n)
		a.ShiftsRun = n
		return a
	}

	type SampleStation struct {
		ID          string  `json:"id"`
		UtilPct     float64 `json:"utilPct"`
		AvgQueue    float64 `json:"avgQueue"`
		MaxQueue    int     `json:"maxQueue"`
		Tasks       int     `json:"tasks"`
		ZoneAvgBots float64 `json:"zoneAvgBots"`
		ZoneMaxBots int     `json:"zoneMaxBots"`
		GwAvgBots   float64 `json:"gwAvgBots"`
		GwMaxBots   int     `json:"gwMaxBots"`
	}

	type Sample struct {
		BotCount          int             `json:"botCount"`
		NoCollision       AggResult       `json:"noCollision"`
		CAStar            AggResult       `json:"cooperativeAStar"`
		CycleTimePenalty  float64         `json:"cycleTimePenalty"`
		ThroughputPenalty float64         `json:"throughputPenalty"`
		StationCongestion []SampleStation `json:"stationCongestion,omitempty"`
	}

	var samples []Sample
	for _, bc := range botCounts {
		nc := agg(aggMap[fmt.Sprintf("%d:no-collision", bc)])
		ca := agg(aggMap[fmt.Sprintf("%d:%s", bc, algorithms[1])])
		cycPen := 1.0
		if nc.AvgCycleTimeS > 0 {
			cycPen = ca.AvgCycleTimeS / nc.AvgCycleTimeS
		}
		thrPen := 1.0
		if nc.ThroughputPerHour > 0 {
			thrPen = ca.ThroughputPerHour / nc.ThroughputPerHour
		}
		// Aggregate station metrics for this bot count
		var sampleStns []SampleStation
		caResults := aggMap[fmt.Sprintf("%d:ca-star", bc)]
		if len(caResults) > 0 && len(caResults[0].Stations) > 0 {
			nShifts := float64(len(caResults))
			for _, sm := range caResults[0].Stations {
				var utilSum, queueSum, zoneSum, gwSum float64
				maxQ, zoneMax, gwMax := 0, 0, 0
				totalTasks := 0
				for _, r := range caResults {
					for _, s := range r.Stations {
						if s.ID == sm.ID {
							utilSum += s.UtilPct
							queueSum += s.AvgQueue
							zoneSum += s.ZoneAvgBots
							gwSum += s.GwAvgBots
							if s.MaxQueue > maxQ { maxQ = s.MaxQueue }
							if s.ZoneMaxBots > zoneMax { zoneMax = s.ZoneMaxBots }
							if s.GwMaxBots > gwMax { gwMax = s.GwMaxBots }
							totalTasks += s.Tasks
						}
					}
				}
				sampleStns = append(sampleStns, SampleStation{
					ID: sm.ID, UtilPct: utilSum / nShifts,
					AvgQueue: queueSum / nShifts, MaxQueue: maxQ, Tasks: totalTasks,
					ZoneAvgBots: zoneSum / nShifts, ZoneMaxBots: zoneMax,
					GwAvgBots: gwSum / nShifts, GwMaxBots: gwMax,
				})
			}
		}

		samples = append(samples, Sample{
			BotCount: bc, NoCollision: nc, CAStar: ca,
			CycleTimePenalty: cycPen, ThroughputPenalty: thrPen,
			StationCongestion: sampleStns,
		})
	}

	// Print table
	fmt.Println("┌────────┬──────────────────────────────┬──────────────────────────────┬──────────────────┐")
	fmt.Println("│  Bots  │   No-Collision (free-flow)    │   CA* (strict blocking)       │    Penalties     │")
	fmt.Println("│        │  Cyc(s) Thr/hr Util%  Coll%   │  Cyc(s) Thr/hr Util%  Coll%   │  Cyc×    Thr×    │")
	fmt.Println("├────────┼──────────────────────────────┼──────────────────────────────┼──────────────────┤")
	for _, s := range samples {
		nc := s.NoCollision
		ca := s.CAStar
		fmt.Printf("│ %4d   │ %5.0f  %6.1f  %4.0f%%  %4.1f%%  │ %5.0f  %6.1f  %4.0f%%  %4.1f%%  │ %6.3f %6.3f  │\n",
			s.BotCount,
			nc.AvgCycleTimeS, nc.ThroughputPerHour, nc.AvgUtilization*100, nc.CollisionWaitPct*100,
			ca.AvgCycleTimeS, ca.ThroughputPerHour, ca.AvgUtilization*100, ca.CollisionWaitPct*100,
			s.CycleTimePenalty, s.ThroughputPenalty,
		)
	}
	fmt.Println("└────────┴──────────────────────────────┴──────────────────────────────┴──────────────────┘")
	fmt.Println()

	// Station congestion analysis (CA* results only)
	fmt.Println("Station Congestion Analysis (CA* runs, ground floor)")
	fmt.Println("┌────────┬────────────────────────────────────────────────────────────────────────────────────┐")
	fmt.Println("│  Bots  │  Station:  avg-util%  avg-queue  max-queue  tasks                                │")
	fmt.Println("├────────┼────────────────────────────────────────────────────────────────────────────────────┤")
	for _, bc := range botCounts {
		caResults := aggMap[fmt.Sprintf("%d:ca-star", bc)]
		if len(caResults) == 0 {
			continue
		}
		// Aggregate station metrics across shifts
		type aggStn struct {
			util float64; queue float64; maxQ int; tasks int
		}
		stnAgg := make(map[string]*aggStn)
		for _, r := range caResults {
			for _, sm := range r.Stations {
				a, ok := stnAgg[sm.ID]
				if !ok {
					a = &aggStn{}
					stnAgg[sm.ID] = a
				}
				a.util += sm.UtilPct
				a.queue += sm.AvgQueue
				if sm.MaxQueue > a.maxQ {
					a.maxQ = sm.MaxQueue
				}
				a.tasks += sm.Tasks
			}
		}
		n := float64(len(caResults))
		var line string
		// Collect station IDs in order
		var stnIDs []string
		if len(caResults) > 0 && len(caResults[0].Stations) > 0 {
			for _, sm := range caResults[0].Stations {
				stnIDs = append(stnIDs, sm.ID)
			}
		}
		for i, stn := range stnIDs {
			a := stnAgg[stn]
			if a == nil {
				continue
			}
			if i > 0 {
				line += "  "
			}
			// Short station name (e.g., op-4-0 → 4-0)
			short := strings.TrimPrefix(stn, "op-")
			line += fmt.Sprintf("%s:%3.0f%%/%.1fq/%dmax/%dt", short, a.util/n, a.queue/n, a.maxQ, a.tasks)
		}
		fmt.Printf("│ %4d   │  %-86s│\n", bc, line)
	}
	fmt.Println("└────────┴────────────────────────────────────────────────────────────────────────────────────┘")
	fmt.Println()

	// JSON
	output := struct {
		Metadata struct {
			Timestamp       string  `json:"timestamp"`
			MapPath         string  `json:"mapPath"`
			ShiftsPerSample int     `json:"shiftsPerSample"`
			PalletCount     int     `json:"palletCountPerShift"`
			TotalTimeS      float64 `json:"totalTimeS"`
			Workers         int     `json:"workers"`
		} `json:"metadata"`
		Samples []Sample `json:"samples"`
	}{}
	output.Metadata.Timestamp = time.Now().Format(time.RFC3339)
	output.Metadata.MapPath = *mapPath
	output.Metadata.ShiftsPerSample = *shifts
	output.Metadata.PalletCount = *pallets
	output.Metadata.TotalTimeS = time.Since(startTime).Seconds()
	output.Metadata.Workers = *workers
	output.Samples = samples

	jsonData, _ := json.MarshalIndent(output, "", "  ")
	os.WriteFile(*outPath, jsonData, 0644)
	fmt.Printf("JSON → %s\n", *outPath)

	if *csvPath != "" {
		var lines []string
		lines = append(lines, "bot_count,nc_cycle_s,nc_thr_hr,nc_util,nc_coll_pct,nc_tasks,ca_cycle_s,ca_thr_hr,ca_util,ca_coll_pct,ca_tasks,cycle_penalty,thr_penalty")
		for _, s := range samples {
			lines = append(lines, fmt.Sprintf("%d,%.2f,%.2f,%.4f,%.4f,%d,%.2f,%.2f,%.4f,%.4f,%d,%.4f,%.4f",
				s.BotCount,
				s.NoCollision.AvgCycleTimeS, s.NoCollision.ThroughputPerHour, s.NoCollision.AvgUtilization, s.NoCollision.CollisionWaitPct, s.NoCollision.TotalTasks,
				s.CAStar.AvgCycleTimeS, s.CAStar.ThroughputPerHour, s.CAStar.AvgUtilization, s.CAStar.CollisionWaitPct, s.CAStar.TotalTasks,
				s.CycleTimePenalty, s.ThroughputPenalty,
			))
		}
		os.WriteFile(*csvPath, []byte(strings.Join(lines, "\n")+"\n"), 0644)
		fmt.Printf("CSV → %s\n", *csvPath)
	}
}
