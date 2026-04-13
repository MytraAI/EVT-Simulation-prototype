package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Quick diagnostic: run 1 bot for 5000 steps and trace what happens
func runDiagnostic(mapPath string) {
	raw, err := loadRawGraph(mapPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load: %v\n", err)
		return
	}

	costs := CostParams{
		XYCostPerM:    1.0 / defaultSimConfig.BotSpeedMps,
		ZUpCostPerM:   1.0 / defaultSimConfig.ZUpSpeedMps,
		ZDownCostPerM: 1.0 / defaultSimConfig.ZDownSpeedMps,
		XYTurnCost:    defaultSimConfig.XYTurnTimeS,
		XYZTurnCost:   defaultSimConfig.XYZTransitionTimeS,
	}
	g := buildDirectedGraphFromRaw(raw, costs)

	cfg := defaultSimConfig
	cfg.BotCount = 2
	cfg.Algorithm = "ca-star"
	cfg.ShiftPalletCount = 400

	// Use seed 2000 (same as 2-bot shift 0) to reproduce the deadlock
	state := newSimState(raw, g, cfg, 2000)

	fmt.Printf("Stations: %d  Positions: %d  Aisles: %d\n",
		len(state.stationOps), len(state.palletPositions), len(state.aisles))
	fmt.Printf("Bot 0 starts at: %s\n", state.Bots[0].CurrentNodeID)

	// Check path from bot start to first station
	for i, sid := range state.stationOps {
		result := Dijkstra(g, state.Bots[0].CurrentNodeID, sid)
		if result != nil {
			fmt.Printf("  Station %d (%s): cost=%.1f, path len=%d\n", i, sid, result.TotalCost, len(result.Path))
		} else {
			fmt.Printf("  Station %d (%s): NO PATH!\n", i, sid)
		}
		if i >= 3 {
			break
		}
	}

	// Check path from first station to a few positions
	if len(state.stationOps) > 0 {
		sid := state.stationOps[0]
		reachable := 0
		unreachable := 0
		var totalCost float64
		for _, pid := range state.palletPositions {
			result := Dijkstra(g, sid, pid)
			if result != nil {
				reachable++
				totalCost += result.TotalCost
			} else {
				unreachable++
			}
		}
		if reachable > 0 {
			fmt.Printf("From station %s: %d reachable (avg cost=%.1f), %d unreachable\n",
				sid, reachable, totalCost/float64(reachable), unreachable)
		}
	}

	// Run 500 steps and trace
	taskGenAttempts := 0
	taskGenSuccess := 0
	pathFailures := 0

	for step := 0; step < 500 && !state.ShiftDone; step++ {
		prevGenerated := state.ShiftTasksGenerated
		stepSimulation(state, cfg)
		if state.ShiftTasksGenerated > prevGenerated {
			taskGenSuccess += state.ShiftTasksGenerated - prevGenerated
		}
		taskGenAttempts++

		// Trace every 50 steps
		if step%50 == 0 || step < 20 {
			fmt.Printf("Step %d: tasks=%d completed=%d generated=%d/%d pallets=%d\n",
				state.Step, len(state.Tasks), len(state.CompletedTasks),
				state.ShiftTasksGenerated, cfg.ShiftPalletCount, len(state.Pallets))
			for _, b := range state.Bots {
				stateStr := []string{"IDLE", "TRAVEL_PICKUP", "EDGE_WAIT", "PICKING", "TRAVEL_DROP", "EDGE_WAIT_DROP", "PLACING"}[b.State]
				taskInfo := "none"
				if b.Task != nil {
					taskType := "IND"
					if b.Task.Type == TaskRetrieval {
						taskType = "RET"
					}
					taskInfo = fmt.Sprintf("%s pos=%s stn=%s", taskType, b.Task.PositionNodeID, b.Task.StationNodeID)
				}
				fmt.Printf("  Bot %d: %s at %s path=%d/%d task=[%s] idle=%d busy=%d coll=%d done=%d\n",
					b.ID, stateStr, b.CurrentNodeID, b.PathIndex, len(b.Path),
					taskInfo, b.TotalIdleSteps, b.TotalBusySteps, b.TotalCollisionWaits, b.TasksCompleted)
			}
		}
	}

	fmt.Printf("\nFinal: %d completed, %d active, %d generated, step=%d\n",
		len(state.CompletedTasks), len(state.Tasks), state.ShiftTasksGenerated, state.Step)
	fmt.Printf("Task gen: %d attempts, %d success\n", taskGenAttempts, taskGenSuccess)
	fmt.Printf("Path failures: %d\n", pathFailures)

	// Print completed task cycle times
	if len(state.CompletedTasks) > 0 {
		fmt.Println("\nCompleted tasks:")
		for _, t := range state.CompletedTasks {
			ttype := "IND"
			if t.Type == TaskRetrieval {
				ttype = "RET"
			}
			fmt.Printf("  Task %d (%s): created=%d completed=%d cycle=%ds stn=%s pos=%s\n",
				t.ID, ttype, t.CreatedAtStep, t.CompletedAtStep,
				t.CompletedAtStep-t.CreatedAtStep, t.StationNodeID, t.PositionNodeID)
		}
	}

	// Dump station/position info
	fmt.Println("\nStation nodes:")
	for _, sid := range state.stationOps {
		n := state.nodeIndex[sid]
		fmt.Printf("  %s: level=%d pos=(%.2f, %.2f, %.2f)\n",
			n.ID, n.Level, n.Position.XM, n.Position.YM, n.Position.ZM)
	}

	_ = json.Marshal // avoid unused import
}
