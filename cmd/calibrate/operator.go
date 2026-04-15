// Operator modeling for station-level contention.
//
// Each STATION_OP node can have N operators assigned. When a bot arrives
// at a station it enters a FIFO queue. An idle operator picks the next
// bot and processes it through three phases:
//
//   Identify (OpIdentifyTimeS) → Handle (OpHandleTimeS) → Confirm (OpConfirmTimeS)
//
// When OperatorsPerStation == 0 the system is bypassed and the legacy
// flat-delay model is used.

package main

// ─── Operator state machine ───

type OperatorState int

const (
	OpIdle       OperatorState = iota
	OpIdentifying              // looking at screen / label
	OpHandling                 // physical pick or place
	OpConfirming               // confirming completion
)

type Operator struct {
	ID             int
	State          OperatorState
	StationID      string
	CurrentBotID   int // -1 when idle
	StepsRemaining int

	// Utilization counters (ticks).
	TotalIdleTicks     int
	TotalIdentifyTicks int
	TotalHandleTicks   int
	TotalConfirmTicks  int
	TasksCompleted     int
}

// ─── Station operator pool ───

type StationOperators struct {
	Operators     map[string][]*Operator // stationID → operators
	BotQueues     map[string][]int       // stationID → FIFO of waiting bot IDs
	BotHandleTimes map[int]int           // botID → handle time ticks for this service

	// Queue tracking for metrics.
	TotalQueueDepthTicks int // sum of queue depths each tick (all stations)
	MaxQueueDepth        int // peak queue depth seen at any single station
	TotalBotWaitTicks    int // total ticks bots spent in BotWaitingForOperator
	BotsServiced         int // total bots that completed operator service
}

func newStationOperators(stationOps []string, perStation int, cfg SimConfig) *StationOperators {
	ops := make(map[string][]*Operator, len(stationOps))
	queues := make(map[string][]int, len(stationOps))
	id := 0
	for _, stn := range stationOps {
		stnOps := make([]*Operator, perStation)
		for i := 0; i < perStation; i++ {
			stnOps[i] = &Operator{
				ID:           id,
				State:        OpIdle,
				StationID:    stn,
				CurrentBotID: -1,
			}
			id++
		}
		ops[stn] = stnOps
		queues[stn] = nil
	}
	return &StationOperators{
		Operators:      ops,
		BotQueues:      queues,
		BotHandleTimes: make(map[int]int),
	}
}

// EnqueueBot adds a bot to the waiting queue at a station.
// handleTimeTicks is the handle phase duration for this bot (variable for casepick).
// If an operator is immediately available, it begins service and returns true.
func (so *StationOperators) EnqueueBot(stationID string, botID int, handleTimeTicks int, cfg SimConfig) bool {
	so.BotHandleTimes[botID] = handleTimeTicks
	// Try to find an idle operator at this station.
	for _, op := range so.Operators[stationID] {
		if op.State == OpIdle {
			op.State = OpIdentifying
			op.CurrentBotID = botID
			op.StepsRemaining = cfg.OpIdentifyTimeS
			return true
		}
	}
	// No operator free — enqueue.
	so.BotQueues[stationID] = append(so.BotQueues[stationID], botID)
	return false
}

// stepOperators advances all operators by one tick.
// Returns the set of bot IDs whose operator service completed this tick.
func (so *StationOperators) stepOperators(bots []*Bot, cfg SimConfig) map[int]bool {
	completed := make(map[int]bool)

	for stationID, ops := range so.Operators {
		for _, op := range ops {
			switch op.State {
			case OpIdle:
				op.TotalIdleTicks++

			case OpIdentifying:
				op.TotalIdentifyTicks++
				op.StepsRemaining--
				if op.StepsRemaining <= 0 {
					op.State = OpHandling
					if ht, ok := so.BotHandleTimes[op.CurrentBotID]; ok {
						op.StepsRemaining = ht
					} else {
						op.StepsRemaining = cfg.OpHandleTimeS
					}
				}

			case OpHandling:
				op.TotalHandleTicks++
				op.StepsRemaining--
				if op.StepsRemaining <= 0 {
					op.State = OpConfirming
					op.StepsRemaining = cfg.OpConfirmTimeS
				}

			case OpConfirming:
				op.TotalConfirmTicks++
				op.StepsRemaining--
				if op.StepsRemaining <= 0 {
					// Service complete.
					completed[op.CurrentBotID] = true
					op.TasksCompleted++
					so.BotsServiced++
					delete(so.BotHandleTimes, op.CurrentBotID)
					op.CurrentBotID = -1
					op.State = OpIdle

					// Immediately pick up next queued bot if any.
					if q := so.BotQueues[stationID]; len(q) > 0 {
						nextBot := q[0]
						so.BotQueues[stationID] = q[1:]
						op.State = OpIdentifying
						op.CurrentBotID = nextBot
						op.StepsRemaining = cfg.OpIdentifyTimeS
					}
				}
			}
		}

		// Track queue depth this tick.
		qLen := len(so.BotQueues[stationID])
		so.TotalQueueDepthTicks += qLen
		if qLen > so.MaxQueueDepth {
			so.MaxQueueDepth = qLen
		}
	}

	// Count wait ticks for all bots currently in the queue.
	for _, q := range so.BotQueues {
		so.TotalBotWaitTicks += len(q)
	}

	return completed
}

// ─── Metrics ───

type OperatorMetrics struct {
	OperatorsPerStation int     `json:"operatorsPerStation"`
	TotalOperators      int     `json:"totalOperators"`
	AvgUtilPct          float64 `json:"avgOperatorUtilPct"`
	AvgQueueDepth       float64 `json:"avgOperatorQueueDepth"`
	MaxQueueDepth       int     `json:"maxOperatorQueueDepth"`
	AvgWaitTicks        float64 `json:"avgBotWaitForOperatorTicks"`
}

func (so *StationOperators) computeMetrics(totalSteps int, perStation int) OperatorMetrics {
	var totalOps int
	var utilSum float64
	for _, ops := range so.Operators {
		for _, op := range ops {
			totalOps++
			total := op.TotalIdleTicks + op.TotalIdentifyTicks + op.TotalHandleTicks + op.TotalConfirmTicks
			if total > 0 {
				busy := op.TotalIdentifyTicks + op.TotalHandleTicks + op.TotalConfirmTicks
				utilSum += float64(busy) / float64(total)
			}
		}
	}

	avgUtil := 0.0
	if totalOps > 0 {
		avgUtil = utilSum / float64(totalOps) * 100
	}

	avgQueue := 0.0
	if totalSteps > 0 {
		avgQueue = float64(so.TotalQueueDepthTicks) / float64(totalSteps)
	}

	avgWait := 0.0
	if so.BotsServiced > 0 {
		avgWait = float64(so.TotalBotWaitTicks) / float64(so.BotsServiced)
	}

	return OperatorMetrics{
		OperatorsPerStation: perStation,
		TotalOperators:      totalOps,
		AvgUtilPct:          avgUtil,
		AvgQueueDepth:       avgQueue,
		MaxQueueDepth:       so.MaxQueueDepth,
		AvgWaitTicks:        avgWait,
	}
}
