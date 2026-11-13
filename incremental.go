package dataeng

// MaxStatus describes how a freshly observed MAX(id) compares with the
// previous observation.
type MaxStatus uint8

const (
	// MaxAdvanced means MAX(id) increased.
	MaxAdvanced MaxStatus = iota
	// MaxUnchanged means MAX(id) did not move. Low-key inserts are invisible
	// in this case.
	MaxUnchanged
	// MaxRegressed means MAX(id) moved backwards. This may be a deletion of
	// the highest rows or allocator wraparound/reuse; MAX alone cannot tell.
	MaxRegressed
)

// MaxObservation is the result of observing MAX(id).
type MaxObservation struct {
	Previous Key
	Current  Key
	High     Key
	Status   MaxStatus

	// BelowHigh is true when Current is below the highest value ever observed.
	BelowHigh bool
	// PossibleWrapOrReuse is true on regression. It deliberately does not
	// claim that a wrap occurred: deleting the top rows has the same MAX.
	PossibleWrapOrReuse bool
	// LowKeyPossible is always true for a mutable table. A manual insert below
	// High changes neither MAX nor any other MAX-derived signal.
	LowKeyPossible bool
	// ChangeLogRequired is always true. Even an advancing MAX(id) cannot see
	// a manually inserted low key or a wrapped allocator, so MAX is not a
	// completeness proof.
	ChangeLogRequired bool
}

// MaxWatch tracks observed MAX(id) values without pretending that MAX is an
// authoritative change stream.
type MaxWatch struct {
	last Key
	high Key
}

// NewMaxWatch creates a watcher initialized with the current MAX(id).
func NewMaxWatch(initial Key) (*MaxWatch, error) {
	if initial < 0 {
		return nil, ErrInvalidCeiling
	}
	return &MaxWatch{last: initial, high: initial}, nil
}

// Observe records a new MAX(id). The returned observation always requires
// change-log coverage for completeness.
func (w *MaxWatch) Observe(current Key) (MaxObservation, error) {
	if current < 0 {
		return MaxObservation{}, ErrInvalidCeiling
	}
	previous := w.last
	status := MaxUnchanged
	switch {
	case current > previous:
		status = MaxAdvanced
	case current < previous:
		status = MaxRegressed
	}
	if current > w.high {
		w.high = current
	}
	w.last = current

	return MaxObservation{
		Previous:            previous,
		Current:             current,
		High:                w.high,
		Status:              status,
		BelowHigh:           current < w.high,
		PossibleWrapOrReuse: status == MaxRegressed,
		LowKeyPossible:      true,
		ChangeLogRequired:   true,
	}, nil
}

// High returns the largest MAX(id) observed so far.
func (w *MaxWatch) High() Key { return w.high }

// KeyClass classifies a key observed while reading a generation.
type KeyClass uint8

const (
	// KeyCurrent belongs to the generation being scanned.
	KeyCurrent KeyClass = iota
	// KeyNextGeneration is above the fixed ceiling and must be left for the
	// next generation.
	KeyNextGeneration
	// KeyLow is at or below the generation's exclusive lower bound. It can
	// only be explained by a low-key insert, allocator reuse/wrap, or a
	// partially applied change log; it must be reconciled from the log.
	KeyLow
	// KeyOutOfOrder is inside the interval but not greater than the highest
	// key already seen. A keyset scan should not emit it in order; treat it
	// as a duplication/wrap signal and reconcile it.
	KeyOutOfOrder
)

// KeyGuard classifies keys observed during a single generation scan. It never
// silently absorbs a low or regressing key.
type KeyGuard struct {
	snapshot Snapshot
	high     Cursor
	anomaly  bool
}

// NewKeyGuard creates a guard for s.
func NewKeyGuard(s Snapshot) *KeyGuard { return &KeyGuard{snapshot: s} }

// Observe classifies k and records an anomaly when the key cannot belong to a
// monotonically increasing keyset scan.
func (g *KeyGuard) Observe(k Key) KeyClass {
	if !g.snapshot.Contains(k) {
		if k > g.snapshot.ceiling {
			return KeyNextGeneration
		}
		g.anomaly = true
		return KeyLow
	}
	if g.high.Set && k <= g.high.Key {
		g.anomaly = true
		return KeyOutOfOrder
	}
	g.high = After(k)
	return KeyCurrent
}

// NeedsCompensation reports whether a low or out-of-order key was observed.
func (g *KeyGuard) NeedsCompensation() bool { return g.anomaly }
