package tanksim

import (
	"encoding/json"
	"math/big"
	"testing"
)

func switchScenario() ([]Tank, []Valve, []Trigger) {
	return []Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
		[]Valve{
			{ID: "in", From: "", To: "A", Rate: Rat(1, 1), Open: true},
			{ID: "out", From: "A", To: "", Rate: Rat(2, 1), Open: false},
		},
		[]Trigger{
			{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActClose, ActValve: "in"},
			{ID: "T2", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActOpen, ActValve: "out"},
		}
}

func eventsEqual(a, b []Event) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Time.Cmp(b[i].Time) != 0 || a[i].Iter != b[i].Iter {
			return false
		}
		if len(a[i].Fired) != len(b[i].Fired) {
			return false
		}
		for k := range a[i].Fired {
			if a[i].Fired[k] != b[i].Fired[k] {
				return false
			}
		}
		if len(a[i].Levels) != len(b[i].Levels) || len(a[i].Valves) != len(b[i].Valves) {
			return false
		}
		for k, v := range a[i].Levels {
			w, ok := b[i].Levels[k]
			if !ok || v.Cmp(w) != 0 {
				return false
			}
		}
		for k, v := range a[i].Valves {
			w, ok := b[i].Valves[k]
			if !ok || v != w {
				return false
			}
		}
	}
	return true
}

// Snapshot -> JSON -> Restore -> continue must reproduce the reference run
// exactly: same events, same final levels, same time.
func TestSnapshotReplay(t *testing.T) {
	for _, snapAt := range []string{"2/1", "5/1"} { // before and after the t=4 event
		t.Run("snap_at_"+snapAt, func(t *testing.T) {
			tanks, valves, triggers := switchScenario()
			orig := mustSim(t, tanks, valves, triggers)
			snapTime, ok := new(big.Rat).SetString(snapAt)
			if !ok {
				t.Fatal("bad snap time")
			}
			if err := orig.Run(snapTime); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(orig.Snapshot())
			if err != nil {
				t.Fatalf("marshal snapshot: %v", err)
			}
			var snap Snapshot
			if err := json.Unmarshal(data, &snap); err != nil {
				t.Fatalf("unmarshal snapshot: %v", err)
			}
			restored, err := Restore(&snap)
			if err != nil {
				t.Fatalf("Restore: %v", err)
			}
			if err := restored.Run(Rat(10, 1)); err != nil {
				t.Fatal(err)
			}

			tanks2, valves2, triggers2 := switchScenario()
			ref := mustSim(t, tanks2, valves2, triggers2)
			if err := ref.Run(Rat(10, 1)); err != nil {
				t.Fatal(err)
			}

			if !eventsEqual(restored.Events(), ref.Events()) {
				t.Fatalf("event logs differ:\nrestored: %+v\nreference: %+v", restored.Events(), ref.Events())
			}
			if got, want := restored.Level("A"), ref.Level("A"); got.Cmp(want) != 0 {
				t.Fatalf("level = %s, want %s", got.RatString(), want.RatString())
			}
			if got, want := restored.Time(), ref.Time(); got.Cmp(want) != 0 {
				t.Fatalf("time = %s, want %s", got.RatString(), want.RatString())
			}
			if restored.ValveOpen("in") != ref.ValveOpen("in") || restored.ValveOpen("out") != ref.ValveOpen("out") {
				t.Fatal("valve states differ after replay")
			}
		})
	}
}

// Micro-stepping with a small rational dt must converge to the event-driven
// result: the threshold is crossed at t=15/7 (off the step grid), so the
// fixed-step run switches slightly late, but stays within a dt-sized bound.
func TestMicroSteppingMatchesEventDriven(t *testing.T) {
	build := func() *Sim {
		return mustSim(t,
			[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
			[]Valve{
				{ID: "in", From: "", To: "A", Rate: Rat(7, 5), Open: true},
				{ID: "out", From: "A", To: "", Rate: Rat(2, 1), Open: false},
			},
			[]Trigger{
				{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(3, 1), Act: ActClose, ActValve: "in"},
				{ID: "T2", Cond: CondRising, Tank: "A", Threshold: Rat(3, 1), Act: ActOpen, ActValve: "out"},
			})
	}

	eventDriven := build()
	if err := eventDriven.Run(Rat(3, 1)); err != nil {
		t.Fatal(err)
	}
	// Exact reference: fills to 3 at t=15/7, then drains at rate 2:
	// level(3) = 3 - 2*(3 - 15/7) = 9/7.
	checkLevel(t, eventDriven, "A", Rat(9, 7))

	micro := build()
	dt := Rat(1, 1000)
	for i := 0; i < 3000; i++ {
		if err := micro.Step(dt); err != nil {
			t.Fatal(err)
		}
	}
	if got := micro.Time(); got.Cmp(Rat(3, 1)) != 0 {
		t.Fatalf("micro time = %s, want 3", got.RatString())
	}
	diff := new(big.Rat).Sub(micro.Level("A"), Rat(9, 7))
	if diff.Sign() < 0 {
		diff.Neg(diff)
	}
	if diff.Cmp(Rat(1, 100)) > 0 {
		t.Fatalf("micro-step level differs from event-driven by %s, exceeds tolerance 1/100", diff.RatString())
	}
	if micro.ValveOpen("in") != eventDriven.ValveOpen("in") || micro.ValveOpen("out") != eventDriven.ValveOpen("out") {
		t.Fatal("final valve states differ between micro-stepping and event-driven runs")
	}
}
