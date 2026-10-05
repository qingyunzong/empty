package firesim

import (
	"encoding/json"
	"fmt"
	"os"
)

// checkpointVersion is bumped when the checkpoint layout changes.
const checkpointVersion = 1

// Checkpoint is the serialisable continuation point of a Sim. It
// records the original seed and the exact PRNG state so that a resumed
// run reproduces the uninterrupted run cell for cell.
type Checkpoint struct {
	Version   int           `json:"version"`
	Seed      uint64        `json:"seed"`
	RngState  uint64        `json:"rng_state"`
	Round     int           `json:"round"`
	Width     int           `json:"width"`
	Height    int           `json:"height"`
	Grid      []uint8       `json:"grid"`
	BaseProb  int           `json:"base_prob"`
	WindBoost int           `json:"wind_boost"`
	Wind      []WindSegment `json:"wind"`
	Events    []Event       `json:"events"`
}

// Checkpoint returns the current state as a serialisable Checkpoint.
func (s *Sim) Checkpoint() Checkpoint {
	return Checkpoint{
		Version:   checkpointVersion,
		Seed:      s.seed,
		RngState:  s.rng.state,
		Round:     s.Round,
		Width:     s.Width,
		Height:    s.Height,
		Grid:      append([]uint8(nil), s.Grid...),
		BaseProb:  s.baseProb,
		WindBoost: s.windBoost,
		Wind:      append([]WindSegment(nil), s.wind...),
		Events:    append([]Event(nil), s.events...),
	}
}

// FromCheckpoint restores a simulation from a Checkpoint.
func FromCheckpoint(cp Checkpoint) (*Sim, error) {
	if cp.Version != checkpointVersion {
		return nil, fmt.Errorf("firesim: unsupported checkpoint version %d", cp.Version)
	}
	if cp.Width <= 0 || cp.Height <= 0 || len(cp.Grid) != cp.Width*cp.Height {
		return nil, fmt.Errorf("firesim: corrupt checkpoint grid %dx%d (%d cells)",
			cp.Width, cp.Height, len(cp.Grid))
	}
	return &Sim{
		Width:     cp.Width,
		Height:    cp.Height,
		Round:     cp.Round,
		Grid:      append([]uint8(nil), cp.Grid...),
		seed:      cp.Seed,
		rng:       rng{state: cp.RngState},
		baseProb:  cp.BaseProb,
		windBoost: cp.WindBoost,
		wind:      append([]WindSegment(nil), cp.Wind...),
		events:    append([]Event(nil), cp.Events...),
	}, nil
}

// SaveCheckpoint writes the current continuation point to path as JSON.
func (s *Sim) SaveCheckpoint(path string) error {
	data, err := json.MarshalIndent(s.Checkpoint(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// LoadCheckpoint restores a simulation previously saved with
// SaveCheckpoint.
func LoadCheckpoint(path string) (*Sim, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cp Checkpoint
	if err := json.Unmarshal(data, &cp); err != nil {
		return nil, fmt.Errorf("firesim: decoding checkpoint: %w", err)
	}
	return FromCheckpoint(cp)
}
