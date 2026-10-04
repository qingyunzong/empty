package replayfs

import (
	"bytes"
	"encoding/gob"
	"sort"
)

type snapshotEntry struct {
	Path string
	Data []byte
}

// Snapshot serializes the durable store into a self-contained byte
// slice. The encoding is deterministic: identical stores always produce
// identical snapshots, so snapshots can be compared bytewise.
func (s *Store) Snapshot() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := make([]snapshotEntry, 0, len(s.data))
	for path, data := range s.data {
		entries = append(entries, snapshotEntry{Path: path, Data: data})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(entries); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// RestoreStore rebuilds a Store from a Snapshot. The restored store is
// fully independent of the original.
func RestoreStore(data []byte) (*Store, error) {
	var entries []snapshotEntry
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&entries); err != nil {
		return nil, err
	}
	m := make(map[string][]byte, len(entries))
	for _, e := range entries {
		m[e.Path] = e.Data
	}
	return &Store{data: m}, nil
}
