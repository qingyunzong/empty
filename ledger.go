package dataeng

import "sync"

// Differ is a reusable, generation-aware diff engine. It applies the supplied
// options and suppresses events already emitted for a snapshot's Generation.
// Unlike the package-level Diff function, a Differ carries state between calls;
// create a new one for an independent crawl generation.
//
// A Differ is safe for concurrent use.
type Differ struct {
	cfg    diffConfig
	ledger *Ledger
}

// NewDiffer constructs a stateful diff engine. With no options it is
// equivalent to Diff plus a Ledger.
func NewDiffer(options ...Option) *Differ {
	cfg := defaultDiffConfig()
	for _, option := range options {
		if option != nil {
			option(&cfg)
		}
	}
	return &Differ{cfg: cfg, ledger: NewLedger()}
}

// Diff compares snapshots and returns only events new to their crawl
// generation.
func (d *Differ) Diff(oldSnapshot, newSnapshot Snapshot) Result {
	result := diffWithConfig(oldSnapshot, newSnapshot, d.cfg)
	return d.ledger.Record(result)
}

// Compare is an alias for Differ.Diff.
func (d *Differ) Compare(oldSnapshot, newSnapshot Snapshot) Result {
	return d.Diff(oldSnapshot, newSnapshot)
}

// DiffInGeneration forces the comparison into generation before applying
// event suppression.
func (d *Differ) DiffInGeneration(generation string, oldSnapshot, newSnapshot Snapshot) Result {
	oldSnapshot.Generation = generation
	newSnapshot.Generation = generation
	return d.Diff(oldSnapshot, newSnapshot)
}

// ResetGeneration forgets emitted events for generation. An empty generation
// clears all state.
func (d *Differ) ResetGeneration(generation string) {
	d.ledger.Reset(generation)
}

// Ledger suppresses events that have already been emitted for a crawl
// generation. Crawlers frequently compare several snapshot pairs belonging to
// the same generation; the Ledger guarantees that an add, delete or modify for
// a logical block is delivered once, even if later snapshots repeat it.
//
// A Ledger is safe for concurrent use.
type Ledger struct {
	mu   sync.Mutex
	seen map[string]map[string]struct{}
}

// NewLedger returns an empty event ledger.
func NewLedger() *Ledger {
	return &Ledger{seen: make(map[string]map[string]struct{})}
}

// Diff compares snapshots and returns only events not already recorded for the
// snapshot generation.
func (l *Ledger) Diff(oldSnapshot, newSnapshot Snapshot) Result {
	result := Diff(oldSnapshot, newSnapshot)
	return l.Record(result)
}

// DiffInGeneration is like Diff but forces both snapshots into generation. It
// is useful when the crawler stores the generation outside the snapshots.
func (l *Ledger) DiffInGeneration(generation string, oldSnapshot, newSnapshot Snapshot) Result {
	oldSnapshot.Generation = generation
	newSnapshot.Generation = generation
	return l.Diff(oldSnapshot, newSnapshot)
}

// Record filters a result and remembers the events that pass. The generation
// is taken from result.Generation.
func (l *Ledger) Record(result Result) Result {
	filtered := l.Filter(result.Generation, result.Events)
	result.Events = filtered
	return result
}

// Filter returns the events for generation that have not been seen before and
// marks them as emitted.
func (l *Ledger) Filter(generation string, events []Event) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.seen == nil {
		l.seen = make(map[string]map[string]struct{})
	}
	generationSeen := l.seen[generation]
	if generationSeen == nil {
		generationSeen = make(map[string]struct{})
		l.seen[generation] = generationSeen
	}
	out := make([]Event, 0, len(events))
	for _, event := range events {
		if _, ok := generationSeen[event.ID]; ok {
			continue
		}
		generationSeen[event.ID] = struct{}{}
		out = append(out, event)
	}
	return out
}

// Seen reports whether an event ID has already been emitted for generation.
func (l *Ledger) Seen(generation, eventID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.seen[generation][eventID]
	return ok
}

// Reset forgets all events for generation. Passing an empty string clears
// every generation.
func (l *Ledger) Reset(generation string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if generation == "" {
		l.seen = make(map[string]map[string]struct{})
		return
	}
	delete(l.seen, generation)
}

// Generation owns a Ledger for one crawl generation and makes the generation
// identifier explicit at the call site.
type Generation struct {
	ID     string
	ledger *Ledger
}

// NewGeneration returns a generation-scoped diff emitter.
func NewGeneration(id string) *Generation {
	return &Generation{ID: id, ledger: NewLedger()}
}

// Diff compares snapshots within this generation and emits each logical event
// at most once for the lifetime of the Generation value.
func (g *Generation) Diff(oldSnapshot, newSnapshot Snapshot) Result {
	result := g.ledger.DiffInGeneration(g.ID, oldSnapshot, newSnapshot)
	return result
}

// Reset forgets the events already emitted by this generation.
func (g *Generation) Reset() {
	g.ledger.Reset(g.ID)
}
