package dataeng

import (
	"reflect"
	"testing"
)

func TestExportRestoreRoundTrip(t *testing.T) {
	cfg := Config{DeleteAfter: 2, MaxRecheckCycles: 1, HashSalt: "stable"}
	d := newTestDetector(t, cfg)

	d.ObserveComplete([]ID{"a", "b", "c"})
	d.ObserveComplete(nil)
	d.ObserveComplete(nil)
	d.ObserveComplete(nil)

	state := d.Export()
	restored, err := NewFromState(cfg, state)
	if err != nil {
		t.Fatalf("NewFromState: %v", err)
	}

	if got := restored.Export(); !reflect.DeepEqual(got, state) {
		t.Fatalf("round trip changed state:\n got %+v\nwant %+v", got, state)
	}
	if got, want := restored.Stats(), d.Stats(); got != want {
		t.Fatalf("stats after restore = %+v, want %+v", got, want)
	}

	// Continued observation must keep working after a restore.
	events := restored.ObserveComplete([]ID{"a"})
	if rec, _ := restored.Lookup("b"); rec.Status != StatusDeleted {
		t.Fatalf("b after restore = %+v, want deleted", rec)
	}
	_ = events
}

func TestNewFromStateRejectsInvalidState(t *testing.T) {
	cfg := Config{DeleteAfter: 2, MaxRecheckCycles: 4}
	tests := []struct {
		name  string
		state State
	}{
		{
			name: "duplicate record",
			state: State{Generation: 1, Records: []RecordState{
				{ID: "a", Version: 1, FirstGeneration: 1, LastPresentGeneration: 1},
				{ID: "a", Version: 1, FirstGeneration: 1, LastPresentGeneration: 1},
			}},
		},
		{
			name: "zero version",
			state: State{Generation: 1, Records: []RecordState{
				{ID: "a", Version: 0, FirstGeneration: 1, LastPresentGeneration: 1},
			}},
		},
		{
			name: "generation in the future",
			state: State{Generation: 1, Records: []RecordState{
				{ID: "a", Version: 1, FirstGeneration: 2, LastPresentGeneration: 2},
			}},
		},
		{
			name: "invalid status",
			state: State{Generation: 1, Records: []RecordState{
				{ID: "a", Version: 1, Status: StatusDeleted + 1, FirstGeneration: 1, LastPresentGeneration: 1},
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewFromState(cfg, test.state); err == nil {
				t.Fatal("NewFromState accepted invalid state")
			}
		})
	}
}
