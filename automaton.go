package rulecheck

import (
	"fmt"
	"strconv"
	"strings"
)

// Automaton is a deterministic symbolic automaton over path segments. The
// alphabet is partitioned into classes: one class per literal segment seen in
// the rule set, plus a final "other" class covering every segment that is not
// one of those literals. Transition tables are total (a sink state is used),
// which makes complementation and product construction straightforward.
//
// The structure is fully exported so compiled rules can be inspected.
type Automaton struct {
	Literals []string
	Start    int
	Trans    [][]int
	Accept   []bool

	litIndex map[string]int
	other    string
}

func (a *Automaton) otherClass() int { return len(a.Literals) }

// NumClasses returns the number of symbolic classes (literals + other).
func (a *Automaton) NumClasses() int { return len(a.Literals) + 1 }

// NumStates returns the number of DFA states.
func (a *Automaton) NumStates() int { return len(a.Trans) }

func (a *Automaton) classOf(seg string) int {
	if i, ok := a.litIndex[seg]; ok {
		return i
	}
	return a.otherClass()
}

// ClassName names a class for inspection: the literal itself or "<other>".
func (a *Automaton) ClassName(class int) string {
	if class == a.otherClass() {
		return "<other>"
	}
	return a.Literals[class]
}

// Match runs the automaton over concrete path segments.
func (a *Automaton) Match(segs []string) bool {
	s := a.Start
	for _, seg := range segs {
		s = a.Trans[s][a.classOf(seg)]
	}
	return a.Accept[s]
}

// String renders the automaton as a human-readable transition table.
func (a *Automaton) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "start=%d states=%d literals=%v\n", a.Start, a.NumStates(), a.Literals)
	for s := range a.Trans {
		mark := " "
		if a.Accept[s] {
			mark = "*"
		}
		fmt.Fprintf(&b, "%s q%d:", mark, s)
		for c, next := range a.Trans[s] {
			fmt.Fprintf(&b, " %s->q%d", a.ClassName(c), next)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func newOtherRepr(lits []string) string {
	repr := "other"
	for {
		clash := false
		for _, l := range lits {
			if l == repr {
				clash = true
				break
			}
		}
		if !clash {
			return repr
		}
		repr = "_" + repr
	}
}

func newLitIndex(lits []string) map[string]int {
	m := make(map[string]int, len(lits))
	for i, l := range lits {
		m[l] = i
	}
	return m
}

// nfaTrans is an NFA transition; lit == "" means "any segment".
type nfaTrans struct {
	from, to int
	lit      string
}

// compileGlob compiles a glob into an Automaton over the given literal
// alphabet via NFA subset construction.
func compileGlob(g glob, lits []string) *Automaton {
	n := len(g.segs) + 1
	var trs []nfaTrans
	eps := map[int][]int{}
	for i, s := range g.segs {
		switch s.kind {
		case segLiteral:
			trs = append(trs, nfaTrans{from: i, to: i + 1, lit: s.lit})
		case segStar:
			trs = append(trs, nfaTrans{from: i, to: i + 1})
		case segGlobstar:
			trs = append(trs, nfaTrans{from: i, to: i}) // consume one, stay
			eps[i] = append(eps[i], i+1)                // or consume zero
		}
	}
	acceptState := n - 1

	byFrom := make(map[int][]nfaTrans)
	for _, t := range trs {
		byFrom[t.from] = append(byFrom[t.from], t)
	}
	closure := func(set map[int]bool) []int {
		stack := make([]int, 0, len(set))
		for s := range set {
			stack = append(stack, s)
		}
		for len(stack) > 0 {
			s := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, d := range eps[s] {
				if !set[d] {
					set[d] = true
					stack = append(stack, d)
				}
			}
		}
		out := make([]int, 0, len(set))
		for s := range set {
			out = append(out, s)
		}
		sortInts(out)
		return out
	}

	a := &Automaton{Literals: lits, litIndex: newLitIndex(lits), other: newOtherRepr(lits)}
	nclass := a.NumClasses()
	ids := map[string]int{}
	var sets [][]int
	addSet := func(set []int) int {
		key := setKey(set)
		if id, ok := ids[key]; ok {
			return id
		}
		id := len(sets)
		ids[key] = id
		sets = append(sets, set)
		a.Trans = append(a.Trans, make([]int, nclass))
		acc := false
		for _, s := range set {
			if s == acceptState {
				acc = true
				break
			}
		}
		a.Accept = append(a.Accept, acc)
		return id
	}

	a.Start = addSet(closure(map[int]bool{0: true}))
	for cur := 0; cur < len(sets); cur++ {
		set := sets[cur]
		for class := 0; class < nclass; class++ {
			next := map[int]bool{}
			for _, s := range set {
				for _, t := range byFrom[s] {
					if class == a.otherClass() {
						if t.lit == "" {
							next[t.to] = true
						}
					} else if t.lit == "" || t.lit == lits[class] {
						next[t.to] = true
					}
				}
			}
			a.Trans[cur][class] = addSet(closure(next))
		}
	}
	return a
}

// product builds the synchronous product of the given automata (which must
// share the same literal alphabet). The accept predicate decides which
// combinations of component acceptance bits are accepting.
func product(ams []*Automaton, accept func(accs []bool) bool) *Automaton {
	lits := ams[0].Literals
	a := &Automaton{Literals: lits, litIndex: newLitIndex(lits), other: newOtherRepr(lits)}
	nclass := a.NumClasses()

	keyOf := func(t []int) string {
		parts := make([]string, len(t))
		for i, v := range t {
			parts[i] = strconv.Itoa(v)
		}
		return strings.Join(parts, ",")
	}
	ids := map[string]int{}
	var tuples [][]int
	add := func(t []int) int {
		key := keyOf(t)
		if id, ok := ids[key]; ok {
			return id
		}
		id := len(tuples)
		ids[key] = id
		tuples = append(tuples, t)
		a.Trans = append(a.Trans, make([]int, nclass))
		accs := make([]bool, len(ams))
		for i, am := range ams {
			accs[i] = am.Accept[t[i]]
		}
		a.Accept = append(a.Accept, accept(accs))
		return id
	}

	start := make([]int, len(ams))
	for i, am := range ams {
		start[i] = am.Start
	}
	a.Start = add(start)
	for cur := 0; cur < len(tuples); cur++ {
		t := tuples[cur]
		for class := 0; class < nclass; class++ {
			next := make([]int, len(ams))
			for i, am := range ams {
				next[i] = am.Trans[t[i]][class]
			}
			a.Trans[cur][class] = add(next)
		}
	}
	return a
}

// intersect returns an automaton accepting the intersection of the inputs.
func intersect(ams ...*Automaton) *Automaton {
	return product(ams, func(accs []bool) bool {
		for _, ok := range accs {
			if !ok {
				return false
			}
		}
		return true
	})
}

// subtractAll returns an automaton accepting L(first) minus the union of the
// remaining automata's languages.
func subtractAll(first *Automaton, rest ...*Automaton) *Automaton {
	ams := append([]*Automaton{first}, rest...)
	return product(ams, func(accs []bool) bool {
		if !accs[0] {
			return false
		}
		for _, ok := range accs[1:] {
			if ok {
				return false
			}
		}
		return true
	})
}

// shortestWord returns a shortest concrete path accepted by the automaton,
// or false if the language is empty. BFS over the total DFA guarantees
// minimality.
func (a *Automaton) shortestWord() ([]string, bool) {
	type edge struct {
		prev, class int
	}
	prev := map[int]edge{a.Start: {prev: -1, class: -1}}
	queue := []int{a.Start}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		if a.Accept[s] {
			var word []string
			for e := prev[s]; e.prev >= 0; e = prev[e.prev] {
				seg := a.other
				if e.class < a.otherClass() {
					seg = a.Literals[e.class]
				}
				word = append([]string{seg}, word...)
			}
			if word == nil {
				word = []string{}
			}
			return word, true
		}
		for class := 0; class < a.NumClasses(); class++ {
			next := a.Trans[s][class]
			if _, seen := prev[next]; !seen {
				prev[next] = edge{prev: s, class: class}
				queue = append(queue, next)
			}
		}
	}
	return nil, false
}

func setKey(set []int) string {
	parts := make([]string, len(set))
	for i, v := range set {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, ",")
}

func sortInts(v []int) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}
