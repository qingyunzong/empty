package signal

import (
	"fmt"
	"math/big"
)

type compiledSignal struct {
	signal   Signal
	scale    *big.Rat
	offset   *big.Rat
	selector *compiledSignal
	equals   *big.Int
	// positions holds the global frame bit number for each assembled bit.
	positions []int
	// active is true for signals with no gating selector.
	active bool
}

// CompiledPattern is a validated frame pattern ready for decoding.
type CompiledPattern struct {
	FrameID uint32
	Length  int
	signals []*compiledSignal
}

// Compile validates a frame pattern and prepares it for decoding.
//
// It rejects out-of-range or repeated bit positions, malformed rationals,
// invalid or conditional selectors, selector dependency cycles, and signals
// that would overlap whenever they are active together. Selector bit segments
// participate in the overlap checks like every other signal.
func (p Pattern) Compile() (*CompiledPattern, error) {
	if p.Length <= 0 {
		return nil, fmt.Errorf("%w: frame %d length must be positive", ErrConfig, p.FrameID)
	}
	if len(p.Signals) == 0 {
		return nil, fmt.Errorf("%w: frame %d has no signals", ErrConfig, p.FrameID)
	}

	compiled := make([]*compiledSignal, len(p.Signals))
	byName := make(map[string]*compiledSignal, len(p.Signals))
	for i, sig := range p.Signals {
		if sig.Name == "" {
			return nil, fmt.Errorf("%w: frame %d signal %d has no name", ErrConfig, p.FrameID, i)
		}
		if _, exists := byName[sig.Name]; exists {
			return nil, fmt.Errorf("%w: frame %d duplicate signal name %q", ErrConfig, p.FrameID, sig.Name)
		}

		scale, err := resolveRational(sig.Scale, true)
		if err != nil {
			return nil, fmt.Errorf("%w: signal %q scale", err, sig.Name)
		}
		offset, err := resolveRational(sig.Offset, false)
		if err != nil {
			return nil, fmt.Errorf("%w: signal %q offset", err, sig.Name)
		}

		cs := &compiledSignal{
			signal:    sig,
			scale:     scale,
			offset:    offset,
			active:    sig.Selector == "",
			positions: make([]int, 0, len(sig.Bits)),
			equals:    new(big.Int).SetUint64(sig.Equals),
		}
		compiled[i] = cs
		byName[sig.Name] = cs
	}

	// Resolve and check every bit segment first so later checks can rely on
	// the positions being populated and unique within each signal.
	maxBit := p.Length*8 - 1
	seen := make(map[int]bool)
	for _, cs := range compiled {
		if len(cs.signal.Bits) == 0 {
			return nil, fmt.Errorf("%w: signal %q has no bits", ErrConfig, cs.signal.Name)
		}
		clear(seen)
		for _, bit := range cs.signal.Bits {
			if bit.InByte > 7 {
				return nil, fmt.Errorf("%w: signal %q byte offset %d", ErrOutOfRange, cs.signal.Name, bit.InByte)
			}
			pos := bit.Position()
			if bit.Index < 0 || pos > maxBit {
				return nil, fmt.Errorf("%w: signal %q bit (byte %d, bit %d)", ErrOutOfRange, cs.signal.Name, bit.Index, bit.InByte)
			}
			if seen[pos] {
				return nil, fmt.Errorf("%w: signal %q repeats bit %d", ErrDuplicateBits, cs.signal.Name, pos)
			}
			seen[pos] = true
			cs.positions = append(cs.positions, pos)
		}
	}

	// Resolve selector references: selectors must exist and be unsigned.
	for _, cs := range compiled {
		if cs.signal.Selector == "" {
			continue
		}
		sel, ok := byName[cs.signal.Selector]
		if !ok {
			return nil, fmt.Errorf("%w: signal %q references missing selector %q", ErrSelector, cs.signal.Name, cs.signal.Selector)
		}
		if sel.signal.Signed {
			return nil, fmt.Errorf("%w: selector %q must be unsigned", ErrSelector, sel.signal.Name)
		}
		cs.selector = sel
	}

	if err := checkCycles(compiled); err != nil {
		return nil, err
	}

	// Selectors must be unconditionally active, i.e. they cannot themselves be
	// gated by another selector.
	for _, cs := range compiled {
		if cs.selector != nil && cs.selector.selector != nil {
			return nil, fmt.Errorf("%w: selector %q is gated by %q", ErrSelector, cs.selector.signal.Name, cs.selector.selector.signal.Name)
		}
	}

	if err := checkOverlap(compiled); err != nil {
		return nil, err
	}

	return &CompiledPattern{
		FrameID: p.FrameID,
		Length:  p.Length,
		signals: compiled,
	}, nil
}

// resolveRational converts a declared rational, treating the unset zero value
// as the identity: scale defaults to 1 and offset to 0. An explicitly nonzero
// numerator with a zero denominator remains invalid.
func resolveRational(r Rational, defaultOne bool) (*big.Rat, error) {
	if r.Den == 0 {
		if r.Num != 0 {
			return nil, ErrRational
		}
		if defaultOne {
			return big.NewRat(1, 1), nil
		}
		return big.NewRat(0, 1), nil
	}
	return big.NewRat(r.Num, r.Den), nil
}

// checkCycles rejects any cycle in the signal -> selector dependency graph.
func checkCycles(signals []*compiledSignal) error {
	const (
		unvisited = 0
		onStack   = 1
		done      = 2
	)
	state := make(map[*compiledSignal]int, len(signals))

	var visit func(cs *compiledSignal) error
	visit = func(cs *compiledSignal) error {
		switch state[cs] {
		case onStack:
			return fmt.Errorf("%w: signal %q participates in a selector loop", ErrCycle, cs.signal.Name)
		case done:
			return nil
		}
		state[cs] = onStack
		if cs.selector != nil {
			if err := visit(cs.selector); err != nil {
				return err
			}
		}
		state[cs] = done
		return nil
	}

	for _, cs := range signals {
		if state[cs] == unvisited {
			if err := visit(cs); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkOverlap rejects bit segments shared by signals that can be active
// together. Two gated signals may share bits only when they use the same
// selector with different required values.
func checkOverlap(signals []*compiledSignal) error {
	ownership := make(map[int][]*compiledSignal)
	for _, cs := range signals {
		for _, pos := range cs.positions {
			ownership[pos] = append(ownership[pos], cs)
		}
	}

	for pos, owners := range ownership {
		if len(owners) < 2 {
			continue
		}
		for i := 0; i < len(owners); i++ {
			for j := i + 1; j < len(owners); j++ {
				if !coactivatable(owners[i], owners[j]) {
					return fmt.Errorf("%w: signals %q and %q share bit %d",
						ErrOverlap, owners[i].signal.Name, owners[j].signal.Name, pos)
				}
			}
		}
	}
	return nil
}

// coactivatable reports whether two signals can ever be active at the same
// time. Signals gated by the same selector with different values are mutually
// exclusive; every other combination can overlap.
func coactivatable(a, b *compiledSignal) bool {
	if a.selector == nil || b.selector == nil {
		return false
	}
	if a.selector != b.selector {
		return false
	}
	return a.equals.Cmp(b.equals) != 0
}
