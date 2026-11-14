package dataeng

import (
	"encoding/json"
	"fmt"
	"sort"
)

// StateVersion is the serialized state format version.
const StateVersion = 1

// EntryIndexes is the set of logical indexes acknowledged or published for one
// Pulsar entry.
type EntryIndexes struct {
	LedgerID int64   `json:"ledger_id"`
	EntryID  int64   `json:"entry_id"`
	Indexes  []int32 `json:"indexes"`
}

// Snapshot is a complete, serializable image of a Tracker. Acked indexes at or
// below the cumulative watermark are omitted because the watermark already
// covers them.
type Snapshot struct {
	Version                int            `json:"version"`
	Topic                  string         `json:"topic,omitempty"`
	Subscription           string         `json:"subscription,omitempty"`
	TopicGeneration        uint64         `json:"topic_generation"`
	SubscriptionGeneration uint64         `json:"subscription_generation"`
	CumulativeAck          *MessageID     `json:"cumulative_ack,omitempty"`
	Acked                  []EntryIndexes `json:"acked,omitempty"`
	Published              []EntryIndexes `json:"published,omitempty"`
}

// State is an alias for Snapshot.
type State = Snapshot

// Snapshot returns a deep copy of the tracker state.
func (t *Tracker) Snapshot() Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked()
}

// State returns a deep copy of the tracker state.
func (t *Tracker) State() Snapshot {
	return t.Snapshot()
}

func (t *Tracker) snapshotLocked() Snapshot {
	s := Snapshot{
		Version:                StateVersion,
		Topic:                  t.topic,
		Subscription:           t.subscription,
		TopicGeneration:        t.token.TopicGeneration,
		SubscriptionGeneration: t.token.SubscriptionGeneration,
		Acked:                  snapshotIndexSets(t.acked),
		Published:              snapshotIndexSets(t.published),
	}
	if t.cumulative != nil {
		watermark := *t.cumulative
		s.CumulativeAck = &watermark
	}
	return s
}

func snapshotIndexSets(source map[entryKey]indexSet) []EntryIndexes {
	if len(source) == 0 {
		return nil
	}
	keys := make([]entryKey, 0, len(source))
	for key, set := range source {
		if len(set) > 0 {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].ledgerID != keys[j].ledgerID {
			return keys[i].ledgerID < keys[j].ledgerID
		}
		return keys[i].entryID < keys[j].entryID
	})
	out := make([]EntryIndexes, 0, len(keys))
	for _, key := range keys {
		set := source[key]
		indexes := make([]int32, 0, len(set))
		for index := range set {
			indexes = append(indexes, index)
		}
		sort.Slice(indexes, func(i, j int) bool { return indexes[i] < indexes[j] })
		out = append(out, EntryIndexes{
			LedgerID: key.ledgerID,
			EntryID:  key.entryID,
			Indexes:  indexes,
		})
	}
	return out
}

// Restore replaces the tracker state with s. The topic/subscription of an
// already-scoped tracker must match s. The operation is atomic: on error the
// existing state is unchanged.
func (t *Tracker) Restore(s Snapshot) error {
	restored, err := newFromSnapshot(s)
	if err != nil {
		return err
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.topic != "" && s.Topic != "" && t.topic != s.Topic {
		return fmt.Errorf("%w: topic %q vs %q", ErrScopeMismatch, t.topic, s.Topic)
	}
	if t.subscription != "" && s.Subscription != "" && t.subscription != s.Subscription {
		return fmt.Errorf("%w: subscription %q vs %q", ErrScopeMismatch, t.subscription, s.Subscription)
	}
	if t.topic == "" {
		t.topic = s.Topic
	}
	if t.subscription == "" {
		t.subscription = s.Subscription
	}
	t.token = restored.token
	t.cumulative = restored.cumulative
	t.acked = restored.acked
	t.published = restored.published
	return nil
}

// NewFromSnapshot creates a tracker from a state image.
func NewFromSnapshot(s Snapshot) (*Tracker, error) {
	return newFromSnapshot(s)
}

// NewFromState is an alias for NewFromSnapshot.
func NewFromState(s State) (*Tracker, error) {
	return NewFromSnapshot(s)
}

func newFromSnapshot(s Snapshot) (*Tracker, error) {
	if s.Version < 0 || s.Version > StateVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidState, s.Version)
	}
	t := &Tracker{
		topic:        s.Topic,
		subscription: s.Subscription,
		token: Token{
			TopicGeneration:        s.TopicGeneration,
			SubscriptionGeneration: s.SubscriptionGeneration,
		},
	}

	if s.CumulativeAck != nil {
		if err := s.CumulativeAck.Validate(); err != nil {
			return nil, fmt.Errorf("%w: cumulative ack: %w", ErrInvalidState, err)
		}
		watermark := *s.CumulativeAck
		t.cumulative = &watermark
	}

	var err error
	if t.acked, err = restoreIndexSets(s.Acked); err != nil {
		return nil, fmt.Errorf("%w: acked: %w", ErrInvalidState, err)
	}
	if t.published, err = restoreIndexSets(s.Published); err != nil {
		return nil, fmt.Errorf("%w: published: %w", ErrInvalidState, err)
	}
	return t, nil
}

func restoreIndexSets(entries []EntryIndexes) (map[entryKey]indexSet, error) {
	out := make(map[entryKey]indexSet, len(entries))
	for _, entry := range entries {
		key := entryKey{entry.LedgerID, entry.EntryID}
		if _, exists := out[key]; exists {
			return nil, fmt.Errorf("duplicate entry %d:%d", entry.LedgerID, entry.EntryID)
		}
		set := make(indexSet, len(entry.Indexes))
		for _, index := range entry.Indexes {
			id := MessageID{LedgerID: entry.LedgerID, EntryID: entry.EntryID, BatchIndex: index}
			if err := id.Validate(); err != nil {
				return nil, err
			}
			set[index] = struct{}{}
		}
		if len(set) > 0 {
			out[key] = set
		}
	}
	return out, nil
}

// MarshalBinary serializes the tracker state.
func (t *Tracker) MarshalBinary() ([]byte, error) {
	return json.Marshal(t.Snapshot())
}

// UnmarshalBinary replaces the tracker state from serialized bytes.
func (t *Tracker) UnmarshalBinary(data []byte) error {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidState, err)
	}
	return t.Restore(s)
}

// MarshalJSON implements json.Marshaler.
func (t *Tracker) MarshalJSON() ([]byte, error) {
	return json.Marshal(t.Snapshot())
}

// UnmarshalJSON implements json.Unmarshaler.
func (t *Tracker) UnmarshalJSON(data []byte) error {
	return t.UnmarshalBinary(data)
}

// Export returns the serialized state.
func (t *Tracker) Export() ([]byte, error) {
	return t.MarshalBinary()
}

// Import replaces the tracker state from serialized bytes.
func (t *Tracker) Import(data []byte) error {
	return t.UnmarshalBinary(data)
}

// Restore decodes serialized state into a new tracker.
func Restore(data []byte) (*Tracker, error) {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidState, err)
	}
	return NewFromSnapshot(s)
}

// Load is an alias for Restore.
func Load(data []byte) (*Tracker, error) {
	return Restore(data)
}
