package dataeng

import (
	"encoding/json"
	"errors"
)

// ErrNegativeK is returned when serialized data carries a negative sample size.
var ErrNegativeK = errors.New("dataeng: serialized sample size k must be non-negative")

// jsonItem mirrors Item with explicit field tags for stable serialization.
type jsonItem struct {
	ID       string `json:"id"`
	Weight   uint64 `json:"weight"`
	Priority uint64 `json:"priority"`
}

type jsonSummary struct {
	K     int        `json:"k"`
	Items []jsonItem `json:"items"`
}

// MarshalJSON encodes the full ID index, not only the retained sample, so
// conflicts on unsampled IDs survive serialization.
func (m *Summary) MarshalJSON() ([]byte, error) {
	payload := jsonSummary{K: m.k, Items: make([]jsonItem, 0, len(m.items))}
	for id, item := range m.items {
		payload.Items = append(payload.Items, jsonItem{
			ID:       id,
			Weight:   item.Weight,
			Priority: item.Priority,
		})
	}
	return json.Marshal(payload)
}

// UnmarshalJSON rebuilds a summary and rejects malformed input, negative K,
// zero weights and duplicated IDs with conflicting content.
func (m *Summary) UnmarshalJSON(data []byte) error {
	var payload jsonSummary
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	if payload.K < 0 {
		return ErrNegativeK
	}
	items := make(map[string]Item, len(payload.Items))
	for _, raw := range payload.Items {
		if raw.Weight == 0 {
			return ErrZeroWeight
		}
		incoming := Item{ID: raw.ID, Weight: raw.Weight, Priority: raw.Priority}
		if existing, ok := items[raw.ID]; ok {
			if existing != incoming {
				return &MergeError{Conflicts: map[string][]Item{raw.ID: {existing, incoming}}}
			}
			continue
		}
		items[raw.ID] = incoming
	}
	m.k = payload.K
	m.items = items
	return nil
}
