package tanksim

import (
	"encoding/json"
	"fmt"
	"math/big"
)

// Snapshot captures the complete mutable state of a Sim: tank levels,
// valve open/closed flags, and the tick counter. Levels are stored as
// exact rational strings ("a/b"), so snapshots serialize losslessly.
type Snapshot struct {
	TickCount int64    `json:"tick_count"`
	Levels    []string `json:"levels"`
	Valves    []bool   `json:"valves"`
}

// Snapshot returns a deep, serializable copy of the current state.
func (s *Sim) Snapshot() *Snapshot {
	snap := &Snapshot{
		TickCount: s.TickCount,
		Levels:    make([]string, len(s.Tanks)),
		Valves:    make([]bool, len(s.Valves)),
	}
	for i, t := range s.Tanks {
		snap.Levels[i] = t.Level.RatString()
	}
	for i, v := range s.Valves {
		snap.Valves[i] = v.Open
	}
	return snap
}

// Restore replaces the current state with snap. The topology (tank,
// valve, trigger counts) must match the snapshot.
func (s *Sim) Restore(snap *Snapshot) error {
	if len(snap.Levels) != len(s.Tanks) || len(snap.Valves) != len(s.Valves) {
		return fmt.Errorf("snapshot topology mismatch: %d/%d levels, %d/%d valves",
			len(snap.Levels), len(s.Tanks), len(snap.Valves), len(s.Valves))
	}
	for i, str := range snap.Levels {
		r, ok := new(big.Rat).SetString(str)
		if !ok {
			return fmt.Errorf("bad rational %q for tank %d", str, i)
		}
		s.Tanks[i].Level = r
	}
	for i, open := range snap.Valves {
		s.Valves[i].Open = open
	}
	s.TickCount = snap.TickCount
	return nil
}

// MarshalJSON serializes the snapshot (exact rational strings).
func (snap *Snapshot) MarshalJSON() ([]byte, error) {
	type alias Snapshot
	return json.Marshal((*alias)(snap))
}

// SnapshotJSON returns the snapshot encoded as JSON.
func (s *Sim) SnapshotJSON() ([]byte, error) {
	return json.Marshal(s.Snapshot())
}

// RestoreJSON decodes a JSON snapshot and restores it.
func (s *Sim) RestoreJSON(data []byte) error {
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return err
	}
	return s.Restore(&snap)
}
