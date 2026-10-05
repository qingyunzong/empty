// Package tanksim simulates multiple tanks connected by valves with exact
// rational flow rates. Levels are tracked with arbitrary-precision rationals
// (math/big.Rat), threshold crossings trigger valve switches, and empty/full
// boundaries limit flows. All thresholds that fire at the same tick are
// settled together before any valve switches are applied; cascades that
// never let time advance are reported as zero-time loops with evidence.
package tanksim

import (
	"fmt"
	"math/big"
)

// Rat returns the exact rational a/b. b must be non-zero.
func Rat(a, b int64) *big.Rat { return big.NewRat(a, b) }

func cloneRat(x *big.Rat) *big.Rat { return new(big.Rat).Set(x) }

// Tank is a fluid container with a capacity and a current level.
type Tank struct {
	ID       string
	Capacity *big.Rat
	Level    *big.Rat
}

// Valve moves fluid at a constant rational rate while open. From and To are
// tank IDs; an empty From is an unlimited external source, an empty To is an
// external sink.
type Valve struct {
	ID   string
	From string
	To   string
	Rate *big.Rat
	Open bool
}

// CondKind selects what a Trigger watches.
type CondKind int

const (
	CondRising      CondKind = iota // tank level crosses threshold upward
	CondFalling                     // tank level crosses threshold downward
	CondValveOpen                   // valve is open
	CondValveClosed                 // valve is closed
)

// ActKind selects what a Trigger does when it fires.
type ActKind int

const (
	ActOpen ActKind = iota
	ActClose
	ActToggle
)

// Trigger switches a valve when its condition holds. Level conditions are
// edge-triggered: they fire when a time advance carries the level strictly
// across the threshold, or when the condition already holds at simulation
// start. Valve conditions are state-triggered and can cascade within the
// same tick.
type Trigger struct {
	ID        string
	Cond      CondKind
	Tank      string   // CondRising / CondFalling: watched tank
	Threshold *big.Rat // CondRising / CondFalling: threshold level
	Valve     string   // CondValveOpen / CondValveClosed: watched valve
	Act       ActKind
	ActValve  string // valve the action applies to
}

// Event records one settle iteration in which at least one trigger fired.
// All triggers in Fired were settled together and their actions applied
// simultaneously at Time.
type Event struct {
	Time   *big.Rat
	Iter   int      // settle iteration within the tick
	Fired  []string // trigger IDs fired in this iteration
	Levels map[string]*big.Rat
	Valves map[string]bool
}

// Sim is a deterministic, exact-arithmetic tank simulation.
type Sim struct {
	tanks    []*Tank
	tankIdx  map[string]int
	valves   []*Valve
	valveIdx map[string]int
	triggers []*Trigger
	time     *big.Rat
	started  bool
	events   []Event
}

// NewSim validates the configuration and returns a ready simulation.
// All inputs are deep-copied.
func NewSim(tanks []Tank, valves []Valve, triggers []Trigger) (*Sim, error) {
	s := &Sim{
		tankIdx:  map[string]int{},
		valveIdx: map[string]int{},
		time:     new(big.Rat),
	}
	for i, t := range tanks {
		if t.ID == "" {
			return nil, fmt.Errorf("tanksim: tank %d has empty ID", i)
		}
		if _, dup := s.tankIdx[t.ID]; dup {
			return nil, fmt.Errorf("tanksim: duplicate tank ID %q", t.ID)
		}
		if t.Capacity == nil || t.Capacity.Sign() <= 0 {
			return nil, fmt.Errorf("tanksim: tank %q capacity must be positive", t.ID)
		}
		if t.Level == nil || t.Level.Sign() < 0 || t.Level.Cmp(t.Capacity) > 0 {
			return nil, fmt.Errorf("tanksim: tank %q level must be in [0, capacity]", t.ID)
		}
		s.tankIdx[t.ID] = len(s.tanks)
		s.tanks = append(s.tanks, &Tank{ID: t.ID, Capacity: cloneRat(t.Capacity), Level: cloneRat(t.Level)})
	}
	for i, v := range valves {
		if v.ID == "" {
			return nil, fmt.Errorf("tanksim: valve %d has empty ID", i)
		}
		if _, dup := s.valveIdx[v.ID]; dup {
			return nil, fmt.Errorf("tanksim: duplicate valve ID %q", v.ID)
		}
		if v.Rate == nil || v.Rate.Sign() < 0 {
			return nil, fmt.Errorf("tanksim: valve %q rate must be non-negative", v.ID)
		}
		for _, end := range []string{v.From, v.To} {
			if end != "" {
				if _, ok := s.tankIdx[end]; !ok {
					return nil, fmt.Errorf("tanksim: valve %q references unknown tank %q", v.ID, end)
				}
			}
		}
		s.valveIdx[v.ID] = len(s.valves)
		s.valves = append(s.valves, &Valve{ID: v.ID, From: v.From, To: v.To, Rate: cloneRat(v.Rate), Open: v.Open})
	}
	for i, tr := range triggers {
		if tr.ID == "" {
			return nil, fmt.Errorf("tanksim: trigger %d has empty ID", i)
		}
		switch tr.Cond {
		case CondRising, CondFalling:
			ti, ok := s.tankIdx[tr.Tank]
			if !ok {
				return nil, fmt.Errorf("tanksim: trigger %q references unknown tank %q", tr.ID, tr.Tank)
			}
			if tr.Threshold == nil || tr.Threshold.Sign() < 0 || tr.Threshold.Cmp(s.tanks[ti].Capacity) > 0 {
				return nil, fmt.Errorf("tanksim: trigger %q threshold must be in [0, capacity]", tr.ID)
			}
		case CondValveOpen, CondValveClosed:
			if _, ok := s.valveIdx[tr.Valve]; !ok {
				return nil, fmt.Errorf("tanksim: trigger %q references unknown valve %q", tr.ID, tr.Valve)
			}
		default:
			return nil, fmt.Errorf("tanksim: trigger %q has unknown condition kind", tr.ID)
		}
		if _, ok := s.valveIdx[tr.ActValve]; !ok {
			return nil, fmt.Errorf("tanksim: trigger %q acts on unknown valve %q", tr.ID, tr.ActValve)
		}
		switch tr.Act {
		case ActOpen, ActClose, ActToggle:
		default:
			return nil, fmt.Errorf("tanksim: trigger %q has unknown action kind", tr.ID)
		}
		cp := tr
		if tr.Threshold != nil {
			cp.Threshold = cloneRat(tr.Threshold)
		}
		s.triggers = append(s.triggers, &cp)
	}
	return s, nil
}

// Time returns the current simulation time.
func (s *Sim) Time() *big.Rat { return cloneRat(s.time) }

// Level returns the current level of the named tank, or nil if unknown.
func (s *Sim) Level(tankID string) *big.Rat {
	i, ok := s.tankIdx[tankID]
	if !ok {
		return nil
	}
	return cloneRat(s.tanks[i].Level)
}

// ValveOpen reports whether the named valve is open.
func (s *Sim) ValveOpen(id string) bool {
	i, ok := s.valveIdx[id]
	return ok && s.valves[i].Open
}

// Events returns the audit log of trigger firings so far.
func (s *Sim) Events() []Event { return append([]Event(nil), s.events...) }
