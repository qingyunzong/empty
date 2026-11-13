package dataeng

import (
	"sort"
)

// Snapshot is an immutable, published inventory. It can be read concurrently
// without locking the Store. Its Number increases with every publication.
type Snapshot struct {
	number uint64
	marker Marker
	set    *recordSet

	keys         []string
	history      []Record
	latest       []Record
	latestEntry  []Record
	historyByKey map[string][]Record
	latestByKey  map[string]Record
}

func newSnapshot(number uint64, marker Marker, set *recordSet) *Snapshot {
	s := &Snapshot{
		number:       number,
		marker:       marker,
		set:          set,
		historyByKey: make(map[string][]Record, len(set.byKey)),
		latestByKey:  make(map[string]Record, len(set.byKey)),
	}
	s.keys = make([]string, 0, len(set.byKey))
	for key := range set.byKey {
		s.keys = append(s.keys, key)
	}
	sort.Strings(s.keys)

	candidates := make([]storedRecord, 0, 4)
	for _, key := range s.keys {
		candidates = candidates[:0]
		for _, entry := range set.byKey[key] {
			candidates = append(candidates, entry)
		}
		sort.Slice(candidates, func(i, j int) bool {
			return orderNewestFirst(candidates[i], candidates[j])
		})

		history := make([]Record, len(candidates))
		for i, entry := range candidates {
			history[i] = entry.rec
			history[i].IsLatest = i == 0
		}
		s.historyByKey[key] = history
		s.history = append(s.history, history...)
		if len(history) == 0 {
			continue
		}
		s.latestEntry = append(s.latestEntry, history[0])
		if !history[0].DeleteMarker {
			s.latestByKey[key] = history[0]
			s.latest = append(s.latest, history[0])
		}
	}
	return s
}

// orderNewestFirst gives snapshots a deterministic total order. Timestamps are
// primary because they are what S3 users observe. At an equal timestamp a
// concurrently observed upload outranks an inventory-only entry, then IsLatest
// breaks remaining ties from a ListObjectVersions response. A delete marker
// wins an otherwise exact tie, and the observation sequence makes concurrent
// upload ordering stable.
func orderNewestFirst(a, b storedRecord) bool {
	if !a.rec.LastModified.Equal(b.rec.LastModified) {
		return a.rec.LastModified.After(b.rec.LastModified)
	}
	if a.fromUpload != b.fromUpload {
		return a.fromUpload
	}
	if a.rec.IsLatest != b.rec.IsLatest {
		return a.rec.IsLatest
	}
	if a.rec.DeleteMarker != b.rec.DeleteMarker {
		return a.rec.DeleteMarker
	}
	if a.rec.VersionID != b.rec.VersionID {
		return a.rec.VersionID > b.rec.VersionID
	}
	return a.seq > b.seq
}

// Number is the publication sequence number of the snapshot.
func (s *Snapshot) Number() uint64 {
	return s.number
}

// Marker is the continuation cursor that completed the published traversal.
func (s *Snapshot) Marker() Marker {
	return s.marker
}

// Latest returns the live version for key. Keys whose newest entry is a delete
// marker are absent from the latest view.
func (s *Snapshot) Latest(key string) (Record, bool) {
	rec, ok := s.latestByKey[key]
	return rec, ok
}

// GetLatest is an alias for Latest.
func (s *Snapshot) GetLatest(key string) (Record, bool) {
	return s.Latest(key)
}

// History returns all known versions and delete markers for key, newest first.
// The boolean is false when the key has never been observed.
func (s *Snapshot) History(key string) ([]Record, bool) {
	records, ok := s.historyByKey[key]
	if !ok {
		return nil, false
	}
	return cloneRecords(records), true
}

// Versions is an alias for History.
func (s *Snapshot) Versions(key string) []Record {
	records, _ := s.History(key)
	return records
}

// GetHistory is an alias for History.
func (s *Snapshot) GetHistory(key string) ([]Record, bool) {
	return s.History(key)
}

// LatestView returns one live record per key in ascending key order.
func (s *Snapshot) LatestView() []Record {
	return cloneRecords(s.latest)
}

// LatestVersions is an alias for LatestView.
func (s *Snapshot) LatestVersions() []Record {
	return s.LatestView()
}

// LatestEntry returns the newest entry for key, including a delete marker.
// Use Latest when only live objects are wanted.
func (s *Snapshot) LatestEntry(key string) (Record, bool) {
	history, ok := s.historyByKey[key]
	if !ok || len(history) == 0 {
		return Record{}, false
	}
	return history[0], true
}

// LatestEntries returns one newest entry per key, including delete markers,
// in ascending key order.
func (s *Snapshot) LatestEntries() []Record {
	return cloneRecords(s.latestEntry)
}

// Deleted reports whether the newest entry for key is a delete marker.
func (s *Snapshot) Deleted(key string) bool {
	rec, ok := s.LatestEntry(key)
	return ok && rec.DeleteMarker
}

// HistoryView returns every record, ordered by ascending key and then newest
// first within each key.
func (s *Snapshot) HistoryView() []Record {
	return cloneRecords(s.history)
}

// AllVersions is an alias for HistoryView.
func (s *Snapshot) AllVersions() []Record {
	return s.HistoryView()
}

// VersionHistory is an alias for HistoryView.
func (s *Snapshot) VersionHistory() []Record {
	return s.HistoryView()
}

// LatestMap returns a mutable copy of the latest view keyed by object key.
func (s *Snapshot) LatestMap() map[string]Record {
	out := make(map[string]Record, len(s.latestByKey))
	for key, rec := range s.latestByKey {
		out[key] = rec
	}
	return out
}

// Keys returns all observed keys in ascending order, including keys that
// currently have only delete markers.
func (s *Snapshot) Keys() []string {
	return append([]string(nil), s.keys...)
}

// Len returns the number of version and delete-marker entries.
func (s *Snapshot) Len() int {
	return len(s.history)
}

// LatestLen returns the number of live objects in the latest view.
func (s *Snapshot) LatestLen() int {
	return len(s.latest)
}

// Has reports whether key has a live version in the latest view.
func (s *Snapshot) Has(key string) bool {
	_, ok := s.latestByKey[key]
	return ok
}

// HasKey reports whether any version or delete marker was observed for key.
func (s *Snapshot) HasKey(key string) bool {
	_, ok := s.historyByKey[key]
	return ok
}

func cloneRecords(in []Record) []Record {
	if len(in) == 0 {
		return nil
	}
	return append([]Record(nil), in...)
}
