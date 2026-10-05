package tanksim

import (
	"strings"
	"testing"
)

func TestExactRationalFlow(t *testing.T) {
	sim := &Sim{
		Tanks: []*Tank{{Name: "a", Capacity: nil, Level: Rat(0, 1)}},
		Valves: []*Valve{
			{Name: "in", From: -1, To: 0, Rate: Rat(1, 3), Open: true},
		},
	}
	if err := sim.Run(3, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	if got := sim.Tanks[0].Level.RatString(); got != "1" {
		t.Fatalf("3 ticks of 1/3: got %s, want 1", got)
	}
	if err := sim.Run(4, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	if got := sim.Tanks[0].Level.RatString(); got != "7/3" {
		t.Fatalf("7 ticks of 1/3: got %s, want 7/3", got)
	}
}

func TestEmptyBoundaryClamp(t *testing.T) {
	sim := &Sim{
		Tanks: []*Tank{
			{Name: "a", Level: Rat(1, 1)},
			{Name: "b", Level: Rat(0, 1)},
		},
		Valves: []*Valve{
			{Name: "out", From: 0, To: 1, Rate: Rat(3, 1), Open: true},
		},
	}
	if err := sim.Tick(Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	if got := sim.Tanks[0].Level.RatString(); got != "0" {
		t.Fatalf("source drained below empty: got %s, want 0", got)
	}
	if got := sim.Tanks[1].Level.RatString(); got != "1" {
		t.Fatalf("downstream got unclamped flow: got %s, want 1", got)
	}
}

func TestFullBoundaryClamp(t *testing.T) {
	sim := &Sim{
		Tanks: []*Tank{
			{Name: "a", Level: Rat(100, 1)},
			{Name: "b", Capacity: Rat(10, 1), Level: Rat(19, 2)},
		},
		Valves: []*Valve{
			{Name: "fill", From: 0, To: 1, Rate: Rat(2, 1), Open: true},
		},
	}
	if err := sim.Tick(Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	if got := sim.Tanks[1].Level.RatString(); got != "10" {
		t.Fatalf("tank overfilled: got %s, want 10", got)
	}
	if got := sim.Tanks[0].Level.RatString(); got != "199/2" {
		t.Fatalf("source lost unclamped amount: got %s, want 199/2", got)
	}
}

// TestSameTickSettleThenSwitch proves every trigger is evaluated against
// the same pre-switch state: T2 keys on V1 being open, and must still fire
// even though T1 closes V1 in the same round.
func TestSameTickSettleThenSwitch(t *testing.T) {
	sim := &Sim{
		Tanks: []*Tank{{Name: "a", Level: Rat(9, 2)}},
		Valves: []*Valve{
			{Name: "v1", From: -1, To: 0, Rate: Rat(1, 1), Open: true},
			{Name: "v2", From: 0, To: -1, Rate: Rat(1, 2), Open: true},
		},
		Triggers: []*Trigger{
			{Name: "t1", Cond: Condition{Tank: 0, Op: Ge, Value: Rat(5, 1), Valve: -1}, Valve: 0, SetOpen: false},
			{Name: "t2", Cond: Condition{Tank: -1, Valve: 0, ValveOpen: true}, Valve: 1, SetOpen: false},
		},
	}
	if err := sim.Tick(Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	// Level is now exactly 5, so t1 fires. t2 was evaluated against the
	// pre-switch state where v1 was still open, so it fires too.
	if sim.Valves[0].Open {
		t.Fatal("t1 did not close v1")
	}
	if sim.Valves[1].Open {
		t.Fatal("t2 was not settled against the pre-switch state: v2 still open")
	}
}

func TestZeroTimeLoopEvidence(t *testing.T) {
	sim := &Sim{
		Tanks:  []*Tank{{Name: "a", Level: Rat(6, 1)}},
		Valves: []*Valve{{Name: "v1", From: -1, To: 0, Rate: Rat(1, 1), Open: true}},
		Triggers: []*Trigger{
			// Contradictory triggers on the same condition oscillate forever.
			{Name: "close-high", Cond: Condition{Tank: 0, Op: Ge, Value: Rat(5, 1), Valve: -1}, Valve: 0, SetOpen: false},
			{Name: "open-high", Cond: Condition{Tank: 0, Op: Ge, Value: Rat(5, 1), Valve: -1}, Valve: 0, SetOpen: true},
		},
	}
	err := sim.Tick(Rat(1, 1))
	if err == nil {
		t.Fatal("expected zero-time loop, got nil error")
	}
	loop, ok := err.(*ZeroTimeLoopError)
	if !ok {
		t.Fatalf("error is %T, want *ZeroTimeLoopError", loop)
	}
	if loop.Tick != 1 {
		t.Fatalf("loop reported at tick %d, want 1", loop.Tick)
	}
	// The valve oscillates open -> closed -> open, so each round fires
	// exactly one trigger and the state from round 0 repeats at round 2.
	if len(loop.Steps) != 2 {
		t.Fatalf("evidence has %d steps, want 2", len(loop.Steps))
	}
	if loop.CycleStart != 0 {
		t.Fatalf("cycle starts at round %d, want 0", loop.CycleStart)
	}
	if f := loop.Steps[0].Fired; len(f) != 1 || f[0] != "close-high" {
		t.Fatalf("round 0 fired %v, want [close-high]", f)
	}
	if f := loop.Steps[1].Fired; len(f) != 1 || f[0] != "open-high" {
		t.Fatalf("round 1 fired %v, want [open-high]", f)
	}
	msg := loop.Error()
	if !strings.Contains(msg, "zero-time loop") || !strings.Contains(msg, "close-high") {
		t.Fatalf("evidence message missing details:\n%s", msg)
	}
	t.Logf("evidence:\n%s", msg)
}

// triggeredSystem fills tank 0 at net rate 3/4 per unit time (inflow 1,
// xfer out 1/4) until level >= 3, then the inflow valve closes.
func triggeredSystem() *Sim {
	return &Sim{
		Tanks: []*Tank{
			{Name: "a", Capacity: Rat(20, 1), Level: Rat(0, 1)},
			{Name: "b", Level: Rat(0, 1)},
		},
		Valves: []*Valve{
			{Name: "in", From: -1, To: 0, Rate: Rat(1, 1), Open: true},
			{Name: "xfer", From: 0, To: 1, Rate: Rat(1, 4), Open: true},
		},
		Triggers: []*Trigger{
			{Name: "stop", Cond: Condition{Tank: 0, Op: Ge, Value: Rat(3, 1), Valve: -1}, Valve: 0, SetOpen: false},
		},
	}
}

func levelsOf(sim *Sim) []string {
	out := make([]string, len(sim.Tanks))
	for i, tk := range sim.Tanks {
		out[i] = tk.Level.RatString()
	}
	return out
}

func TestSnapshotReplay(t *testing.T) {
	sim := triggeredSystem()
	if err := sim.Run(6, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	snap := sim.Snapshot()
	if err := sim.Run(4, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	want := levelsOf(sim)

	if err := sim.Restore(snap); err != nil {
		t.Fatal(err)
	}
	if sim.TickCount != 6 {
		t.Fatalf("tick count after restore = %d, want 6", sim.TickCount)
	}
	if err := sim.Run(4, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	got := levelsOf(sim)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("replay diverged at tank %d: got %s, want %s", i, got[i], want[i])
		}
	}
}

func TestSnapshotJSONReplay(t *testing.T) {
	sim := triggeredSystem()
	if err := sim.Run(6, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	data, err := sim.SnapshotJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := sim.Run(4, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	want := levelsOf(sim)

	// Restore into a freshly built system from JSON only.
	fresh := triggeredSystem()
	if err := fresh.RestoreJSON(data); err != nil {
		t.Fatal(err)
	}
	if err := fresh.Run(4, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	got := levelsOf(fresh)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("JSON replay diverged at tank %d: got %s, want %s", i, got[i], want[i])
		}
	}
}

// TestMicroStepConsistency runs the same total time with dt and dt/2.
// With exact rationals and threshold events landing on both grids, the
// final levels must be identical fractions.
func TestMicroStepConsistency(t *testing.T) {
	coarse := triggeredSystem()
	if err := coarse.Run(12, Rat(1, 2)); err != nil {
		t.Fatal(err)
	}
	fine := triggeredSystem()
	if err := fine.Run(24, Rat(1, 4)); err != nil {
		t.Fatal(err)
	}
	c, f := levelsOf(coarse), levelsOf(fine)
	for i := range c {
		if c[i] != f[i] {
			t.Fatalf("micro-step mismatch at tank %d: dt=1/2 gives %s, dt=1/4 gives %s", i, c[i], f[i])
		}
	}
	// Threshold 3 is hit exactly on both grids (8 coarse / 16 fine ticks);
	// afterwards tank 0 only drains at 1/4 per unit time for 2 more units
	// of time, leaving exactly 5/2.
	if c[0] != "5/2" {
		t.Fatalf("tank 0 level = %s, want exactly 5/2", c[0])
	}
}

// TestMicroStepNoTriggers checks pure flow: any step size yields identical
// exact results for the same total time.
func TestMicroStepNoTriggers(t *testing.T) {
	build := func() *Sim {
		return &Sim{
			Tanks: []*Tank{
				{Name: "a", Level: Rat(10, 1)},
				{Name: "b", Capacity: Rat(8, 1), Level: Rat(0, 1)},
			},
			Valves: []*Valve{
				{Name: "xfer", From: 0, To: 1, Rate: Rat(1, 3), Open: true},
			},
		}
	}
	a := build()
	if err := a.Run(6, Rat(1, 1)); err != nil {
		t.Fatal(err)
	}
	b := build()
	if err := b.Run(12, Rat(1, 2)); err != nil {
		t.Fatal(err)
	}
	c := build()
	if err := c.Run(18, Rat(1, 3)); err != nil {
		t.Fatal(err)
	}
	la, lb, lc := levelsOf(a), levelsOf(b), levelsOf(c)
	for i := range la {
		if la[i] != lb[i] || la[i] != lc[i] {
			t.Fatalf("tank %d diverged across step sizes: %s vs %s vs %s", i, la[i], lb[i], lc[i])
		}
	}
}
