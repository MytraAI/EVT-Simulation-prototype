package main

import (
	"container/heap"
	"math"
)

// PathResult is returned by Dijkstra.
type PathResult struct {
	TotalCost float64  `json:"totalCost"`
	Path      []string `json:"path"`
}

// Dijkstra finds the shortest path from source to target in the directed graph.
// Returns nil if no path exists.
func Dijkstra(g *DirectedGraph, sourceID, targetID string) *PathResult {
	dist := make(map[DirNode]float64)
	prev := make(map[DirNode]DirNode)
	hasPrev := make(map[DirNode]bool)

	// Priority queue
	pq := &pqHeap{}
	heap.Init(pq)
	counter := 0

	// Seed source: virtual start node with axis=""
	startNode := DirNode{sourceID, ""}
	dist[startNode] = 0

	// Add directed nodes for each axis the source has
	if axes, ok := g.nodeAxes[sourceID]; ok {
		for axis := range axes {
			dn := DirNode{sourceID, axis}
			dist[dn] = 0
			prev[dn] = startNode
			hasPrev[dn] = true
			heap.Push(pq, pqItem{cost: 0, counter: counter, node: dn})
			counter++
		}
	} else {
		// Source has no axes, push start node itself
		heap.Push(pq, pqItem{cost: 0, counter: counter, node: startNode})
		counter++
	}

	// Collect target directed nodes
	targetDirNodes := make(map[DirNode]bool)
	if axes, ok := g.nodeAxes[targetID]; ok {
		for axis := range axes {
			targetDirNodes[DirNode{targetID, axis}] = true
		}
	}

	var bestTarget DirNode
	bestCost := math.Inf(1)
	found := false

	for pq.Len() > 0 {
		item := heap.Pop(pq).(pqItem)
		node := item.node
		cost := item.cost

		// Stale entry
		if d, ok := dist[node]; ok && cost > d {
			continue
		}

		// Check if we reached target
		if targetDirNodes[node] {
			if cost < bestCost {
				bestCost = cost
				bestTarget = node
				found = true
			}
			break // Dijkstra guarantees this is optimal
		}

		// Expand neighbors
		for _, edge := range g.adj[node] {
			newCost := cost + edge.Cost
			if oldDist, ok := dist[edge.To]; !ok || newCost < oldDist {
				dist[edge.To] = newCost
				prev[edge.To] = node
				hasPrev[edge.To] = true
				heap.Push(pq, pqItem{cost: newCost, counter: counter, node: edge.To})
				counter++
			}
		}
	}

	if !found {
		return nil
	}

	// Reconstruct path
	var dirPath []DirNode
	cur := bestTarget
	for {
		dirPath = append(dirPath, cur)
		if !hasPrev[cur] {
			break
		}
		cur = prev[cur]
	}

	// Reverse
	for i, j := 0, len(dirPath)-1; i < j; i, j = i+1, j-1 {
		dirPath[i], dirPath[j] = dirPath[j], dirPath[i]
	}

	// Deduplicate consecutive physical node IDs
	path := make([]string, 0, len(dirPath))
	for _, dn := range dirPath {
		if len(path) == 0 || path[len(path)-1] != dn.NodeID {
			path = append(path, dn.NodeID)
		}
	}

	return &PathResult{TotalCost: bestCost, Path: path}
}

// DijkstraSingleSource computes shortest distance from source to all reachable nodes.
func DijkstraSingleSource(g *DirectedGraph, sourceID string) map[string]float64 {
	dist := make(map[DirNode]float64)
	pq := &pqHeap{}
	heap.Init(pq)
	counter := 0

	// Seed source
	if axes, ok := g.nodeAxes[sourceID]; ok {
		for axis := range axes {
			dn := DirNode{sourceID, axis}
			dist[dn] = 0
			heap.Push(pq, pqItem{cost: 0, counter: counter, node: dn})
			counter++
		}
	}

	for pq.Len() > 0 {
		item := heap.Pop(pq).(pqItem)
		node := item.node
		cost := item.cost

		if d, ok := dist[node]; ok && cost > d {
			continue
		}

		for _, edge := range g.adj[node] {
			newCost := cost + edge.Cost
			if oldDist, ok := dist[edge.To]; !ok || newCost < oldDist {
				dist[edge.To] = newCost
				heap.Push(pq, pqItem{cost: newCost, counter: counter, node: edge.To})
				counter++
			}
		}
	}

	// Collapse to physical node IDs, taking minimum across axis variants
	result := make(map[string]float64)
	for dn, cost := range dist {
		if existing, ok := result[dn.NodeID]; !ok || cost < existing {
			result[dn.NodeID] = cost
		}
	}
	return result
}

// --- Priority queue implementation ---

type pqItem struct {
	cost    float64
	counter int
	node    DirNode
}

type pqHeap []pqItem

func (h pqHeap) Len() int { return len(h) }
func (h pqHeap) Less(i, j int) bool {
	if h[i].cost != h[j].cost {
		return h[i].cost < h[j].cost
	}
	return h[i].counter < h[j].counter
}
func (h pqHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *pqHeap) Push(x any)   { *h = append(*h, x.(pqItem)) }
func (h *pqHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[:n-1]
	return item
}
