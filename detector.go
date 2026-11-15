package dataeng

import (
	"fmt"
	"sort"
	"sync"
)

type record struct {
	id                    ID
	version               uint64
	status                Status
	missing               int
	slot                  int
	firstGeneration       uint64
	lastPresentGeneration uint64
}

// Detector tracks the resources seen by a collector and emits soft-delete and
// restore events. It is safe for concurrent use.
//
// A Detector never calls the resource API itself. The caller fetches a
// listing, marks it complete only when the whole list was retrieved without a
// temporary failure, and passes it to Observe.
type Detector struct {
	mu sync.Mutex

	cfg        Config
	generation uint64
	incomplete uint64
	records    map[ID]*record
}

// New creates a Detector. Negative configuration values are rejected; zero
// values select the documented defaults.
func New(cfg Config) (*Detector, error) {
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Detector{
		cfg:     normalized,
		records: make(map[ID]*record),
	}, nil
}

func normalizeConfig(cfg Config) (Config, error) {
	if cfg.DeleteAfter < 0 {
		return Config{}, fmt.Errorf("dataeng: DeleteAfter must not be negative: %d", cfg.DeleteAfter)
	}
	if cfg.MaxRecheckCycles < 0 {
		return Config{}, fmt.Errorf("dataeng: MaxRecheckCycles must not be negative: %d", cfg.MaxRecheckCycles)
	}
	if cfg.DeleteAfter == 0 {
		cfg.DeleteAfter = DefaultDeleteAfter
	}
	if cfg.MaxRecheckCycles == 0 {
		cfg.MaxRecheckCycles = DefaultMaxRecheckCycles
	}
	return cfg, nil
}

// Config returns a copy of the detector's normalized configuration.
func (d *Detector) Config() Config {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cfg
}

// Observe applies one API listing and returns the state transitions caused by
// it. Events are ordered by ID.
//
// An incomplete listing is recorded only as an incomplete observation. It
// does not advance the generation, clear a miss streak, or count as evidence
// for deletion. This is what prevents an HTML error page or a rate-limit
// response from deleting resources.
func (d *Detector) Observe(listing Listing) []Event {
	d.mu.Lock()
	defer d.mu.Unlock()

	if !listing.Complete {
		d.incomplete++
		return nil
	}

	d.generation++
	generation := d.generation
	slot := d.currentSlot()

	present := make(map[ID]struct{}, len(listing.IDs))
	for _, id := range listing.IDs {
		present[id] = struct{}{}
	}

	var events []Event

	for id := range present {
		rec, ok := d.records[id]
		if !ok {
			rec = &record{
				id:                    id,
				version:               1,
				status:                StatusActive,
				slot:                  slotForID(id, d.cfg.MaxRecheckCycles, d.cfg.HashSalt),
				firstGeneration:       generation,
				lastPresentGeneration: generation,
			}
			d.records[id] = rec
			events = append(events, Event{
				Kind:       EventCreated,
				ID:         id,
				Version:    rec.version,
				Generation: generation,
			})
			continue
		}

		wasDeleted := rec.status == StatusDeleted
		rec.status = StatusActive
		rec.missing = 0
		rec.lastPresentGeneration = generation
		if wasDeleted {
			rec.version++
			events = append(events, Event{
				Kind:       EventRestored,
				ID:         id,
				Version:    rec.version,
				Generation: generation,
			})
		}
	}

	for id, rec := range d.records {
		if _, ok := present[id]; ok {
			continue
		}
		if rec.status == StatusDeleted {
			continue
		}
		if rec.slot != slot {
			continue
		}

		rec.missing++
		if rec.missing < d.cfg.DeleteAfter {
			rec.status = StatusPending
			continue
		}

		rec.status = StatusDeleted
		rec.version++
		events = append(events, Event{
			Kind:       EventDeleted,
			ID:         id,
			Version:    rec.version,
			Generation: generation,
			Missing:    rec.missing,
		})
	}

	sort.Slice(events, func(i, j int) bool {
		if events[i].ID != events[j].ID {
			return events[i].ID < events[j].ID
		}
		return events[i].Kind < events[j].Kind
	})
	return events
}

// ObserveComplete is shorthand for observing a complete listing.
func (d *Detector) ObserveComplete(ids []ID) []Event {
	return d.Observe(Listing{Complete: true, IDs: ids})
}

// ObserveIncomplete records a failed or partial API response. It is
// shorthand for Observe with Complete set to false.
func (d *Detector) ObserveIncomplete() {
	d.Observe(Listing{Complete: false})
}

func (d *Detector) currentSlot() int {
	return int((d.generation - 1) % uint64(d.cfg.MaxRecheckCycles))
}

// Generation returns the number of complete listings observed so far.
func (d *Detector) Generation() uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.generation
}

// Stats returns a point-in-time summary.
func (d *Detector) Stats() Stats {
	d.mu.Lock()
	defer d.mu.Unlock()

	stats := Stats{
		Generation:             d.generation,
		IncompleteObservations: d.incomplete,
		Records:                len(d.records),
	}
	for _, rec := range d.records {
		switch rec.status {
		case StatusActive:
			stats.Active++
		case StatusPending:
			stats.Pending++
		case StatusDeleted:
			stats.Deleted++
		}
	}
	return stats
}

// Lookup returns the current state of id, if it is tracked.
func (d *Detector) Lookup(id ID) (RecordInfo, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rec, ok := d.records[id]
	if !ok {
		return RecordInfo{}, false
	}
	return recordInfo(rec), true
}

func recordInfo(rec *record) RecordInfo {
	return RecordInfo{
		ID:                    rec.id,
		Version:               rec.version,
		Status:                rec.status,
		Missing:               rec.missing,
		Slot:                  rec.slot,
		FirstGeneration:       rec.firstGeneration,
		LastPresentGeneration: rec.lastPresentGeneration,
	}
}

// RecheckSlot returns the consistent-hash rotation slot for id. The result is
// stable for a given ID, MaxRecheckCycles, and HashSalt, whether or not the ID
// is currently tracked.
func (d *Detector) RecheckSlot(id ID) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.recheckSlotLocked(id)
}

func (d *Detector) recheckSlotLocked(id ID) int {
	if rec, ok := d.records[id]; ok {
		return rec.slot
	}
	return slotForID(id, d.cfg.MaxRecheckCycles, d.cfg.HashSalt)
}

// NextRecheck returns the next complete generation in which id's absence is
// scheduled to be evaluated, and the number of complete generations until
// then. The wait is always in [1, MaxRecheckCycles].
func (d *Detector) NextRecheck(id ID) (generation uint64, wait uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()

	slot := d.recheckSlotLocked(id)
	current := -1
	if d.generation > 0 {
		current = int((d.generation - 1) % uint64(d.cfg.MaxRecheckCycles))
	}

	wait = uint64((slot - current + d.cfg.MaxRecheckCycles) % d.cfg.MaxRecheckCycles)
	if wait == 0 {
		wait = uint64(d.cfg.MaxRecheckCycles)
	}
	return d.generation + wait, wait
}

// MaxRecheckCycles returns the configured upper bound between rechecks.
func (d *Detector) MaxRecheckCycles() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cfg.MaxRecheckCycles
}

// DeleteAfter returns the configured number of scheduled misses required for
// deletion.
func (d *Detector) DeleteAfter() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cfg.DeleteAfter
}
