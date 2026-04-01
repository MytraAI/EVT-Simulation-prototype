// WASM entry point for EVT warehouse pathfinding.
//
//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

var currentGraph *DirectedGraph

// loadGraph parses the map JSON and builds the directed graph.
// Called from JS: wasmLoadGraph(jsonString, costParamsJSON)
func loadGraph(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("loadGraph requires 2 args: graphJSON, costParamsJSON")
	}

	graphJSON := args[0].String()
	costJSON := args[1].String()

	// Parse graph data
	var raw struct {
		Nodes []struct {
			ID               string  `json:"id"`
			Kind             string  `json:"kind"`
			Level            int     `json:"level"`
			Position         struct {
				XM float64 `json:"x_m"`
				YM float64 `json:"y_m"`
				ZM float64 `json:"z_m"`
			} `json:"position"`
			MaxPalletHeightM float64 `json:"max_pallet_height_m"`
			MaxPalletMassKg  float64 `json:"max_pallet_mass_kg"`
			SizeXM           float64 `json:"size_x_m"`
			SizeYM           float64 `json:"size_y_m"`
		} `json:"nodes"`
		Edges []struct {
			ID               string  `json:"id"`
			A                string  `json:"a"`
			B                string  `json:"b"`
			Axis             string  `json:"axis"`
			DistanceM        float64 `json:"distance_m"`
			MaxPalletHeightM float64 `json:"max_pallet_height_m"`
		} `json:"edges"`
	}
	if err := json.Unmarshal([]byte(graphJSON), &raw); err != nil {
		return jsError("parse graph: " + err.Error())
	}

	// Parse cost params
	costs := DefaultCostParams()
	if costJSON != "" {
		var cp struct {
			XYCostPerM    float64 `json:"xyCostPerM"`
			ZUpCostPerM   float64 `json:"zUpCostPerM"`
			ZDownCostPerM float64 `json:"zDownCostPerM"`
			XYTurnCost    float64 `json:"xyTurnCost"`
			XYZTurnCost   float64 `json:"xyzTurnCost"`
		}
		if err := json.Unmarshal([]byte(costJSON), &cp); err == nil {
			if cp.XYCostPerM > 0 {
				costs.XYCostPerM = cp.XYCostPerM
			}
			if cp.ZUpCostPerM > 0 {
				costs.ZUpCostPerM = cp.ZUpCostPerM
			}
			if cp.ZDownCostPerM > 0 {
				costs.ZDownCostPerM = cp.ZDownCostPerM
			}
			if cp.XYTurnCost > 0 {
				costs.XYTurnCost = cp.XYTurnCost
			}
			if cp.XYZTurnCost > 0 {
				costs.XYZTurnCost = cp.XYZTurnCost
			}
		}
	}

	// Convert to internal types
	nodes := make([]PhysicalNode, len(raw.Nodes))
	for i, n := range raw.Nodes {
		nodes[i] = PhysicalNode{
			ID:               n.ID,
			Kind:             n.Kind,
			Level:            n.Level,
			XM:               n.Position.XM,
			YM:               n.Position.YM,
			ZM:               n.Position.ZM,
			MaxPalletHeightM: n.MaxPalletHeightM,
			MaxPalletMassKg:  n.MaxPalletMassKg,
			SizeXM:           n.SizeXM,
			SizeYM:           n.SizeYM,
		}
	}
	edges := make([]PhysicalEdge, len(raw.Edges))
	for i, e := range raw.Edges {
		edges[i] = PhysicalEdge{
			ID:               e.ID,
			A:                e.A,
			B:                e.B,
			Axis:             e.Axis,
			DistanceM:        e.DistanceM,
			MaxPalletHeightM: e.MaxPalletHeightM,
		}
	}

	currentGraph = BuildDirectedGraph(nodes, edges, costs)

	return js.ValueOf(map[string]any{
		"ok":    true,
		"nodes": len(nodes),
		"edges": len(edges),
	})
}

// findPath runs Dijkstra from source to target.
// Called from JS: wasmFindPath(sourceID, targetID) → {totalCost, path}
func findPath(_ js.Value, args []js.Value) any {
	if currentGraph == nil {
		return jsError("graph not loaded")
	}
	if len(args) < 2 {
		return jsError("findPath requires 2 args: sourceID, targetID")
	}

	sourceID := args[0].String()
	targetID := args[1].String()

	result := Dijkstra(currentGraph, sourceID, targetID)
	if result == nil {
		return js.ValueOf(map[string]any{
			"ok":    false,
			"error": "no path found",
		})
	}

	pathArr := make([]any, len(result.Path))
	for i, p := range result.Path {
		pathArr[i] = p
	}

	return js.ValueOf(map[string]any{
		"ok":        true,
		"totalCost": result.TotalCost,
		"path":      pathArr,
	})
}

// singleSource runs single-source Dijkstra.
// Called from JS: wasmSingleSource(sourceID) → {nodeID: cost, ...}
func singleSource(_ js.Value, args []js.Value) any {
	if currentGraph == nil {
		return jsError("graph not loaded")
	}
	if len(args) < 1 {
		return jsError("singleSource requires 1 arg: sourceID")
	}

	sourceID := args[0].String()
	costs := DijkstraSingleSource(currentGraph, sourceID)

	result := make(map[string]any, len(costs))
	for k, v := range costs {
		result[k] = v
	}
	return js.ValueOf(result)
}

func jsError(msg string) js.Value {
	return js.ValueOf(map[string]any{"ok": false, "error": msg})
}

func main() {
	js.Global().Set("wasmLoadGraph", js.FuncOf(loadGraph))
	js.Global().Set("wasmFindPath", js.FuncOf(findPath))
	js.Global().Set("wasmSingleSource", js.FuncOf(singleSource))

	// Block forever
	select {}
}
