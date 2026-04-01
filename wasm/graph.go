package main

// PhysicalNode represents a node in the warehouse graph.
type PhysicalNode struct {
	ID                string
	Kind              string
	Level             int
	XM, YM, ZM       float64
	MaxPalletHeightM  float64
	MaxPalletMassKg   float64
	SizeXM, SizeYM    float64
}

// PhysicalEdge represents an edge in the warehouse graph.
type PhysicalEdge struct {
	ID               string
	A, B             string
	Axis             string // "x", "y", "z"
	DistanceM        float64
	MaxPalletHeightM float64
}

// CostParams holds direction-dependent travel costs.
type CostParams struct {
	XYCostPerM   float64
	ZUpCostPerM  float64
	ZDownCostPerM float64
	XYTurnCost   float64
	XYZTurnCost  float64
}

func DefaultCostParams() CostParams {
	return CostParams{
		XYCostPerM:    1.0,
		ZUpCostPerM:   3.0,
		ZDownCostPerM: 2.0,
		XYTurnCost:    2.0,
		XYZTurnCost:   3.0,
	}
}

// DirNode is a node in the directed graph: (nodeID, axis).
// axis="" means the virtual start node.
type DirNode struct {
	NodeID string
	Axis   string // "", "x", "y", "z"
}

// DirectedEdge is an edge in the directed graph.
type DirectedEdge struct {
	To   DirNode
	Cost float64
}

// DirectedGraph is the directed graph used for Dijkstra pathfinding.
type DirectedGraph struct {
	nodes     map[string]*PhysicalNode
	adj       map[DirNode][]DirectedEdge
	nodeAxes  map[string]map[string]bool // nodeID -> set of axes
	edgeMaxHt map[[2]string]float64      // (a,b) -> max pallet height
}

// BuildDirectedGraph constructs the directed graph from physical nodes/edges.
func BuildDirectedGraph(nodes []PhysicalNode, edges []PhysicalEdge, costs CostParams) *DirectedGraph {
	g := &DirectedGraph{
		nodes:     make(map[string]*PhysicalNode, len(nodes)),
		adj:       make(map[DirNode][]DirectedEdge),
		nodeAxes:  make(map[string]map[string]bool),
		edgeMaxHt: make(map[[2]string]float64),
	}

	// Pass 1: index nodes
	for i := range nodes {
		g.nodes[nodes[i].ID] = &nodes[i]
	}

	// Pass 2: collect axes per node and edge constraints
	for _, e := range edges {
		if g.nodeAxes[e.A] == nil {
			g.nodeAxes[e.A] = make(map[string]bool)
		}
		if g.nodeAxes[e.B] == nil {
			g.nodeAxes[e.B] = make(map[string]bool)
		}
		g.nodeAxes[e.A][e.Axis] = true
		g.nodeAxes[e.B][e.Axis] = true
		if e.MaxPalletHeightM > 0 {
			g.edgeMaxHt[[2]string{e.A, e.B}] = e.MaxPalletHeightM
			g.edgeMaxHt[[2]string{e.B, e.A}] = e.MaxPalletHeightM
		}
	}

	// Pass 3: traverse edges (movement along physical edges)
	for _, e := range edges {
		nodeA := g.nodes[e.A]
		nodeB := g.nodes[e.B]
		if nodeA == nil || nodeB == nil {
			continue
		}

		// Forward: A -> B
		fwdCost := edgeCost(nodeA, nodeB, e.Axis, e.DistanceM, costs)
		from := DirNode{e.A, e.Axis}
		to := DirNode{e.B, e.Axis}
		g.adj[from] = append(g.adj[from], DirectedEdge{to, fwdCost})

		// Reverse: B -> A
		revCost := edgeCost(nodeB, nodeA, e.Axis, e.DistanceM, costs)
		g.adj[to] = append(g.adj[to], DirectedEdge{from, revCost})
	}

	// Pass 4: turn edges (axis changes at same node)
	for nodeID, axes := range g.nodeAxes {
		axisList := make([]string, 0, len(axes))
		for a := range axes {
			axisList = append(axisList, a)
		}
		for i := 0; i < len(axisList); i++ {
			for j := i + 1; j < len(axisList); j++ {
				tc := turnCost(axisList[i], axisList[j], costs)
				from := DirNode{nodeID, axisList[i]}
				to := DirNode{nodeID, axisList[j]}
				g.adj[from] = append(g.adj[from], DirectedEdge{to, tc})
				g.adj[to] = append(g.adj[to], DirectedEdge{from, tc})
			}
		}
	}

	return g
}

func edgeCost(from, to *PhysicalNode, axis string, distM float64, costs CostParams) float64 {
	if axis == "z" {
		dz := to.ZM - from.ZM
		if dz > 0 {
			return distM * costs.ZUpCostPerM
		}
		return distM * costs.ZDownCostPerM
	}
	return distM * costs.XYCostPerM
}

func turnCost(fromAxis, toAxis string, costs CostParams) float64 {
	if fromAxis == toAxis {
		return 0
	}
	// Both xy
	if (fromAxis == "x" || fromAxis == "y") && (toAxis == "x" || toAxis == "y") {
		return costs.XYTurnCost
	}
	return costs.XYZTurnCost
}
