package dataeng

import (
	"reflect"
	"testing"
)

func TestSessionMergeTriggerAndLateRevision(t *testing.T) {
	op := mustOperator(t, Config{Window: Session(5), AllowedLateness: 5})

	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1, Value: "a"})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 3, Value: "b"})
	// Exactly one gap after the last record still merges.
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 8, Value: "c"})
	// A new event beyond the gap starts a second session.
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 20, Value: "d"})

	results := advance(t, op, "p", "s", 13)
	if len(results) != 1 {
		t.Fatalf("expected the first merged session, got %v", results)
	}
	if results[0].Window != (Window{1, 13}) || results[0].Version != 1 || len(results[0].Events) != 3 {
		t.Fatalf("unexpected session: %+v", results[0])
	}

	results = advance(t, op, "p", "s", 25)
	if len(results) != 1 || results[0].Window != (Window{20, 25}) || results[0].Version != 1 {
		t.Fatalf("unexpected second session: %v", results)
	}

	// First session's deadline is 13+5=18 and it has been discarded.
	_, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 2})
	if len(sides) != 1 || sides[0].Reason != SideOutputAfterDeadline {
		t.Fatalf("expected side output for discarded session, got %+v", sides)
	}

	// The second session is fired but still within its lateness period.
	results, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 21})
	if len(sides) != 0 || len(results) != 1 {
		t.Fatalf("expected a revision, got %v / %v", results, sides)
	}
	if results[0].Window != (Window{20, 26}) || results[0].Version != 2 {
		t.Fatalf("unexpected revision: %+v", results[0])
	}

	results = advance(t, op, "p", "s", 31)
	if len(results) != 0 {
		t.Fatalf("finalization emitted an extra result: %v", results)
	}
	_, sides = processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 22})
	if len(sides) != 1 {
		t.Fatalf("expected side output, got %v", sides)
	}
}

func TestSessionMergesTwoFiredSessions(t *testing.T) {
	op := mustOperator(t, Config{Window: Session(5), AllowedLateness: 20})

	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 9})
	results := advance(t, op, "p", "s", 14)
	if len(results) != 2 {
		t.Fatalf("expected two sessions, got %v", results)
	}
	if results[0].Window != (Window{1, 6}) || results[0].Version != 1 ||
		results[1].Window != (Window{9, 14}) || results[1].Version != 1 {
		t.Fatalf("unexpected sessions: %v", results)
	}

	// The bridging record merges both fired sessions; its version is
	// max(1,1)+1 and the merged interval spans both.
	results, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 6})
	if len(sides) != 0 || len(results) != 1 {
		t.Fatalf("expected one merged revision, got %v / %v", results, sides)
	}
	if results[0].Window != (Window{1, 14}) || results[0].Version != 2 || len(results[0].Events) != 3 {
		t.Fatalf("unexpected merged session: %+v", results[0])
	}
}

func TestSessionClosedBoundaryDoesNotResurrect(t *testing.T) {
	op := mustOperator(t, Config{Window: Session(5), AllowedLateness: 0})
	processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 1})
	advance(t, op, "p", "s", 6) // trigger and immediately finalize [1,6)

	_, sides := processEvent(t, op, Event{Partition: "p", Key: "k", Timestamp: 6})
	if len(sides) != 1 || !reflect.DeepEqual(sides[0].Windows, []Window{{6, 11}}) {
		t.Fatalf("boundary record must not resurrect a closed session: %+v", sides)
	}
}
