// Package tanksim simulates a network of water tanks with rational flow
// rates, threshold-triggered valves, and empty/full boundary clamping.
//
// All arithmetic uses math/big.Rat, so results are exact fractions.
//
// Tick semantics: one Tick(dt) advances time by dt (a rational). First the
// flow phase moves water through every open valve, clamped by empty/full
// boundaries. Then the settle phase evaluates ALL triggers against the same
// post-flow state and applies the resulting valve switches simultaneously.
// Switching may enable further triggers; those are evaluated in further
// zero-time rounds (time does not advance). If a valve-state configuration
// repeats during settling, a ZeroTimeLoopError is returned with the full
// evidence chain.
package tanksim

import (
	"fmt"
	"math/big"
	"strings"
)

// Rat is a helper to build an exact rational a/b.
func Rat(a, b int64) *big.Rat { return big.NewRat(a, b) }

// CmpOp is a comparison operator for level conditions.
type CmpOp int

const (
	// Ge fires when level >= Value.
	Ge CmpOp = iota
	// Le fires when level <= Value.
	Le
)

// Tank is a water tank. Capacity == nil means unbounded.
type Tank struct {
	Name     string
	Capacity *big.Rat
	Level    *big.Rat
}

// Free returns the remaining capacity, or nil if unbounded.
func (t *Tank) Free() *big.Rat {
	if t.Capacity == nil {
		return nil
	}
	return new(big.Rat).Sub(t.Capacity, t.Level)
}

// Valve moves water From one tank To another at up to Rate per unit time.
// From == -1 means an inexhaustible source; To == -1 means a drain.
type Valve struct {
	Name string
	From int
	To   int
	Rate *big.Rat
	Open bool
}

// Condition gates a Trigger. Tank >= 0 adds a level comparison;
// Valve >= 0 adds a valve-state comparison. Both must hold when set.
type Condition struct {
	Tank      int
	Op        CmpOp
	Value     *big.Rat
	Valve     int
	ValveOpen bool
}

// Trigger switches a valve when its Condition holds.
type Trigger struct {
	Name    string
	Cond    Condition
	Valve   int
	SetOpen bool
}

// Sim is the whole system under simulation.
type Sim struct {
	Tanks     []*Tank
	Valves    []*Valve
	Triggers  []*Trigger
	TickCount int64
}

// SettleStep is one zero-time round of the settle phase: the valve-state
// signature observed and the triggers that fired in that round.
type SettleStep struct {
	State string
	Fired []string
}

// ZeroTimeLoopError reports that settling re-entered a previously seen
// valve-state configuration without time advancing. Steps is the evidence:
// every settle round, in order, with the triggers that fired.
type ZeroTimeLoopError struct {
	Tick       int64
	Steps      []SettleStep
	CycleStart int // index into Steps where the repeated state first appeared
}

func (e *ZeroTimeLoopError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "zero-time loop at tick %d: valve states cycle (period %d, starts at round %d)\n",
		e.Tick, len(e.Steps)-e.CycleStart, e.CycleStart)
	for i, s := range e.Steps {
		marker := "  "
		if i >= e.CycleStart {
			marker = "* "
		}
		fmt.Fprintf(&b, "%sround %d state=%s fired=[%s]\n", marker, i, s.State, strings.Join(s.Fired, ", "))
	}
	return b.String()
}

// conditionHolds reports whether c holds in the current state.
func (s *Sim) conditionHolds(c Condition) bool {
	if c.Tank >= 0 {
		cmp := s.Tanks[c.Tank].Level.Cmp(c.Value)
		if c.Op == Ge && cmp < 0 {
			return false
		}
		if c.Op == Le && cmp > 0 {
			return false
		}
	}
	if c.Valve >= 0 && s.Valves[c.Valve].Open != c.ValveOpen {
		return false
	}
	return true
}

// valveSignature encodes the open/closed bitmap of all valves.
func (s *Sim) valveSignature() string {
	var b strings.Builder
	for _, v := range s.Valves {
		if v.Open {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
	}
	return b.String()
}

// flow moves water for one tick of duration dt. Valves are processed in
// definition order; each flow is clamped by the source level (empty
// boundary) and the destination free capacity (full boundary).
func (s *Sim) flow(dt *big.Rat) {
	for _, v := range s.Valves {
		if !v.Open || v.Rate.Sign() <= 0 {
			continue
		}
		flow := new(big.Rat).Mul(v.Rate, dt)
		if v.From >= 0 {
			if lvl := s.Tanks[v.From].Level; flow.Cmp(lvl) > 0 {
				flow = new(big.Rat).Set(lvl)
			}
		}
		if v.To >= 0 {
			if free := s.Tanks[v.To].Free(); free != nil && flow.Cmp(free) > 0 {
				flow = free
			}
		}
		if flow.Sign() <= 0 {
			continue
		}
		if v.From >= 0 {
			s.Tanks[v.From].Level.Sub(s.Tanks[v.From].Level, flow)
		}
		if v.To >= 0 {
			s.Tanks[v.To].Level.Add(s.Tanks[v.To].Level, flow)
		}
	}
}

// settle evaluates all triggers against the same state and applies the
// switches simultaneously, repeating in zero time until quiescent.
func (s *Sim) settle() error {
	seen := map[string]int{}
	var steps []SettleStep
	for {
		sig := s.valveSignature()
		if start, ok := seen[sig]; ok {
			return &ZeroTimeLoopError{Tick: s.TickCount, Steps: steps, CycleStart: start}
		}
		seen[sig] = len(steps)

		type sw struct {
			valve int
			open  bool
		}
		var fired []string
		var switches []sw
		// Evaluate every trigger against the pre-switch state.
		for _, tr := range s.Triggers {
			if s.conditionHolds(tr.Cond) && s.Valves[tr.Valve].Open != tr.SetOpen {
				fired = append(fired, tr.Name)
				switches = append(switches, sw{tr.Valve, tr.SetOpen})
			}
		}
		if len(switches) == 0 {
			return nil
		}
		steps = append(steps, SettleStep{State: sig, Fired: fired})
		// Apply all switches simultaneously.
		for _, w := range switches {
			s.Valves[w.valve].Open = w.open
		}
	}
}

// Tick advances the simulation by dt: flow phase, then zero-time settling.
func (s *Sim) Tick(dt *big.Rat) error {
	s.TickCount++
	s.flow(dt)
	return s.settle()
}

// Run advances n ticks of duration dt, stopping at the first error.
func (s *Sim) Run(n int, dt *big.Rat) error {
	for i := 0; i < n; i++ {
		if err := s.Tick(dt); err != nil {
			return err
		}
	}
	return nil
}
