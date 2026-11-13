package dataeng

import (
	"encoding/json"
	"fmt"
)

// StateVersion is the current persisted-state schema version.
const StateVersion = 1

// State is a serializable snapshot of a reservoir.
type State struct {
	Version int      `json:"version"`
	K       int      `json:"k"`
	Records []Record `json:"records"`
}

// ReservoirState is an alias for State.
type ReservoirState = State

// State returns a snapshot ordered best-first.
func (r *Reservoir) State() State {
	return State{
		Version: StateVersion,
		K:       r.K(),
		Records: r.TopK(),
	}
}

// Snapshot is an alias for State.
func (r *Reservoir) Snapshot() State { return r.State() }

// NewFromState restores a reservoir from a serialized snapshot. Priorities are
// recomputed from each record's ID and weight, so state restored on a different
// process or shard produces identical ordering.
func NewFromState(state State) (*Reservoir, error) {
	if state.Version != 0 && state.Version != StateVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidState, state.Version)
	}
	if state.K <= 0 {
		return nil, fmt.Errorf("%w: %w: %d", ErrInvalidState, ErrInvalidK, state.K)
	}

	r := New(state.K)
	for _, rec := range state.Records {
		if err := ValidateWeight(rec.Weight); err != nil {
			return nil, fmt.Errorf("%w: id %q: %v", ErrInvalidState, rec.ID, err)
		}
		if err := r.AddRecord(rec); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidState, err)
		}
	}
	return r, nil
}

// LoadState is an alias for NewFromState.
func LoadState(state State) (*Reservoir, error) {
	return NewFromState(state)
}

// MarshalJSON implements json.Marshaler.
func (r *Reservoir) MarshalJSON() ([]byte, error) {
	if r == nil {
		return []byte("null"), nil
	}
	return json.Marshal(r.State())
}

// UnmarshalJSON implements json.Unmarshaler. The receiver is only replaced if
// the state is valid.
func (r *Reservoir) UnmarshalJSON(data []byte) error {
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	loaded, err := NewFromState(state)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.k = loaded.k
	r.invalidK = loaded.invalidK
	r.byID = loaded.byID
	r.heap = loaded.heap
	r.mu.Unlock()
	return nil
}

// MarshalBinary implements encoding.BinaryMarshaler. The encoding is JSON, but
// callers should treat it as opaque persisted state.
func (r *Reservoir) MarshalBinary() ([]byte, error) {
	return r.MarshalJSON()
}

// UnmarshalBinary implements encoding.BinaryUnmarshaler.
func (r *Reservoir) UnmarshalBinary(data []byte) error {
	return r.UnmarshalJSON(data)
}
