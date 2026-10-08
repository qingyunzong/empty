package rescheck

import (
	"fmt"
	"sort"
	"strings"
)

// Status is the per-variable abstract state. The domain is finite:
// with n variables there are at most 4^n concrete abstract states.
type Status int

const (
	Empty    Status = iota // no resource ever bound (or fully moved out before init)
	Alive                  // holds a live resource; must be consumed exactly once
	Moved                  // resource was moved out; variable is dead
	Consumed               // resource was consumed; variable is dead
)

func (s Status) String() string {
	switch s {
	case Empty:
		return "empty"
	case Alive:
		return "alive"
	case Moved:
		return "moved"
	case Consumed:
		return "consumed"
	}
	return "?"
}

// State is one abstract program state plus a witness path reaching it.
type State struct {
	Vars map[string]Status
	Path []string
}

func (s *State) key() string {
	names := make([]string, 0, len(s.Vars))
	for n := range s.Vars {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, n := range names {
		fmt.Fprintf(&b, "%s=%d;", n, s.Vars[n])
	}
	return b.String()
}

func (s *State) clone(step string) *State {
	ns := &State{Vars: make(map[string]Status, len(s.Vars))}
	for k, v := range s.Vars {
		ns.Vars[k] = v
	}
	ns.Path = make([]string, len(s.Path), len(s.Path)+1)
	copy(ns.Path, s.Path)
	if step != "" {
		ns.Path = append(ns.Path, step)
	}
	return ns
}

// StateSet is a mergeable set of abstract states keyed by state
// identity; insertion order is kept for deterministic iteration.
type StateSet struct {
	states map[string]*State
	order  []string
}

func NewStateSet() *StateSet {
	return &StateSet{states: map[string]*State{}}
}

// Add merges s into the set; the first witness path for a state wins.
func (ss *StateSet) Add(s *State) {
	k := s.key()
	if _, ok := ss.states[k]; ok {
		return
	}
	ss.states[k] = s
	ss.order = append(ss.order, k)
}

// Union returns a new set containing both sets' states.
func (ss *StateSet) Union(other *StateSet) *StateSet {
	out := NewStateSet()
	for _, k := range ss.order {
		out.Add(ss.states[k])
	}
	for _, k := range other.order {
		out.Add(other.states[k])
	}
	return out
}

// SubsetOf reports whether every state of ss is already in other.
func (ss *StateSet) SubsetOf(other *StateSet) bool {
	for k := range ss.states {
		if _, ok := other.states[k]; !ok {
			return false
		}
	}
	return true
}

// States returns states in deterministic (insertion) order.
func (ss *StateSet) States() []*State {
	out := make([]*State, 0, len(ss.order))
	for _, k := range ss.order {
		out = append(out, ss.states[k])
	}
	return out
}

func (ss *StateSet) cloneWithStep(step string) *StateSet {
	out := NewStateSet()
	for _, s := range ss.States() {
		out.Add(s.clone(step))
	}
	return out
}

// Violation is a single resource-protocol breach with its witness path.
type Violation struct {
	Kind string // invalid-consume, invalid-move, leak-overwrite, leak-at-exit, leak-at-throw
	Var  string
	Path []string
}

func (v Violation) String() string {
	return fmt.Sprintf("%s of %q (path: %s)", v.Kind, v.Var, strings.Join(v.Path, " -> "))
}

// Checker runs the analysis and collects violations.
type Checker struct {
	Violations []Violation
	seen       map[string]bool
}

// Check analyzes prog and returns all violations found.
func Check(prog Stmt) []Violation {
	c := &Checker{seen: map[string]bool{}}
	init := NewStateSet()
	init.Add(&State{Vars: map[string]Status{}})
	out := c.exec(prog, init)
	for _, s := range out.States() {
		c.checkLive(s, "leak-at-exit", "exit")
	}
	return c.Violations
}

func (c *Checker) report(kind, v string, s *State) {
	// Deduplicate: loop fixpoint iterations re-visit identical states.
	sig := kind + "|" + v + "|" + s.key()
	if c.seen[sig] {
		return
	}
	c.seen[sig] = true
	c.Violations = append(c.Violations, Violation{Kind: kind, Var: v, Path: s.Path})
}

func (c *Checker) checkLive(s *State, kind, step string) {
	ns := s.clone(step)
	names := make([]string, 0, len(ns.Vars))
	for n := range ns.Vars {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if ns.Vars[n] == Alive {
			c.report(kind, n, ns)
		}
	}
}

// exec interprets s over the input set and returns the output set.
func (c *Checker) exec(s Stmt, in *StateSet) *StateSet {
	switch n := s.(type) {
	case Seq:
		cur := in
		for _, sub := range n {
			cur = c.exec(sub, cur)
		}
		return cur

	case If:
		t := c.exec(n.Then, in.cloneWithStep("then"))
		e := c.exec(n.Else, in.cloneWithStep("else"))
		return t.Union(e) // merge point

	case While:
		// Fixpoint over the finite state domain:
		// head_{k+1} = head_k ∪ exec(body, head_k), start head_0 = in.
		head := in.cloneWithStep("enter-loop")
		for i := 0; ; i++ {
			after := c.exec(n.Body, head.cloneWithStep(fmt.Sprintf("iter-%d", i+1)))
			if after.SubsetOf(head) {
				break
			}
			head = head.Union(after)
		}
		return head.cloneWithStep("exit-loop")

	case New:
		out := NewStateSet()
		for _, st := range in.States() {
			ns := st.clone("new " + n.Name)
			if ns.Vars[n.Name] == Alive {
				c.report("leak-overwrite", n.Name, ns)
			}
			ns.Vars[n.Name] = Alive
			out.Add(ns)
		}
		return out

	case Move:
		out := NewStateSet()
		for _, st := range in.States() {
			ns := st.clone(fmt.Sprintf("move %s=%s", n.Dst, n.Src))
			if ns.Vars[n.Src] != Alive {
				c.report("invalid-move", n.Src, ns)
				out.Add(ns)
				continue
			}
			if n.Dst != n.Src && ns.Vars[n.Dst] == Alive {
				c.report("leak-overwrite", n.Dst, ns)
			}
			ns.Vars[n.Dst] = Alive
			ns.Vars[n.Src] = Moved // move invalidates the source
			out.Add(ns)
		}
		return out

	case Consume:
		out := NewStateSet()
		for _, st := range in.States() {
			ns := st.clone("consume " + n.Name)
			if ns.Vars[n.Name] != Alive {
				c.report("invalid-consume", n.Name, ns)
			}
			ns.Vars[n.Name] = Consumed
			out.Add(ns)
		}
		return out

	case Throw:
		for _, st := range in.States() {
			c.checkLive(st, "leak-at-throw", "throw")
		}
		return NewStateSet() // exceptional exit: no continuation
	}
	panic(fmt.Sprintf("unhandled statement %T", s))
}
