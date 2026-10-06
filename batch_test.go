package occupancy

import (
	"reflect"
	"testing"
)

func batchPlan(t *testing.T) (*Planner, BatchMove, BatchMove) {
	t.Helper()
	p := New()
	mustAdd(t, p, "A", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "B", []Reservation{{Track: 0, Start: 20, End: 30}})
	mustAdd(t, p, "C", []Reservation{{Track: 1, Start: 0, End: 10}})
	old := BatchMove{
		"A": {{Track: 0, Start: 0, End: 10}},
		"B": {{Track: 0, Start: 20, End: 30}},
	}
	newPlan := BatchMove{
		"A": {{Track: 0, Start: 40, End: 50}},
		"B": {{Track: 0, Start: 60, End: 70}},
	}
	return p, old, newPlan
}

func layoutOf(p *Planner, ids ...string) BatchMove {
	out := BatchMove{}
	for _, id := range ids {
		out[id] = p.Reservations(id)
	}
	return out
}

func TestAtomicSwapSuccess(t *testing.T) {
	p := New()
	mustAdd(t, p, "A", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "B", []Reservation{{Track: 0, Start: 10, End: 20}})
	// A and B exchange places on the same track. Individually each move
	// would conflict with the other's old reservation; as a batch the old
	// reservations are removed first, so the swap is feasible.
	swap := BatchMove{
		"A": {{Track: 0, Start: 10, End: 20}},
		"B": {{Track: 0, Start: 0, End: 10}},
	}
	if !p.AtomicSwap(swap) {
		t.Fatal("atomic swap of two trains must succeed")
	}
	if got := p.Reservations("A"); got[0].Start != 10 {
		t.Fatalf("A = %+v, want [10,20)", got)
	}
	if got := p.Reservations("B"); got[0].Start != 0 {
		t.Fatalf("B = %+v, want [0,10)", got)
	}
}

func TestAtomicSwapAllOrNothing(t *testing.T) {
	p := New()
	mustAdd(t, p, "A", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "B", []Reservation{{Track: 0, Start: 20, End: 30}})
	mustAdd(t, p, "C", []Reservation{{Track: 0, Start: 50, End: 60}})
	batch := BatchMove{
		"A": {{Track: 0, Start: 55, End: 65}}, // conflicts with C
		"B": {{Track: 0, Start: 40, End: 45}}, // fine on its own
	}
	if p.AtomicSwap(batch) {
		t.Fatal("batch containing a conflict must fail as a whole")
	}
	if got := p.Reservations("A"); got[0].Start != 0 {
		t.Fatalf("A changed despite failed batch: %+v", got)
	}
	if got := p.Reservations("B"); got[0].Start != 20 {
		t.Fatalf("B changed despite failed batch: %+v", got)
	}
}

func TestAtomicSwapRejectsInternalConflict(t *testing.T) {
	p := New()
	mustAdd(t, p, "A", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "B", []Reservation{{Track: 0, Start: 20, End: 30}})
	batch := BatchMove{
		"A": {{Track: 0, Start: 40, End: 50}},
		"B": {{Track: 0, Start: 45, End: 55}}, // overlaps A's new plan
	}
	if p.AtomicSwap(batch) {
		t.Fatal("batch whose new plans conflict with each other must fail")
	}
	if got := p.Reservations("A"); got[0].Start != 0 {
		t.Fatalf("A changed despite failed batch: %+v", got)
	}
	if got := p.Reservations("B"); got[0].Start != 20 {
		t.Fatalf("B changed despite failed batch: %+v", got)
	}
}

func TestCommitBatchInvalidKeepsOldAndLogsNothing(t *testing.T) {
	p, old, _ := batchPlan(t)
	log := &TxLog{}
	bad := BatchMove{
		"A": {{Track: 1, Start: 5, End: 15}}, // conflicts with C
		"B": {{Track: 0, Start: 60, End: 70}},
	}
	if p.CommitBatch(bad, log) {
		t.Fatal("invalid batch must not commit")
	}
	if len(log.Records()) != 0 {
		t.Fatalf("rejected batch must not write log records, got %+v", log.Records())
	}
	if got := layoutOf(p, "A", "B"); !reflect.DeepEqual(got, old) {
		t.Fatalf("old layout not preserved: %+v", got)
	}
}

func TestCommitBatchSuccess(t *testing.T) {
	p, _, newPlan := batchPlan(t)
	log := &TxLog{}
	if !p.CommitBatch(newPlan, log) {
		t.Fatal("valid batch must commit")
	}
	if got := layoutOf(p, "A", "B"); !reflect.DeepEqual(got, newPlan) {
		t.Fatalf("layout = %+v, want %+v", got, newPlan)
	}
	if !log.HasCommit() {
		t.Fatal("commit record missing from log")
	}
	// Recovery after a clean commit is a no-op on the layout.
	p.Recover(log)
	if got := layoutOf(p, "A", "B"); !reflect.DeepEqual(got, newPlan) {
		t.Fatalf("layout after recover = %+v, want %+v", got, newPlan)
	}
}

// TestRecoveryAcrossCrashPoints crashes the commit at every possible step
// and checks that recovery always restores either the whole old layout or
// the whole new layout — never a per-train mix.
func TestRecoveryAcrossCrashPoints(t *testing.T) {
	_, oldPlan, newPlan := batchPlan(t)
	const totalSteps = 5 // BEGIN, INTENT, apply A, apply B, COMMIT
	for crashAfter := 0; crashAfter <= totalSteps; crashAfter++ {
		p, _, batch := batchPlan(t)
		log := &TxLog{}
		p.commitBatch(batch, log, crashAfter)
		p.Recover(log)
		got := layoutOf(p, "A", "B")
		committed := log.HasCommit()
		want := oldPlan
		if committed {
			want = newPlan
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("crashAfter=%d committed=%v: layout = %+v, want %+v",
				crashAfter, committed, got, want)
		}
		// Explicitly: no single-train rescheduling may survive.
		aIsOld := reflect.DeepEqual(got["A"], oldPlan["A"])
		bIsOld := reflect.DeepEqual(got["B"], oldPlan["B"])
		if aIsOld != bIsOld {
			t.Fatalf("crashAfter=%d: partial layout survived: %+v", crashAfter, got)
		}
		// Bystander train C is never touched.
		if got := p.Reservations("C"); len(got) != 1 || got[0] != (Reservation{Track: 1, Start: 0, End: 10}) {
			t.Fatalf("crashAfter=%d: bystander C changed: %+v", crashAfter, got)
		}
	}
}

// TestRecoveryRollsForwardAfterCommitCrash covers a crash after the COMMIT
// record is durable but before the caller learned the result: recovery must
// roll forward to the whole new layout.
func TestRecoveryRollsForwardAfterCommitCrash(t *testing.T) {
	p, _, newPlan := batchPlan(t)
	log := &TxLog{}
	// Crash one step beyond the last step: equivalent to no crash, but
	// simulate losing the in-memory confirmation by recovering anyway.
	p.commitBatch(newPlan, log, 6)
	p.Recover(log)
	if got := layoutOf(p, "A", "B"); !reflect.DeepEqual(got, newPlan) {
		t.Fatalf("layout = %+v, want rolled-forward %+v", got, newPlan)
	}
}
