package cut

import (
	"encoding/json"
	"errors"
	"os"
)

// State persists reusable leftovers across orders. Cut pieces are never
// rolled back: earlier orders' plans are immutable, only the leftover
// inventory carries over.
type State struct {
	OrderSeq  int   `json:"orderSeq"`
	Inventory []Bar `json:"inventory"`
	History   []Bar `json:"history"` // every bar ever created, for source trees
}

func LoadState(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *State) Save(path string) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// Apply folds a finished plan into the state: consumed inventory bars are
// removed, new reusable leftovers are added, all bars are recorded in the
// history for lineage, and the order sequence advances.
func (s *State) Apply(plan *Plan) {
	used := map[string]bool{}
	for _, bp := range plan.Bars {
		if bp.Origin == "inventory" {
			used[bp.BarID] = true
		}
		if bp.Origin == "purchased" {
			s.History = append(s.History, Bar{
				ID: bp.BarID, Length: bp.Length, Origin: "purchased", Order: plan.OrderID,
			})
		}
	}
	kept := s.Inventory[:0]
	for _, b := range s.Inventory {
		if !used[b.ID] {
			kept = append(kept, b)
		}
	}
	s.Inventory = append(kept, plan.NewInventory...)
	s.History = append(s.History, plan.NewInventory...)
	s.OrderSeq++
}
