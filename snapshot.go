package dataeng

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
)

const snapshotVersion = 1

// InputSnapshot is the serialized frontier of one input.
type InputSnapshot struct {
	Frontier []Time `json:"frontier"`
}

// QuerySnapshot is a live query registration.
type QuerySnapshot struct {
	ID    string `json:"id"`
	Query Time   `json:"query"`
}

// RecordSnapshot is one stored key/time weight in decimal form.
type RecordSnapshot struct {
	Key    string `json:"key"`
	Time   Time   `json:"time"`
	Weight string `json:"weight"`
}

// Snapshot is the complete serializable state of a Host.
type Snapshot struct {
	Version       int              `json:"version"`
	Inputs        []InputSnapshot  `json:"inputs"`
	Since         []Time           `json:"since"`
	Registrations []QuerySnapshot  `json:"registrations"`
	Records       []RecordSnapshot `json:"records"`
}

// Snapshot returns a detached, deterministic snapshot. Registrations are sorted
// by ID and records by key and (x,y); this ordering is for presentation only.
func (h *Host) Snapshot() Snapshot {
	s := Snapshot{
		Version: snapshotVersion,
		Inputs:  make([]InputSnapshot, len(h.inputs)),
		Since:   h.since.Points(),
	}
	for i, input := range h.inputs {
		s.Inputs[i] = InputSnapshot{Frontier: input.frontier.Points()}
	}

	ids := make([]string, 0, len(h.registrations))
	for id := range h.registrations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		s.Registrations = append(s.Registrations, QuerySnapshot{
			ID:    id,
			Query: h.registrations[id],
		})
	}

	for record, weight := range h.records {
		s.Records = append(s.Records, RecordSnapshot{
			Key:    record.key,
			Time:   record.at,
			Weight: weight.String(),
		})
	}
	sort.Slice(s.Records, func(i, j int) bool {
		if s.Records[i].Key != s.Records[j].Key {
			return s.Records[i].Key < s.Records[j].Key
		}
		if s.Records[i].Time.X != s.Records[j].Time.X {
			return s.Records[i].Time.X < s.Records[j].Time.X
		}
		return s.Records[i].Time.Y < s.Records[j].Time.Y
	})
	return s
}

// RestoreSnapshot reconstructs a host from a snapshot after validating all
// invariants. A closed host (empty since) must have no registrations and no
// history. Live queries must be allowed and incomplete, and stored times must
// already be compacted by since.
func RestoreSnapshot(s Snapshot) (*Host, error) {
	if s.Version != snapshotVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidSnapshot, s.Version)
	}
	if len(s.Inputs) == 0 {
		return nil, fmt.Errorf("%w: no inputs", ErrInvalidSnapshot)
	}

	h, err := NewHost(len(s.Inputs))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	for i, input := range s.Inputs {
		h.inputs[i].frontier = NewAntichain(input.Frontier...)
	}
	h.since = NewAntichain(s.Since...)

	if h.since.IsEmpty() {
		if len(s.Registrations) > 0 || len(s.Records) > 0 {
			return nil, fmt.Errorf("%w: closed host has registrations or history", ErrInvalidSnapshot)
		}
		return h, nil
	}

	for _, registration := range s.Registrations {
		if _, exists := h.registrations[registration.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate query ID %q", ErrInvalidSnapshot, registration.ID)
		}
		if !h.since.Dominates(registration.Query) {
			return nil, fmt.Errorf("%w: query %q is not allowed by since", ErrInvalidSnapshot, registration.ID)
		}
		h.registrations[registration.ID] = registration.Query
	}

	for _, record := range s.Records {
		weight, ok := new(big.Int).SetString(record.Weight, 10)
		if !ok {
			return nil, fmt.Errorf("%w: invalid weight %q", ErrInvalidSnapshot, record.Weight)
		}
		if weight.Sign() == 0 {
			return nil, fmt.Errorf("%w: zero-weight record for key %q", ErrInvalidSnapshot, record.Key)
		}
		if h.since.Compact(record.Time) != record.Time {
			return nil, fmt.Errorf("%w: record time %s is not compacted", ErrInvalidSnapshot, record.Time)
		}
		h.addRecord(record.Key, record.Time, weight)
	}

	for id, q := range h.registrations {
		if len(h.blockingInputs(q)) == 0 {
			return nil, fmt.Errorf("%w: complete query %q is still registered", ErrInvalidSnapshot, id)
		}
	}
	return h, nil
}

// MarshalJSON serializes the complete host state.
func (h *Host) MarshalJSON() ([]byte, error) {
	return json.Marshal(h.Snapshot())
}

// UnmarshalJSON restores a host state, replacing the receiver only if the
// snapshot is valid.
func (h *Host) UnmarshalJSON(data []byte) error {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	restored, err := RestoreSnapshot(s)
	if err != nil {
		return err
	}
	*h = *restored
	return nil
}

// RestoreHost decodes a host previously produced by json.Marshal.
func RestoreHost(data []byte) (*Host, error) {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	return RestoreSnapshot(s)
}
