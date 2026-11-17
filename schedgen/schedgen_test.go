package schedgen

import (
	"reflect"
	"testing"
)

func TestGenerateIsDeterministic(t *testing.T) {
	opts := Options{Keys: 9, Pre: 4, Crossing: 3, Post: 5}
	a := Generate(42, opts)
	b := Generate(42, opts)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed produced different schedules\na=%v\nb=%v", a.Ops, b.Ops)
	}
	c := Generate(43, opts)
	if reflect.DeepEqual(a.Ops, c.Ops) {
		t.Fatal("different seeds produced identical schedules")
	}
}

func TestScheduleShape(t *testing.T) {
	for seed := int64(0); seed < 50; seed++ {
		sch := Generate(seed, Options{Keys: 6, Pre: 3, Crossing: 2, Post: 3})

		begun := make(map[int]bool)
		finished := make(map[int]bool)
		scanAt := -1
		hasCatchUp := false
		hasSeal := false
		hasPublish := false
		crossingAfterScan := 0

		for i, op := range sch.Ops {
			switch op.Kind {
			case Begin:
				if begun[op.Txn] {
					t.Fatalf("seed %d: txn %d began twice", seed, op.Txn)
				}
				begun[op.Txn] = true
			case Put, Delete:
				if !begun[op.Txn] {
					t.Fatalf("seed %d: op %v uses unbegun txn", seed, op)
				}
				if finished[op.Txn] {
					t.Fatalf("seed %d: op %v uses finished txn", seed, op)
				}
			case Commit, Rollback:
				if !begun[op.Txn] {
					t.Fatalf("seed %d: op %v finishes unbegun txn", seed, op)
				}
				if finished[op.Txn] {
					t.Fatalf("seed %d: txn %d finished twice", seed, op.Txn)
				}
				finished[op.Txn] = true
				if scanAt >= 0 {
					crossingAfterScan++
				}
			case Scan:
				if scanAt >= 0 {
					t.Fatalf("seed %d: multiple scans", seed)
				}
				scanAt = i
			case CatchUp:
				hasCatchUp = true
			case Seal:
				hasSeal = true
			case Publish:
				hasPublish = true
			case Cancel:
				t.Fatalf("seed %d: unexpected cancellation", seed)
			}
		}

		if scanAt < 0 || !hasCatchUp || !hasSeal || !hasPublish {
			t.Fatalf("seed %d: incomplete schedule %v", seed, sch.Ops)
		}
		if len(begun) != len(finished) {
			t.Fatalf("seed %d: %d begun but %d finished", seed, len(begun), len(finished))
		}
		if crossingAfterScan == 0 {
			t.Fatalf("seed %d: no transaction finishes after the scan", seed)
		}
		if sch.Ops[len(sch.Ops)-2].Kind != Seal || sch.Ops[len(sch.Ops)-1].Kind != Publish {
			t.Fatalf("seed %d: schedule must end with seal,publish: %v", seed, sch.Ops)
		}
	}
}

func TestCancelSchedule(t *testing.T) {
	sch := Generate(7, Options{Cancel: true})
	if len(sch.Ops) == 0 || sch.Ops[len(sch.Ops)-1].Kind != Cancel {
		t.Fatalf("cancel schedule does not end in cancel: %v", sch.Ops)
	}
	for _, op := range sch.Ops {
		if op.Kind == Seal || op.Kind == Publish {
			t.Fatalf("cancel schedule contains %v", op)
		}
	}
}

func TestDefaults(t *testing.T) {
	sch := Generate(1, Options{})
	if sch.Options.Keys == 0 || sch.Options.Pre == 0 ||
		sch.Options.Crossing == 0 || sch.Options.Post == 0 {
		t.Fatalf("defaults not applied: %+v", sch.Options)
	}
}
