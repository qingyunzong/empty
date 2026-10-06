package crashreplay

import "fmt"

// Verdict is the outcome of checking a trace.
type Verdict int

const (
	// OK means every expectation held in every enumerated recovery.
	OK Verdict = iota
	// Counterexample means some enumerated recovery violates an expectation.
	Counterexample
	// Unknown means a crash exceeded the enumeration budget.
	Unknown
)

// CounterexampleInfo describes the first violating recovery found.
type CounterexampleInfo struct {
	CrashIndex  int
	Expectation Expectation
	Persisted   []Write
	Dropped     []Write
	State       map[string]string
	Actual      map[string]string
}

// CrashReport summarises one crash/recover cycle.
type CrashReport struct {
	Index        int
	Pending      []Write
	PreCrashDisk map[string]string
	States       int // number of enumerated recoveries, 0 when unknown
	Unknown      bool
	Actual       map[string]string
}

// Result is the outcome of Check.
type Result struct {
	Verdict        Verdict
	Counterexample *CounterexampleInfo
	Crashes        []CrashReport
	Err            error
}

// Check replays events against a store, and at every crash verifies the
// expectations against all enumerated recoveries. The first counterexample
// (in crash order, then subset order, then expectation order) is returned
// together with the actual recovery produced by the out-of-order publish
// implementation. A crash with more than MaxEnumeratedWrites unsynced
// writes yields Unknown unless a later crash produces a counterexample.
func Check(events []Event, seed int64) Result {
	store := NewStore(seed)
	res := Result{Verdict: OK}
	var expects []Expectation
	crashed := false
	crashIndex := 0

	finishCrash := func() bool {
		pending := store.Pending()
		disk := store.Disk()
		recs, ok := PossibleRecoveries(disk, pending)
		actual := store.Crash()
		report := CrashReport{Index: crashIndex, Pending: pending, PreCrashDisk: disk, Actual: actual, Unknown: !ok}
		if ok {
			report.States = len(recs)
		}
		res.Crashes = append(res.Crashes, report)
		crashIndex++
		crashed = false

		if !ok {
			expects = nil
			res.Verdict = Unknown
			return false
		}
		for _, rec := range recs {
			for _, exp := range expects {
				if !exp.Holds(rec.State) {
					res.Verdict = Counterexample
					res.Counterexample = &CounterexampleInfo{
						CrashIndex:  report.Index,
						Expectation: exp,
						Persisted:   rec.Persisted,
						Dropped:     difference(pending, rec.Persisted),
						State:       rec.State,
						Actual:      actual,
					}
					return true
				}
			}
		}
		expects = nil
		return false
	}

	for _, ev := range events {
		switch ev.Kind {
		case EvWrite:
			if crashed {
				res.Err = fmt.Errorf("write before recover after crash #%d", crashIndex)
				return res
			}
			store.WriteOp(ev.Key, ev.Value)
		case EvSync:
			if crashed {
				res.Err = fmt.Errorf("sync before recover after crash #%d", crashIndex)
				return res
			}
			store.Sync()
		case EvCrash:
			if crashed {
				res.Err = fmt.Errorf("crash #%d without intervening recover", crashIndex+1)
				return res
			}
			crashed = true
		case EvExpect:
			if !crashed {
				res.Err = fmt.Errorf("expect without preceding crash")
				return res
			}
			expects = append(expects, ev.Expect)
		case EvRecover:
			if !crashed {
				res.Err = fmt.Errorf("recover without preceding crash")
				return res
			}
			if finishCrash() {
				return res
			}
		}
	}
	if crashed {
		finishCrash()
	}
	return res
}

// difference returns the writes in all that are not in kept, matched by Seq.
func difference(all, kept []Write) []Write {
	inKept := make(map[int]bool, len(kept))
	for _, w := range kept {
		inKept[w.Seq] = true
	}
	var out []Write
	for _, w := range all {
		if !inKept[w.Seq] {
			out = append(out, w)
		}
	}
	return out
}
