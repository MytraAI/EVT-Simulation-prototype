// Schedule replay mode: loads a CP-SAT wave schedule (JSON) and replays it
// tick-by-tick with stochastic operator service times.
//
// Usage:
//   ./calibrate --schedule schedule.json --map graph.json [--shifts 5] [--op-service-min 40] [--op-service-max 52]

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"time"
)

// ─── Schedule types ───

type ScheduleStep struct {
	BotID    int    `json:"bot_id"`
	CellID   string `json:"cell_id"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Duration int    `json:"duration"`
}

type BotConfig struct {
	XY    string `json:"xy"`
	OP    string `json:"op"`
	PEZ   string `json:"pez"`
	Type  string `json:"type"`
	Spawn string `json:"spawn"`
}

type Schedule struct {
	Side        string         `json:"side"`
	Bots        int            `json:"bots"`
	Waves       int            `json:"waves"`
	WaveOffsetS int            `json:"wave_offset_s"`
	MakespanS   int            `json:"makespan_s"`
	PPH         float64        `json:"pph"`
	Steps       []ScheduleStep `json:"steps"`
	BotConfigs  []BotConfig    `json:"bot_configs"`
}

func loadSchedule(path string) (*Schedule, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sched Schedule
	if err := json.Unmarshal(data, &sched); err != nil {
		return nil, err
	}
	return &sched, nil
}

// ─── Schedule replay simulation ───

type SchedBot struct {
	ID             int
	WaveID         int
	ConfigIndex    int    // index into BotConfigs
	State          string // "pending", "traveling", "at_op", "waiting_op", "departing", "done"
	CurrentCell    string
	Steps          []ScheduleStep // template steps for this bot
	StepIndex      int
	TicksRemaining int
	WaveStartTick  int // tick when this bot's wave was released
	ServiceTime    int // actual (stochastic) operator service time
	// Timing
	EnteredAt    int
	CompletedAt  int
	ActualCycle  int
	ServiceDelta int // actual_service - planned_service
}

type SchedSimState struct {
	Tick           int
	Bots           []*SchedBot
	CompletedBots  int
	TotalWaves     int
	NextWaveID     int
	WaveOffset     int
	PlannedService int
	// Operator tracking per station
	OpBusy    map[string]bool // stationOP -> is operator busy
	OpQueue   map[string][]*SchedBot
	OpBusySum map[string]int
	// Metrics
	CycleTimesSum int
	CycleTimesN   int
	MaxQueueDepth int
}

type SchedResult struct {
	Shifts            int     `json:"shifts"`
	BotsPerWave       int     `json:"botsPerWave"`
	TotalWaves        int     `json:"totalWaves"`
	WaveOffsetS       int     `json:"waveOffsetS"`
	ProjectedPPH      float64 `json:"projectedPPH"`
	ActualPPH         float64 `json:"actualPPH"`
	AvgCycleTimeS     float64 `json:"avgCycleTimeS"`
	AvgServiceDelta   float64 `json:"avgServiceDeltaS"`
	MaxQueueDepth     int     `json:"maxQueueDepth"`
	CompletedPallets  int     `json:"completedPallets"`
	TotalSteps        int     `json:"totalSteps"`
}

func runScheduleReplay(
	sched *Schedule,
	raw *RawGraph,
	numWaves int,
	serviceMin int,
	serviceMax int,
	seed int64,
) SchedResult {
	rng := rand.New(rand.NewSource(seed))

	state := &SchedSimState{
		WaveOffset:     sched.WaveOffsetS,
		PlannedService: 0,
		TotalWaves:     numWaves,
		OpBusy:         make(map[string]bool),
		OpQueue:        make(map[string][]*SchedBot),
		OpBusySum:      make(map[string]int),
	}

	// Find the planned service time from the schedule (duration at the OP cell)
	for _, step := range sched.Steps {
		for _, bc := range sched.BotConfigs {
			if step.CellID == bc.OP {
				state.PlannedService = step.Duration
				break
			}
		}
		if state.PlannedService > 0 {
			break
		}
	}

	// Group template steps by bot_id
	botSteps := make(map[int][]ScheduleStep)
	for _, s := range sched.Steps {
		botSteps[s.BotID] = append(botSteps[s.BotID], s)
	}

	// Pre-create all bots across all waves
	var allBots []*SchedBot
	botID := 0
	for w := 0; w < numWaves; w++ {
		for ci := 0; ci < sched.Bots; ci++ {
			svc := serviceMin
			if serviceMax > serviceMin {
				svc = serviceMin + rng.Intn(serviceMax-serviceMin+1)
			}
			steps := make([]ScheduleStep, len(botSteps[ci]))
			copy(steps, botSteps[ci])

			allBots = append(allBots, &SchedBot{
				ID:            botID,
				WaveID:        w,
				ConfigIndex:   ci,
				State:         "pending",
				Steps:         steps,
				StepIndex:     0,
				WaveStartTick: w * sched.WaveOffsetS,
				ServiceTime:   svc,
			})
			botID++
		}
	}
	state.Bots = allBots

	// Initialize operator state for each station
	for _, bc := range sched.BotConfigs {
		state.OpBusy[bc.OP] = false
		state.OpQueue[bc.OP] = nil
		state.OpBusySum[bc.OP] = 0
	}

	maxTicks := numWaves * sched.WaveOffsetS + sched.MakespanS*2

	// ─── Tick loop ───
	for state.Tick = 0; state.Tick < maxTicks; state.Tick++ {
		if state.CompletedBots >= len(allBots) {
			break
		}

		for _, b := range state.Bots {
			switch b.State {
			case "pending":
				// Release when wave start tick reached
				if state.Tick >= b.WaveStartTick {
					b.State = "traveling"
					b.StepIndex = 0
					b.CurrentCell = b.Steps[0].CellID
					b.EnteredAt = state.Tick
					// Compute adjusted ticks for first step
					templateStart := b.Steps[0].Start
					b.TicksRemaining = b.Steps[0].Duration
					_ = templateStart
				}

			case "traveling":
				b.TicksRemaining--
				if b.TicksRemaining <= 0 {
					b.StepIndex++
					if b.StepIndex >= len(b.Steps) {
						// All steps done
						b.State = "done"
						b.CompletedAt = state.Tick
						b.ActualCycle = b.CompletedAt - b.EnteredAt
						state.CompletedBots++
						state.CycleTimesSum += b.ActualCycle
						state.CycleTimesN++
						continue
					}
					step := b.Steps[b.StepIndex]
					b.CurrentCell = step.CellID

					// Check if this is the OP cell (operator service)
					bc := sched.BotConfigs[b.ConfigIndex]
					if step.CellID == bc.OP {
						// Arrive at operator station — request service
						b.State = "waiting_op"
						b.ServiceDelta = b.ServiceTime - state.PlannedService
						// Try to get operator
						if !state.OpBusy[bc.OP] {
							state.OpBusy[bc.OP] = true
							b.State = "at_op"
							b.TicksRemaining = b.ServiceTime
						} else {
							state.OpQueue[bc.OP] = append(state.OpQueue[bc.OP], b)
							qLen := len(state.OpQueue[bc.OP])
							if qLen > state.MaxQueueDepth {
								state.MaxQueueDepth = qLen
							}
						}
					} else {
						// Normal travel step — use template duration
						// Adjust for any service time delta accumulated
						b.TicksRemaining = step.Duration
					}
				}

			case "waiting_op":
				// Handled by operator release below

			case "at_op":
				bc := sched.BotConfigs[b.ConfigIndex]
				state.OpBusySum[bc.OP]++
				b.TicksRemaining--
				if b.TicksRemaining <= 0 {
					// Service complete — release operator
					state.OpBusy[bc.OP] = false

					// Assign next in queue
					q := state.OpQueue[bc.OP]
					if len(q) > 0 {
						next := q[0]
						state.OpQueue[bc.OP] = q[1:]
						state.OpBusy[bc.OP] = true
						next.State = "at_op"
						next.TicksRemaining = next.ServiceTime
					}

					// Move bot to next step (departure)
					b.StepIndex++
					if b.StepIndex >= len(b.Steps) {
						b.State = "done"
						b.CompletedAt = state.Tick
						b.ActualCycle = b.CompletedAt - b.EnteredAt
						state.CompletedBots++
						state.CycleTimesSum += b.ActualCycle
						state.CycleTimesN++
					} else {
						b.State = "departing"
						b.CurrentCell = b.Steps[b.StepIndex].CellID
						b.TicksRemaining = b.Steps[b.StepIndex].Duration
					}
				}

			case "departing":
				b.TicksRemaining--
				if b.TicksRemaining <= 0 {
					b.StepIndex++
					if b.StepIndex >= len(b.Steps) {
						b.State = "done"
						b.CompletedAt = state.Tick
						b.ActualCycle = b.CompletedAt - b.EnteredAt
						state.CompletedBots++
						state.CycleTimesSum += b.ActualCycle
						state.CycleTimesN++
					} else {
						b.CurrentCell = b.Steps[b.StepIndex].CellID
						b.TicksRemaining = b.Steps[b.StepIndex].Duration
					}
				}
			}
		}
	}

	avgCycle := 0.0
	avgDelta := 0.0
	if state.CycleTimesN > 0 {
		avgCycle = float64(state.CycleTimesSum) / float64(state.CycleTimesN)
	}
	// Compute avg service delta
	var deltaSum int
	for _, b := range state.Bots {
		if b.State == "done" {
			deltaSum += b.ServiceDelta
		}
	}
	if state.CompletedBots > 0 {
		avgDelta = float64(deltaSum) / float64(state.CompletedBots)
	}

	actualPPH := 0.0
	if state.Tick > 0 {
		actualPPH = float64(state.CompletedBots) / (float64(state.Tick) / 3600.0)
	}

	return SchedResult{
		Shifts:           1,
		BotsPerWave:      sched.Bots,
		TotalWaves:       numWaves,
		WaveOffsetS:      sched.WaveOffsetS,
		ProjectedPPH:     sched.PPH,
		ActualPPH:        actualPPH,
		AvgCycleTimeS:    avgCycle,
		AvgServiceDelta:  avgDelta,
		MaxQueueDepth:    state.MaxQueueDepth,
		CompletedPallets: state.CompletedBots,
		TotalSteps:       state.Tick,
	}
}

// ─── Runner ───

func runScheduleMode(schedulePath, mapPath string, numWaves, shifts, serviceMin, serviceMax int) {
	sched, err := loadSchedule(schedulePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load schedule: %v\n", err)
		os.Exit(1)
	}

	raw, err := loadRawGraph(mapPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load graph: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("=== CP-SAT Schedule Replay ===")
	fmt.Printf("Schedule:   %s (%s side, %d bots/wave)\n", schedulePath, sched.Side, sched.Bots)
	fmt.Printf("Map:        %s\n", mapPath)
	fmt.Printf("Waves:      %d per shift\n", numWaves)
	fmt.Printf("Shifts:     %d\n", shifts)
	fmt.Printf("Wave offset: %ds\n", sched.WaveOffsetS)
	fmt.Printf("Projected:  %.0f PPH\n", sched.PPH)
	fmt.Printf("Op service: U(%d, %d)s\n", serviceMin, serviceMax)
	fmt.Println()

	// Bot configs
	fmt.Println("Bot assignments:")
	for i, bc := range sched.BotConfigs {
		fmt.Printf("  Bot %d: %s → %s → %s (%s)\n", i, bc.Spawn, bc.XY, bc.OP, bc.Type)
	}
	fmt.Println()

	// Template timeline
	fmt.Println("Template schedule (wave 0):")
	for i, bc := range sched.BotConfigs {
		fmt.Printf("  Bot %d:", i)
		for _, s := range sched.Steps {
			if s.BotID == i {
				fmt.Printf(" [%s t=%d-%d]", s.CellID, s.Start, s.End)
			}
		}
		_ = bc
		fmt.Println()
	}
	fmt.Println()

	startTime := time.Now()
	var results []SchedResult
	for s := 0; s < shifts; s++ {
		seed := int64(s*1000 + 42)
		r := runScheduleReplay(sched, raw, numWaves, serviceMin, serviceMax, seed)
		r.Shifts = s + 1
		results = append(results, r)
	}

	fmt.Printf("Completed in %.1fs\n\n", time.Since(startTime).Seconds())

	// Results table
	fmt.Println("┌───────┬──────────┬──────────┬──────────┬───────────┬───────┬───────┐")
	fmt.Println("│ Shift │ Proj PPH │ Act PPH  │ Avg Cyc  │ Svc Delta │ MaxQ  │ Done  │")
	fmt.Println("├───────┼──────────┼──────────┼──────────┼───────────┼───────┼───────┤")
	var totalActPPH, totalCyc, totalDelta float64
	var totalMaxQ, totalDone int
	for _, r := range results {
		fmt.Printf("│  %3d  │ %6.0f   │ %6.0f   │ %6.1fs  │  %+5.1fs   │  %3d  │ %4d  │\n",
			r.Shifts, r.ProjectedPPH, r.ActualPPH, r.AvgCycleTimeS,
			r.AvgServiceDelta, r.MaxQueueDepth, r.CompletedPallets)
		totalActPPH += r.ActualPPH
		totalCyc += r.AvgCycleTimeS
		totalDelta += r.AvgServiceDelta
		if r.MaxQueueDepth > totalMaxQ {
			totalMaxQ = r.MaxQueueDepth
		}
		totalDone += r.CompletedPallets
	}
	fmt.Println("├───────┼──────────┼──────────┼──────────┼───────────┼───────┼───────┤")
	n := float64(len(results))
	fmt.Printf("│  AVG  │ %6.0f   │ %6.0f   │ %6.1fs  │  %+5.1fs   │  %3d  │ %4d  │\n",
		sched.PPH, totalActPPH/n, totalCyc/n, totalDelta/n, totalMaxQ, totalDone/len(results))
	fmt.Println("└───────┴──────────┴──────────┴──────────┴───────────┴───────┴───────┘")

	// JSON output
	output := struct {
		Schedule  string        `json:"schedule"`
		Side      string        `json:"side"`
		BotsWave  int           `json:"botsPerWave"`
		Results   []SchedResult `json:"results"`
	}{
		Schedule: schedulePath,
		Side:     sched.Side,
		BotsWave: sched.Bots,
		Results:  results,
	}
	jsonData, _ := json.MarshalIndent(output, "", "  ")
	os.WriteFile("schedule-replay-results.json", jsonData, 0644)
	fmt.Println("\nJSON → schedule-replay-results.json")

	_ = math.Max
}
