package main

import (
	"container/heap"
	"math"
	"sort"
)

// ─── Cooperative A* with replan-on-conflict ───
//
// Normal operation: bots use Dijkstra paths. Strict blocking — no phasing through.
// On conflict: when a bot is blocked for N ticks, it replans using space-time A*
// against the reservation table built from all other bots' current planned paths.
// This avoids full replanning every tick while still resolving deadlocks.

// ─── Adjacency index for fast neighbor lookup ───

type AdjIndex struct {
	neighbors map[string][]AdjNeighbor // nodeID -> neighbors
}

type AdjNeighbor struct {
	NodeID string
	Edge   *RawEdge
}

func BuildAdjIndex(raw *RawGraph) *AdjIndex {
	idx := &AdjIndex{neighbors: make(map[string][]AdjNeighbor, len(raw.Nodes))}
	for i := range raw.Edges {
		e := &raw.Edges[i]
		idx.neighbors[e.A] = append(idx.neighbors[e.A], AdjNeighbor{e.B, e})
		idx.neighbors[e.B] = append(idx.neighbors[e.B], AdjNeighbor{e.A, e})
	}
	return idx
}

// ─── Reservation table ───

type ReservationTable struct {
	reserved map[uint64]int // packed key -> botID
}

func NewReservationTable() *ReservationTable {
	return &ReservationTable{reserved: make(map[uint64]int, 1024)}
}

// Fast hash key: use string hash + tick
func packKey(nodeID string, tick int) uint64 {
	// FNV-1a hash of nodeID combined with tick
	var h uint64 = 14695981039346656037
	for i := 0; i < len(nodeID); i++ {
		h ^= uint64(nodeID[i])
		h *= 1099511628211
	}
	h ^= uint64(tick) * 2654435761
	return h
}

func (rt *ReservationTable) Reserve(nodeID string, tick int, botID int) {
	rt.reserved[packKey(nodeID, tick)] = botID
}

func (rt *ReservationTable) IsReserved(nodeID string, tick int, excludeBotID int) bool {
	if occupant, ok := rt.reserved[packKey(nodeID, tick)]; ok {
		return occupant != excludeBotID
	}
	return false
}

func (rt *ReservationTable) Clear() {
	clear(rt.reserved)
}

// ─── Build reservation table from all bots' current paths ───

func buildReservationTable(bots []*Bot, currentTick int) *ReservationTable {
	rt := NewReservationTable()

	for _, b := range bots {
		if len(b.Path) == 0 {
			// Stationary bot — reserve current position for a window
			for t := currentTick; t < currentTick+200; t++ {
				rt.Reserve(b.CurrentNodeID, t, b.ID)
			}
			continue
		}

		// Reserve the bot's planned path through time
		tick := currentTick
		for i := b.PathIndex; i < len(b.Path); i++ {
			rt.Reserve(b.Path[i], tick, b.ID)
			// Estimate ticks to next node (use 1 as minimum)
			if i < len(b.Path)-1 {
				tick++ // simplified: 1 tick per hop for reservation purposes
			}
		}
		// Reserve destination for a buffer window (bot will be there a while)
		dest := b.Path[len(b.Path)-1]
		for t := tick; t < tick+50; t++ {
			rt.Reserve(dest, t, b.ID)
		}
	}

	return rt
}

// ─── Space-time A* planner ───

type stKey struct {
	nodeID string
	tick   int
}

type stItem struct {
	node stKey
	cost float64
	est  float64 // cost + heuristic
	seq  int
}

type stPQ []stItem

func (h stPQ) Len() int { return len(h) }
func (h stPQ) Less(i, j int) bool {
	if h[i].est != h[j].est {
		return h[i].est < h[j].est
	}
	return h[i].seq < h[j].seq
}
func (h stPQ) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *stPQ) Push(x any)   { *h = append(*h, x.(stItem)) }
func (h *stPQ) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[:n-1]
	return item
}

// PlanCAStarPath replans a single bot's path using space-time A*,
// avoiding reserved (node, tick) pairs from other bots' planned paths.
//
// Returns the physical path (node IDs) or nil if no path found.
// The path includes wait-at-node steps as repeated node IDs.
func PlanCAStarPath(
	g *DirectedGraph,
	adj *AdjIndex,
	nodeIndex map[string]*RawNode,
	sourceID string,
	targetID string,
	startTick int,
	botID int,
	rt *ReservationTable,
	cfg SimConfig,
	heurCache map[string]map[string]float64,
) []string {
	if sourceID == targetID {
		return []string{sourceID}
	}

	// Compute or retrieve cached heuristic
	heurCosts, ok := heurCache[targetID]
	if !ok {
		heurCosts = DijkstraSingleSource(g, targetID)
		heurCache[targetID] = heurCosts
	}
	heuristic := func(nodeID string) float64 {
		if c, ok := heurCosts[nodeID]; ok {
			return c
		}
		return 1000.0
	}

	dist := make(map[stKey]float64, 4096)
	prev := make(map[stKey]stKey)
	hasPrev := make(map[stKey]bool)

	start := stKey{sourceID, startTick}
	dist[start] = 0

	pq := &stPQ{}
	heap.Init(pq)
	heap.Push(pq, stItem{node: start, cost: 0, est: heuristic(sourceID), seq: 0})
	seq := 1

	maxHorizon := startTick + 150 // search window: 150 ticks ahead
	visited := make(map[stKey]bool, 4096)

	for pq.Len() > 0 {
		item := heap.Pop(pq).(stItem)
		cur := item.node

		if visited[cur] {
			continue
		}
		visited[cur] = true

		if cur.nodeID == targetID {
			// Reconstruct physical path
			var stPath []stKey
			c := cur
			for {
				stPath = append([]stKey{c}, stPath...)
				if !hasPrev[c] {
					break
				}
				c = prev[c]
			}
			// Deduplicate consecutive same nodes (waits become implicit)
			path := make([]string, 0, len(stPath))
			for _, st := range stPath {
				if len(path) == 0 || path[len(path)-1] != st.nodeID {
					path = append(path, st.nodeID)
				}
			}
			return path
		}

		if cur.tick >= maxHorizon {
			continue
		}

		curCost := dist[cur]

		// Option 1: Wait at current node
		waitKey := stKey{cur.nodeID, cur.tick + 1}
		if !rt.IsReserved(cur.nodeID, cur.tick+1, botID) && !visited[waitKey] {
			waitCost := curCost + 1.0
			if old, ok := dist[waitKey]; !ok || waitCost < old {
				dist[waitKey] = waitCost
				prev[waitKey] = cur
				hasPrev[waitKey] = true
				heap.Push(pq, stItem{
					node: waitKey, cost: waitCost,
					est: waitCost + heuristic(cur.nodeID), seq: seq,
				})
				seq++
			}
		}

		// Option 2: Move to neighbors
		for _, nb := range adj.neighbors[cur.nodeID] {
			ticks := edgeTravelTicksFromEdge(nb.Edge, nodeIndex, cur.nodeID, nb.NodeID, cfg)
			arrivalTick := cur.tick + ticks

			if arrivalTick > maxHorizon {
				continue
			}

			// Check reservation at arrival
			if rt.IsReserved(nb.NodeID, arrivalTick, botID) {
				continue
			}

			// Check intermediate ticks at current node
			blocked := false
			for t := cur.tick + 1; t < arrivalTick; t++ {
				if rt.IsReserved(cur.nodeID, t, botID) {
					blocked = true
					break
				}
			}
			if blocked {
				continue
			}

			nextKey := stKey{nb.NodeID, arrivalTick}
			moveCost := curCost + float64(ticks)
			if old, ok := dist[nextKey]; !ok || moveCost < old {
				dist[nextKey] = moveCost
				prev[nextKey] = cur
				hasPrev[nextKey] = true
				heap.Push(pq, stItem{
					node: nextKey, cost: moveCost,
					est: moveCost + heuristic(nb.NodeID), seq: seq,
				})
				seq++
			}
		}
	}

	// Fallback: regular Dijkstra ignoring reservations
	result := Dijkstra(g, sourceID, targetID)
	if result != nil {
		return result.Path
	}
	return nil
}

// edgeTravelTicksFromEdge computes travel ticks directly from an edge struct
func edgeTravelTicksFromEdge(e *RawEdge, nodeIndex map[string]*RawNode, fromID, toID string, cfg SimConfig) int {
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

// ─── Cooperative A* planner (plans ALL bots each tick) ───

// CooperativePathPlan plans conflict-free paths for every traveling bot.
// Higher-priority bots plan first and reserve their space-time path;
// lower-priority bots must route around those reservations.
//
// Returns map[botID] -> path (with wait entries for holds).
func CooperativePathPlan(
	bots []*Bot,
	g *DirectedGraph,
	adj *AdjIndex,
	nodeIndex map[string]*RawNode,
	raw *RawGraph,
	currentTick int,
	cfg SimConfig,
	heurCache map[string]map[string]float64,
	getTarget func(*Bot) string,
) map[int][]string {
	rt := NewReservationTable()
	plans := make(map[int][]string)

	// Priority sort: bots with tasks first, then by ID
	sorted := make([]*Bot, len(bots))
	copy(sorted, bots)
	sort.Slice(sorted, func(i, j int) bool {
		ai, aj := 1, 1
		if sorted[i].Task != nil {
			ai = 0
		}
		if sorted[j].Task != nil {
			aj = 0
		}
		if ai != aj {
			return ai < aj
		}
		return sorted[i].ID < sorted[j].ID
	})

	// Reserve every bot's current position for a buffer period.
	// Stationary bots (no target): full horizon — they won't move.
	// Traveling bots: short buffer — they haven't been planned yet so
	// assume stationary until planned.  Each bot's OWN search ignores
	// its own reservations via excludeBotID, so this doesn't block self.
	for _, b := range sorted {
		horizon := 10 // traveling bots: 10-tick buffer
		if getTarget(b) == "" {
			horizon = 200 // stationary bots: full horizon
		}
		for t := currentTick; t <= currentTick+horizon; t++ {
			rt.Reserve(b.CurrentNodeID, t, b.ID)
		}
	}

	// Plan each traveling bot in priority order.
	for _, b := range sorted {
		target := getTarget(b)
		if target == "" {
			continue
		}

		path := PlanCAStarPath(
			g, adj, nodeIndex,
			b.CurrentNodeID, target, currentTick, b.ID,
			rt, cfg, heurCache,
		)
		if path == nil || len(path) <= 1 {
			continue
		}

		plans[b.ID] = path

		// Reserve every (node, tick) along the planned path so lower-priority
		// bots must plan around it.
		reserveCoopPath(rt, path, currentTick, b.ID, raw, nodeIndex, cfg)
	}

	return plans
}

// reserveCoopPath walks a planned path (which may include same-node waits)
// and reserves (node, tick) entries with accurate edge timing.
func reserveCoopPath(
	rt *ReservationTable,
	path []string,
	startTick int,
	botID int,
	raw *RawGraph,
	nodeIndex map[string]*RawNode,
	cfg SimConfig,
) {
	tick := startTick
	for i, nodeID := range path {
		if i > 0 {
			prev := path[i-1]
			if nodeID == prev {
				// Wait: 1 tick at same node
				tick++
			} else {
				// Real edge: reserve intermediate ticks at destination
				ticks := edgeTravelTicks(raw, nodeIndex, prev, nodeID, cfg)
				for t := tick + 1; t <= tick+ticks; t++ {
					rt.Reserve(nodeID, t, botID)
				}
				tick += ticks
			}
		}
		rt.Reserve(nodeID, tick, botID)
	}

	// Reserve destination for a buffer window (picking/placing time).
	if len(path) > 0 {
		dest := path[len(path)-1]
		for t := tick + 1; t <= tick+50; t++ {
			rt.Reserve(dest, t, botID)
		}
	}
}
