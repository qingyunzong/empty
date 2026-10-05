package main

// scenarios holds the built-in scenarios.
var scenarios = map[string]Scenario{
	// 5 events: crash needs db+cache, both need cfg; one decoy event.
	// Minimum failing subsequence: [load-cfg init-db init-cache crash] (4).
	"small": {
		Name:   "small",
		Target: "crash",
		Events: []Event{
			{ID: "load-cfg", Writes: []string{"cfg"}},
			{ID: "init-db", Reads: []string{"cfg"}, Writes: []string{"db"}},
			{ID: "init-cache", Reads: []string{"cfg"}, Writes: []string{"cache"}},
			{ID: "decoy", Reads: []string{"cfg"}, Writes: []string{"tmp"}},
			{ID: "crash", Reads: []string{"db", "cache"}},
		},
	},
	// 6 events: two independent writers of "db"; the shorter chain wins.
	// Minimum failing subsequence: [quick-db crash] (2).
	"fork": {
		Name:   "fork",
		Target: "crash",
		Events: []Event{
			{ID: "load-cfg", Writes: []string{"cfg"}},
			{ID: "slow-db", Reads: []string{"cfg"}, Writes: []string{"db"}},
			{ID: "quick-db", Writes: []string{"db"}},
			{ID: "noise-a", Writes: []string{"x"}},
			{ID: "noise-b", Reads: []string{"x"}, Writes: []string{"y"}},
			{ID: "crash", Reads: []string{"db"}},
		},
	},
	// 20 events (exactly the cap): a 4-event prerequisite chain at the
	// tail, 16 decoys in front. Minimum failing subsequence has size 4.
	"chain20": {
		Name:   "chain20",
		Target: "crash",
		Events: func() []Event {
			evs := []Event{}
			for _, id := range []string{
				"d00", "d01", "d02", "d03", "d04", "d05", "d06", "d07",
				"d08", "d09", "d10", "d11", "d12", "d13", "d14", "d15",
			} {
				evs = append(evs, Event{ID: id, Writes: []string{"junk-" + id}})
			}
			evs = append(evs,
				Event{ID: "step1", Writes: []string{"r0"}},
				Event{ID: "step2", Reads: []string{"r0"}, Writes: []string{"r1"}},
				Event{ID: "step3", Reads: []string{"r1"}, Writes: []string{"r2"}},
				Event{ID: "crash", Reads: []string{"r2"}},
			)
			return evs
		}(),
	},
	// 4 events: target's prerequisite can never be satisfied -> no failure.
	"impossible": {
		Name:   "impossible",
		Target: "crash",
		Events: []Event{
			{ID: "a", Writes: []string{"p"}},
			{ID: "b", Reads: []string{"p"}, Writes: []string{"q"}},
			{ID: "c", Reads: []string{"q"}},
			{ID: "crash", Reads: []string{"never-written"}},
		},
	},
}
