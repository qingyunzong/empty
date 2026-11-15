package dataeng

import (
	"fmt"
	"sort"
)

// State is a serializable copy of a Detector. It can be persisted between
// collector runs and passed to NewFromState. Slots are not stored because they
// are derived from the configured hash salt and rotation width.
type State struct {
	Generation uint64        `json:"generation"`
	Incomplete uint64        `json:"incomplete,omitempty"`
	Records    []RecordState `json:"records"`
}

// RecordState is the persisted form of one tracked resource.
type RecordState struct {
	ID                    ID     `json:"id"`
	Version               uint64 `json:"version"`
	Status                Status `json:"status"`
	Missing               int    `json:"missing,omitempty"`
	FirstGeneration       uint64 `json:"first_generation"`
	LastPresentGeneration uint64 `json:"last_present_generation"`
}

// Export returns a deep copy of the detector state. Records are sorted by ID,
// so exporting the same state twice produces identical slices.
func (d *Detector) Export() State {
	d.mu.Lock()
	defer d.mu.Unlock()

	state := State{
		Generation: d.generation,
		Incomplete: d.incomplete,
		Records:    make([]RecordState, 0, len(d.records)),
	}
	for _, rec := range d.records {
		state.Records = append(state.Records, RecordState{
			ID:                    rec.id,
			Version:               rec.version,
			Status:                rec.status,
			Missing:               rec.missing,
			FirstGeneration:       rec.firstGeneration,
			LastPresentGeneration: rec.lastPresentGeneration,
		})
	}
	sort.Slice(state.Records, func(i, j int) bool {
		return state.Records[i].ID < state.Records[j].ID
	})
	return state
}

// NewFromState recreates a Detector from persisted state. The configuration
// must describe the same rotation width and salt that produced the state;
// otherwise IDs may be moved to different slots.
func NewFromState(cfg Config, state State) (*Detector, error) {
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}

	d := &Detector{
		cfg:        normalized,
		generation: state.Generation,
		incomplete: state.Incomplete,
		records:    make(map[ID]*record, len(state.Records)),
	}

	for _, stored := range state.Records {
		if stored.Version == 0 {
			return nil, fmt.Errorf("dataeng: record %q has zero version", stored.ID)
		}
		if stored.Missing < 0 {
			return nil, fmt.Errorf("dataeng: record %q has negative missing count", stored.ID)
		}
		if stored.Status > StatusDeleted {
			return nil, fmt.Errorf("dataeng: record %q has invalid status %d", stored.ID, stored.Status)
		}
		if stored.FirstGeneration > state.Generation {
			return nil, fmt.Errorf("dataeng: record %q has first generation %d after state generation %d", stored.ID, stored.FirstGeneration, state.Generation)
		}
		if stored.LastPresentGeneration > state.Generation {
			return nil, fmt.Errorf("dataeng: record %q has last present generation %d after state generation %d", stored.ID, stored.LastPresentGeneration, state.Generation)
		}
		if _, exists := d.records[stored.ID]; exists {
			return nil, fmt.Errorf("dataeng: duplicate record %q", stored.ID)
		}

		d.records[stored.ID] = &record{
			id:                    stored.ID,
			version:               stored.Version,
			status:                stored.Status,
			missing:               stored.Missing,
			slot:                  slotForID(stored.ID, normalized.MaxRecheckCycles, normalized.HashSalt),
			firstGeneration:       stored.FirstGeneration,
			lastPresentGeneration: stored.LastPresentGeneration,
		}
	}
	return d, nil
}
