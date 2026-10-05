package petri

import "fmt"

// Closure is the deduplicated set of markings reached by a breadth-first
// exploration, in BFS discovery order, with parent pointers so any state
// can be traced back to the initial marking.
type Closure struct {
	Initial Marking
	States  []Marking
	index   map[Marking]int
	parent  []int // parent state index, -1 for the root
	parentT []int // transition taken from the parent
}

// Contains reports whether m is part of the closure.
func (c *Closure) Contains(m Marking) bool {
	_, ok := c.index[m]
	return ok
}

// Len returns the number of distinct reachable markings.
func (c *Closure) Len() int { return len(c.States) }

// Path reconstructs the transition sequence from the initial marking to
// the given state of the closure.
func (c *Closure) Path(m Marking) ([]int, bool) {
	i, ok := c.index[m]
	if !ok {
		return nil, false
	}
	var rev []int
	for i >= 0 {
		if c.parent[i] < 0 {
			break
		}
		rev = append(rev, c.parentT[i])
		i = c.parent[i]
	}
	for l, r := 0, len(rev)-1; l < r; l, r = l+1, r-1 {
		rev[l], rev[r] = rev[r], rev[l]
	}
	return rev, true
}

// Certificate witnesses reachability of a target marking: a shortest
// transition sequence plus the intermediate markings.
type Certificate struct {
	Found  bool
	Target Marking
	Path   []int     // transition indices, shortest
	Trace  []Marking // markings from initial to target, len(Path)+1
}

// Verify replays the certificate on the net and checks that it ends at
// the target marking.
func (c *Certificate) Verify(n *Net, initial Marking) error {
	if !c.Found {
		return fmt.Errorf("petri: certificate claims target unreachable")
	}
	if len(c.Trace) != len(c.Path)+1 {
		return fmt.Errorf("petri: trace length %d, want %d", len(c.Trace), len(c.Path)+1)
	}
	m := initial
	if c.Trace[0] != m {
		return fmt.Errorf("petri: trace does not start at initial marking")
	}
	for i, t := range c.Path {
		next, ok := n.Fire(m, t)
		if !ok {
			return fmt.Errorf("petri: step %d: transition %q not fireable", i, n.Transitions[t].Name)
		}
		m = next
		if c.Trace[i+1] != m {
			return fmt.Errorf("petri: step %d: trace mismatch", i)
		}
	}
	if m != c.Target {
		return fmt.Errorf("petri: certificate ends at %v, want %v", m, c.Target)
	}
	return nil
}

// Reach explores the state space breadth-first from initial. If target is
// non-nil and reachable, it returns a shortest-path certificate together
// with the partial closure explored so far; if target is nil or
// unreachable, it returns the full closure and a certificate with
// Found=false. States are deduplicated via a hash map.
func (n *Net) Reach(initial Marking, target *Marking) (*Closure, *Certificate) {
	c := &Closure{
		Initial: initial,
		States:  []Marking{initial},
		index:   map[Marking]int{initial: 0},
		parent:  []int{-1},
		parentT: []int{-1},
	}
	cert := &Certificate{}
	if target != nil {
		cert.Target = *target
	}
	if target != nil && initial == *target {
		cert.Found = true
		cert.Trace = []Marking{initial}
		return c, cert
	}
	for head := 0; head < len(c.States); head++ {
		m := c.States[head]
		for _, f := range n.Fireable(m) {
			if _, seen := c.index[f.Next]; seen {
				continue
			}
			c.index[f.Next] = len(c.States)
			c.States = append(c.States, f.Next)
			c.parent = append(c.parent, head)
			c.parentT = append(c.parentT, f.Transition)
			if target != nil && f.Next == *target {
				path, _ := c.Path(f.Next)
				cert.Found = true
				cert.Path = path
				cert.Trace = make([]Marking, 0, len(path)+1)
				cur := initial
				cert.Trace = append(cert.Trace, cur)
				for _, t := range path {
					cur, _ = n.Fire(cur, t)
					cert.Trace = append(cert.Trace, cur)
				}
				return c, cert
			}
		}
	}
	return c, cert
}

// NaiveReach is the deliberately unsophisticated baseline: breadth-first
// search whose visited set is a plain slice scanned linearly. It computes
// the same closure and shortest distances as Reach and exists to
// cross-check them.
func (n *Net) NaiveReach(initial Marking, target *Marking) (states []Marking, dist map[[MaxPlaces]uint8]int) {
	contains := func(ms []Marking, m Marking) bool {
		for _, x := range ms {
			if x == m {
				return true
			}
		}
		return false
	}
	states = []Marking{initial}
	dist = map[[MaxPlaces]uint8]int{initial: 0}
	for head := 0; head < len(states); head++ {
		m := states[head]
		for _, f := range n.Fireable(m) {
			if contains(states, f.Next) {
				continue
			}
			states = append(states, f.Next)
			dist[f.Next] = dist[m] + 1
		}
	}
	return states, dist
}

// EnumerateIndependently is a deliberately separate implementation of
// state enumeration used to cross-check Closure: a fixpoint computation
// over a set, with no queue and no shared code with Reach.
func (n *Net) EnumerateIndependently(initial Marking) map[Marking]bool {
	reached := map[Marking]bool{initial: true}
	for changed := true; changed; {
		changed = false
		for m := range reached {
			for _, f := range n.Fireable(m) {
				if !reached[f.Next] {
					reached[f.Next] = true
					changed = true
				}
			}
		}
	}
	return reached
}
