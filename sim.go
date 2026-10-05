package tanksim

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// ZeroTimeLoopError reports a trigger cascade that never lets time advance:
// the settle loop returned to a valve configuration it had already visited
// at the same instant. Trace is the evidence: every settle iteration
// executed at that instant, with the fired triggers and resulting states.
type ZeroTimeLoopError struct {
	Time         *big.Rat
	RepeatedIter int // earlier iteration whose valve configuration repeated
	Trace        []Event
	Levels       map[string]*big.Rat
}

func (e *ZeroTimeLoopError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "tanksim: zero-time loop at t=%s: valve configuration repeats settle iteration %d; evidence trace:",
		e.Time.RatString(), e.RepeatedIter)
	for _, ev := range e.Trace {
		fmt.Fprintf(&b, "\n  iter %d fired [%s] -> valves {%s}",
			ev.Iter, strings.Join(ev.Fired, ", "), formatValves(ev.Valves))
	}
	return b.String()
}

func formatValves(m map[string]bool) string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]string, len(ids))
	for i, id := range ids {
		state := "closed"
		if m[id] {
			state = "open"
		}
		parts[i] = id + "=" + state
	}
	return strings.Join(parts, ", ")
}

// Run advances the simulation to the given absolute time with exact,
// event-driven steps: time jumps from one threshold/boundary crossing to the
// next, and each tick is fully settled before time moves on. If a settle
// loops forever at one instant, Run returns a *ZeroTimeLoopError and the
// simulation is left mid-settle for inspection.
func (s *Sim) Run(until *big.Rat) error {
	if until.Cmp(s.time) < 0 {
		return fmt.Errorf("tanksim: cannot run backwards (time %s, until %s)",
			s.time.RatString(), until.RatString())
	}
	if err := s.ensureStarted(); err != nil {
		return err
	}
	for s.time.Cmp(until) < 0 {
		rates, err := s.effectiveRates()
		if err != nil {
			return err
		}
		net := s.netRates(rates)
		dt, ok := s.timeToNextEvent(net)
		remaining := new(big.Rat).Sub(until, s.time)
		if !ok || dt.Cmp(remaining) > 0 {
			crossed := s.advance(remaining, net)
			if len(crossed) > 0 {
				return s.settle(crossed)
			}
			return nil
		}
		crossed := s.advance(dt, net)
		if err := s.settle(crossed); err != nil {
			return err
		}
	}
	return nil
}

// Step advances the simulation by one fixed-size rational step, detecting
// threshold crossings at the end of the step. Repeated Step calls give a
// micro-stepping integrator that converges to the event-driven Run result
// as the step size shrinks.
func (s *Sim) Step(dt *big.Rat) error {
	if dt == nil || dt.Sign() <= 0 {
		return fmt.Errorf("tanksim: step size must be positive")
	}
	if err := s.ensureStarted(); err != nil {
		return err
	}
	rates, err := s.effectiveRates()
	if err != nil {
		return err
	}
	crossed := s.advance(dt, s.netRates(rates))
	return s.settle(crossed)
}

func (s *Sim) ensureStarted() error {
	if s.started {
		return nil
	}
	s.started = true
	return s.settle(s.initialCrossings())
}

// advance moves time forward by dt, updates levels exactly, clamps them to
// [0, capacity], and reports which level triggers were crossed.
func (s *Sim) advance(dt *big.Rat, net []*big.Rat) map[int]bool {
	old := make([]*big.Rat, len(s.tanks))
	for i, tk := range s.tanks {
		old[i] = cloneRat(tk.Level)
		lv := new(big.Rat).Add(tk.Level, new(big.Rat).Mul(net[i], dt))
		if lv.Sign() < 0 {
			lv.SetInt64(0)
		}
		if lv.Cmp(tk.Capacity) > 0 {
			lv.Set(tk.Capacity)
		}
		tk.Level = lv
	}
	s.time.Add(s.time, dt)
	return s.detectCrossings(old)
}

// settle resolves one tick. Each iteration first collects every trigger
// whose condition holds (and whose action would change something), then
// applies all their actions simultaneously. Iterations repeat while valve
// conditions cascade; if a valve configuration repeats, the cascade can
// never let time advance and a *ZeroTimeLoopError is returned.
func (s *Sim) settle(crossed map[int]bool) error {
	start := len(s.events)
	visited := map[string]int{}
	for iter := 0; ; iter++ {
		sig := s.valveSignature()
		if iter == 0 && len(crossed) > 0 {
			sig += "|crossed" // crossings make iteration 0 distinct
		}
		if prev, seen := visited[sig]; seen {
			return &ZeroTimeLoopError{
				Time:         cloneRat(s.time),
				RepeatedIter: prev,
				Trace:        append([]Event(nil), s.events[start:]...),
				Levels:       s.levelsCopy(),
			}
		}
		visited[sig] = iter
		var fired []int
		for ti, tr := range s.triggers {
			if s.triggerActive(ti, tr, crossed) && s.actionChanges(tr) {
				fired = append(fired, ti)
			}
		}
		if len(fired) == 0 {
			return nil
		}
		for _, ti := range fired {
			s.applyAction(s.triggers[ti])
		}
		s.recordEvent(iter, fired)
		crossed = nil
	}
}

func (s *Sim) triggerActive(ti int, tr *Trigger, crossed map[int]bool) bool {
	switch tr.Cond {
	case CondRising, CondFalling:
		return crossed[ti]
	case CondValveOpen:
		return s.valves[s.valveIdx[tr.Valve]].Open
	case CondValveClosed:
		return !s.valves[s.valveIdx[tr.Valve]].Open
	}
	return false
}

func (s *Sim) actionChanges(tr *Trigger) bool {
	v := s.valves[s.valveIdx[tr.ActValve]]
	switch tr.Act {
	case ActOpen:
		return !v.Open
	case ActClose:
		return v.Open
	case ActToggle:
		return true
	}
	return false
}

func (s *Sim) applyAction(tr *Trigger) {
	v := s.valves[s.valveIdx[tr.ActValve]]
	switch tr.Act {
	case ActOpen:
		v.Open = true
	case ActClose:
		v.Open = false
	case ActToggle:
		v.Open = !v.Open
	}
}

// effectiveRates computes the actual per-valve flow rates. Empty tanks
// cannot supply net outflow and full tanks cannot accept net inflow, so
// offending flows are scaled down proportionally (exactly, with rationals)
// and the process iterated to a fixpoint.
func (s *Sim) effectiveRates() ([]*big.Rat, error) {
	rates := make([]*big.Rat, len(s.valves))
	for i, v := range s.valves {
		rates[i] = new(big.Rat)
		if v.Open {
			rates[i].Set(v.Rate)
		}
	}
	maxPasses := 4 * (len(s.tanks) + 1)
	for pass := 0; pass < maxPasses; pass++ {
		changed := false
		for _, tk := range s.tanks {
			in, out := new(big.Rat), new(big.Rat)
			for j, v := range s.valves {
				if v.To == tk.ID {
					in.Add(in, rates[j])
				}
				if v.From == tk.ID {
					out.Add(out, rates[j])
				}
			}
			switch {
			case tk.Level.Sign() == 0 && in.Cmp(out) < 0 && out.Sign() > 0:
				scale := new(big.Rat).Quo(in, out)
				for j, v := range s.valves {
					if v.From == tk.ID {
						rates[j].Mul(rates[j], scale)
					}
				}
				changed = true
			case tk.Level.Cmp(tk.Capacity) == 0 && in.Cmp(out) > 0 && in.Sign() > 0:
				scale := new(big.Rat).Quo(out, in)
				for j, v := range s.valves {
					if v.To == tk.ID {
						rates[j].Mul(rates[j], scale)
					}
				}
				changed = true
			}
		}
		if !changed {
			return rates, nil
		}
	}
	return nil, fmt.Errorf("tanksim: boundary flow limiting did not converge")
}

func (s *Sim) netRates(rates []*big.Rat) []*big.Rat {
	net := make([]*big.Rat, len(s.tanks))
	for i := range net {
		net[i] = new(big.Rat)
	}
	for j, v := range s.valves {
		if v.To != "" {
			net[s.tankIdx[v.To]].Add(net[s.tankIdx[v.To]], rates[j])
		}
		if v.From != "" {
			net[s.tankIdx[v.From]].Sub(net[s.tankIdx[v.From]], rates[j])
		}
	}
	return net
}

// timeToNextEvent returns the exact positive time until the next boundary
// hit or threshold crossing under the current net rates.
func (s *Sim) timeToNextEvent(net []*big.Rat) (*big.Rat, bool) {
	var best *big.Rat
	consider := func(num, den *big.Rat) {
		if num.Sign() <= 0 || den.Sign() <= 0 {
			return
		}
		d := new(big.Rat).Quo(num, den)
		if best == nil || d.Cmp(best) < 0 {
			best = d
		}
	}
	for i, tk := range s.tanks {
		n := net[i]
		if n.Sign() > 0 {
			consider(new(big.Rat).Sub(tk.Capacity, tk.Level), n)
		} else if n.Sign() < 0 {
			consider(cloneRat(tk.Level), new(big.Rat).Neg(n))
		}
	}
	for _, tr := range s.triggers {
		i, ok := s.tankIdx[tr.Tank]
		if !ok {
			continue
		}
		tk, n := s.tanks[i], net[i]
		switch tr.Cond {
		case CondRising:
			if n.Sign() > 0 && tr.Threshold.Cmp(tk.Level) > 0 {
				consider(new(big.Rat).Sub(tr.Threshold, tk.Level), n)
			}
		case CondFalling:
			if n.Sign() < 0 && tr.Threshold.Cmp(tk.Level) < 0 {
				consider(new(big.Rat).Sub(tk.Level, tr.Threshold), new(big.Rat).Neg(n))
			}
		}
	}
	if best == nil {
		return nil, false
	}
	return best, true
}

func (s *Sim) detectCrossings(old []*big.Rat) map[int]bool {
	crossed := map[int]bool{}
	for ti, tr := range s.triggers {
		i, ok := s.tankIdx[tr.Tank]
		if !ok {
			continue
		}
		switch tr.Cond {
		case CondRising:
			if old[i].Cmp(tr.Threshold) < 0 && s.tanks[i].Level.Cmp(tr.Threshold) >= 0 {
				crossed[ti] = true
			}
		case CondFalling:
			if old[i].Cmp(tr.Threshold) > 0 && s.tanks[i].Level.Cmp(tr.Threshold) <= 0 {
				crossed[ti] = true
			}
		}
	}
	return crossed
}

// initialCrossings treats level conditions already satisfied at simulation
// start as crossings, so the initial state settles before time advances.
func (s *Sim) initialCrossings() map[int]bool {
	crossed := map[int]bool{}
	for ti, tr := range s.triggers {
		i, ok := s.tankIdx[tr.Tank]
		if !ok {
			continue
		}
		switch tr.Cond {
		case CondRising:
			if s.tanks[i].Level.Cmp(tr.Threshold) >= 0 {
				crossed[ti] = true
			}
		case CondFalling:
			if s.tanks[i].Level.Cmp(tr.Threshold) <= 0 {
				crossed[ti] = true
			}
		}
	}
	return crossed
}

func (s *Sim) valveSignature() string {
	var b strings.Builder
	for _, v := range s.valves {
		if v.Open {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
	}
	return b.String()
}

func (s *Sim) levelsCopy() map[string]*big.Rat {
	m := make(map[string]*big.Rat, len(s.tanks))
	for _, tk := range s.tanks {
		m[tk.ID] = cloneRat(tk.Level)
	}
	return m
}

func (s *Sim) valvesCopy() map[string]bool {
	m := make(map[string]bool, len(s.valves))
	for _, v := range s.valves {
		m[v.ID] = v.Open
	}
	return m
}

func (s *Sim) recordEvent(iter int, fired []int) {
	ids := make([]string, len(fired))
	for k, ti := range fired {
		ids[k] = s.triggers[ti].ID
	}
	s.events = append(s.events, Event{
		Time:   cloneRat(s.time),
		Iter:   iter,
		Fired:  ids,
		Levels: s.levelsCopy(),
		Valves: s.valvesCopy(),
	})
}
