// NaiveStore is the deliberately simple reference implementation of the
// temporal lookup semantics. It keeps the full retained history of every
// version in an unsorted flat list, rebuilds the [from, to) partition from
// scratch after every write, and answers every lookup with an O(n) linear
// scan of all historical versions. It never uses binary search or in-place
// interval patching, so it can cross-check LookupStore independently.
package formal

import (
	"math"
	"sort"
	"sync"
)

type naiveKey[V comparable] struct {
	records []Version[V]
	probes  map[int64]tracked[V]
}

// NaiveStore mirrors LookupStore's observable behavior using full-history
// scans only.
type NaiveStore[V comparable] struct {
	mu              sync.RWMutex
	allowedLateness int64
	watermark       int64
	keys            map[int64]*naiveKey[V]
	pending         []Emission[V]
	journal         []Emission[V]
}

// NewNaiveStore creates an empty reference table.
func NewNaiveStore[V comparable](allowedLateness int64) *NaiveStore[V] {
	if allowedLateness < 0 {
		allowedLateness = 0
	}
	return &NaiveStore[V]{
		allowedLateness: allowedLateness,
		watermark:       math.MinInt64,
		keys:            make(map[int64]*naiveKey[V]),
	}
}

// AllowedLateness reports the configured lateness gap.
func (s *NaiveStore[V]) AllowedLateness() int64 { return s.allowedLateness }

// Watermark reports the current watermark.
func (s *NaiveStore[V]) Watermark() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.watermark
}

func (s *NaiveStore[V]) horizon() int64 {
	return horizonOf(s.watermark, s.allowedLateness)
}

// rebuild sorts every retained version by ValidFrom, drops duplicate
// start-points (the latest write wins) and recomputes all half-open
// intervals from neighboring start points.
func (nk *naiveKey[V]) rebuild() {
	if len(nk.records) == 0 {
		return
	}
	sort.Slice(nk.records, func(i, j int) bool {
		return nk.records[i].ValidFrom < nk.records[j].ValidFrom
	})

	unique := nk.records[:0]
	for _, rec := range nk.records {
		if len(unique) > 0 && unique[len(unique)-1].ValidFrom == rec.ValidFrom {
			unique[len(unique)-1] = rec
			continue
		}
		unique = append(unique, rec)
	}
	nk.records = unique

	for i := range nk.records {
		if i+1 < len(nk.records) {
			nk.records[i].ValidTo = nk.records[i+1].ValidFrom
		} else {
			nk.records[i].ValidTo = math.MaxInt64
		}
	}
}

// Upsert appends a version to the full history and rebuilds all intervals.
func (s *NaiveStore[V]) Upsert(key int64, validFrom, validTo int64, value V) error {
	if err := validateWrites(validFrom, validTo); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if validFrom < s.horizon() {
		return ErrInvalidTime
	}
	nk := s.keys[key]
	if nk == nil {
		nk = &naiveKey[V]{probes: make(map[int64]tracked[V])}
		s.keys[key] = nk
	}
	nk.records = append(nk.records, Version[V]{
		ValidFrom: validFrom,
		ValidTo:   0,
		Value:     value,
	})
	nk.rebuild()
	s.sweep(key)
	return nil
}

// Delete appends a tombstone to the full history and rebuilds all intervals.
func (s *NaiveStore[V]) Delete(key int64, validFrom, validTo int64) error {
	var zero V
	if err := validateWrites(validFrom, validTo); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if validFrom < s.horizon() {
		return ErrInvalidTime
	}
	nk := s.keys[key]
	if nk == nil {
		nk = &naiveKey[V]{probes: make(map[int64]tracked[V])}
		s.keys[key] = nk
	}
	nk.records = append(nk.records, Version[V]{
		ValidFrom: validFrom,
		ValidTo:   0,
		Value:     zero,
		Deleted:   true,
	})
	nk.rebuild()
	s.sweep(key)
	return nil
}

// Lookup scans the entire retained history for key and keeps the unique
// version whose half-open interval covers eventTime.
func (s *NaiveStore[V]) Lookup(key int64, eventTime int64) (V, bool, error) {
	if eventTime < 0 {
		var zero V
		return zero, false, ErrInvalidTime
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var zero V
	nk := s.keys[key]
	if nk == nil {
		return zero, false, nil
	}
	for _, rec := range nk.records {
		if rec.ValidFrom <= eventTime && eventTime < rec.ValidTo && !rec.Deleted {
			return rec.Value, true, nil
		}
	}
	return zero, false, nil
}

// Probe joins one event using the naive lookup and tracks it for later
// revisions, with the same drop and replay rules as LookupStore.
func (s *NaiveStore[V]) Probe(eventID int64, eventTime int64, key int64) (Emission[V], bool, error) {
	if eventTime < 0 {
		return Emission[V]{}, false, ErrInvalidTime
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	nk := s.keys[key]
	if nk != nil {
		if existing, ok := nk.probes[eventID]; ok {
			return existing.current, true, nil
		}
	}
	if eventTime < s.horizon() {
		return Emission[V]{}, false, nil
	}

	value, found := s.scan(key, eventTime)
	em := Emission[V]{
		Seq:       len(s.journal),
		EventID:   eventID,
		EventTime: eventTime,
		Key:       key,
		Value:     value,
		Deleted:   !found,
	}
	if nk == nil {
		nk = &naiveKey[V]{probes: make(map[int64]tracked[V])}
		s.keys[key] = nk
	}
	nk.probes[eventID] = tracked[V]{eventID: eventID, time: eventTime, current: em}
	s.pending = append(s.pending, em)
	s.journal = append(s.journal, em)
	return em, true, nil
}

// scan is the lock-free full-history scan used by Probe and sweep.
func (s *NaiveStore[V]) scan(key int64, eventTime int64) (V, bool) {
	var zero V
	nk := s.keys[key]
	if nk == nil {
		return zero, false
	}
	for _, rec := range nk.records {
		if rec.ValidFrom <= eventTime && eventTime < rec.ValidTo && !rec.Deleted {
			return rec.Value, true
		}
	}
	return zero, false
}

// Advance moves the watermark and drops history and probes below the horizon.
func (s *NaiveStore[V]) Advance(w int64) error {
	if w < 0 {
		return ErrInvalidTime
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if w <= s.watermark {
		return nil
	}
	s.watermark = w
	horizon := s.horizon()

	for key, nk := range s.keys {
		kept := nk.records[:0]
		for _, rec := range nk.records {
			if rec.ValidTo > horizon {
				kept = append(kept, rec)
			}
		}
		nk.records = kept

		// Probes inside the lateness window stay revisable; older probes are
		// reclaimed.
		for id, probe := range nk.probes {
			if probe.time < horizon {
				delete(nk.probes, id)
			}
		}
		if len(nk.records) == 0 && len(nk.probes) == 0 {
			delete(s.keys, key)
		}
	}
	return nil
}

// Sweep drains pending corrections.
func (s *NaiveStore[V]) Sweep() []Emission[V] {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.pending
	s.pending = nil
	return out
}

// Journal returns a copy of the append-only emission history.
func (s *NaiveStore[V]) Journal() []Emission[V] {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Emission[V], len(s.journal))
	copy(out, s.journal)
	return out
}

// sweep re-scans every tracked probe for a key and appends revisions for
// changed results, independently of LookupStore's sweep.
func (s *NaiveStore[V]) sweep(key int64) {
	nk := s.keys[key]
	if nk == nil || len(nk.probes) == 0 {
		return
	}

	type probeRef struct {
		id int64
		tr tracked[V]
	}
	refs := make([]probeRef, 0, len(nk.probes))
	for id, tr := range nk.probes {
		refs = append(refs, probeRef{id: id, tr: tr})
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].tr.time != refs[j].tr.time {
			return refs[i].tr.time < refs[j].tr.time
		}
		return refs[i].id < refs[j].id
	})

	for _, ref := range refs {
		value, found := s.scan(key, ref.tr.time)
		next := ref.tr.current
		if next.Deleted == !found && (found == false || next.Value == value) {
			continue
		}
		next.Seq = len(s.journal)
		next.Value = value
		next.Deleted = !found
		ref.tr.current = next
		nk.probes[ref.id] = ref.tr
		s.pending = append(s.pending, next)
		s.journal = append(s.journal, next)
	}
}
