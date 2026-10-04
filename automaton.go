package rulelib

import (
	"fmt"
	"sort"
	"strings"
)

// maxLiterals bounds the symbolic alphabet: each literal segment gets one
// minterm bit, plus one "other" bit for every segment not in the alphabet.
const maxLiterals = 63

// alphabet is the symbolic alphabet: the finite set of literal segments
// appearing in the rules, plus an implicit "other" minterm covering every
// segment not equal to any literal.
type alphabet struct {
	literals []string
	index    map[string]int
	otherTok string // representative segment for the "other" minterm
}

func newAlphabet(rules []Rule) (*alphabet, error) {
	a := &alphabet{index: map[string]int{}}
	add := func(p Pattern) {
		for _, seg := range p.segs {
			if seg.kind != segLiteral {
				continue
			}
			if _, ok := a.index[seg.lit]; !ok {
				a.index[seg.lit] = len(a.literals)
				a.literals = append(a.literals, seg.lit)
			}
		}
	}
	for _, r := range rules {
		add(r.include)
		for _, ex := range r.excludes {
			add(ex)
		}
	}
	if len(a.literals) > maxLiterals {
		return nil, fmt.Errorf("rulelib: too many distinct literals (%d > %d)", len(a.literals), maxLiterals)
	}
	a.otherTok = "other"
	for i := 0; ; i++ {
		if _, ok := a.index[a.otherTok]; !ok {
			break
		}
		a.otherTok = fmt.Sprintf("other%d", i)
	}
	return a, nil
}

// minterms is the number of minterms: one per literal plus "other".
func (a *alphabet) minterms() int { return len(a.literals) + 1 }

func (a *alphabet) allMask() uint64 { return uint64(1)<<uint(a.minterms()) - 1 }

// mintermOf returns the minterm index of a concrete segment.
func (a *alphabet) mintermOf(seg string) int {
	if i, ok := a.index[seg]; ok {
		return i
	}
	return len(a.literals) // the "other" minterm
}

// representative returns a concrete segment for a minterm index.
func (a *alphabet) representative(m int) string {
	if m < len(a.literals) {
		return a.literals[m]
	}
	return a.otherTok
}

// nfa is a symbolic NFA over segment minterms. A transition mask is a
// bitmask over minterm indices; mask 0 denotes an epsilon transition.
type nfa struct {
	nstates int
	trans   [][]nfaTransition
	accept  int
}

type nfaTransition struct {
	mask uint64
	to   int
}

// buildNFA compiles a pattern into an NFA. "**" becomes a state with an
// any-segment self loop and an epsilon edge forward (zero or more segments).
func buildNFA(p Pattern, a *alphabet) *nfa {
	n := &nfa{nstates: len(p.segs) + 1, accept: len(p.segs)}
	n.trans = make([][]nfaTransition, n.nstates)
	for i, seg := range p.segs {
		switch seg.kind {
		case segLiteral:
			n.trans[i] = append(n.trans[i], nfaTransition{mask: uint64(1) << uint(a.mintermOf(seg.lit)), to: i + 1})
		case segStar:
			n.trans[i] = append(n.trans[i], nfaTransition{mask: a.allMask(), to: i + 1})
		case segDStar:
			n.trans[i] = append(n.trans[i], nfaTransition{mask: a.allMask(), to: i})
			n.trans[i] = append(n.trans[i], nfaTransition{mask: 0, to: i + 1})
		}
	}
	return n
}

// dfa is a complete deterministic symbolic automaton. trans[s][m] is the
// successor of state s under minterm m; states records the underlying NFA
// state sets for inspection and certificates.
type dfa struct {
	alpha  *alphabet
	states [][]int
	trans  [][]int
	accept []bool
}

func (n *nfa) closure(set []int) []int {
	in := make([]bool, n.nstates)
	stack := make([]int, 0, len(set))
	for _, s := range set {
		if !in[s] {
			in[s] = true
			stack = append(stack, s)
		}
	}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, tr := range n.trans[s] {
			if tr.mask == 0 && !in[tr.to] {
				in[tr.to] = true
				stack = append(stack, tr.to)
			}
		}
	}
	out := make([]int, 0, len(set))
	for s := 0; s < n.nstates; s++ {
		if in[s] {
			out = append(out, s)
		}
	}
	return out
}

func (n *nfa) move(set []int, minterm int) []int {
	bit := uint64(1) << uint(minterm)
	out := make([]int, 0, 4)
	in := make([]bool, n.nstates)
	for _, s := range set {
		for _, tr := range n.trans[s] {
			if tr.mask&bit != 0 && !in[tr.to] {
				in[tr.to] = true
				out = append(out, tr.to)
			}
		}
	}
	sort.Ints(out)
	return out
}

// determinize converts an NFA into a complete DFA (the empty set is the
// sink state, so complementation is exact).
func determinize(n *nfa, a *alphabet) *dfa {
	d := &dfa{alpha: a}
	idx := map[string]int{}
	key := func(set []int) string {
		parts := make([]string, len(set))
		for i, s := range set {
			parts[i] = fmt.Sprint(s)
		}
		return strings.Join(parts, ",")
	}
	add := func(set []int) int {
		k := key(set)
		if id, ok := idx[k]; ok {
			return id
		}
		id := len(d.states)
		idx[k] = id
		d.states = append(d.states, set)
		d.trans = append(d.trans, make([]int, a.minterms()))
		acc := false
		for _, s := range set {
			if s == n.accept {
				acc = true
				break
			}
		}
		d.accept = append(d.accept, acc)
		return id
	}
	start := add(n.closure([]int{0}))
	processed := make([]bool, 0, 8)
	queue := []int{start}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		for len(processed) <= s {
			processed = append(processed, false)
		}
		if processed[s] {
			continue
		}
		processed[s] = true
		for m := 0; m < a.minterms(); m++ {
			next := add(n.closure(n.move(d.states[s], m)))
			d.trans[s][m] = next
			if next >= len(processed) || !processed[next] {
				queue = append(queue, next)
			}
		}
	}
	return d
}

// combine builds the product DFA of x and y. accept combines the two
// accept bits. Both DFAs must share the same alphabet.
func combine(x, y *dfa, accept func(a, b bool) bool) *dfa {
	a := x.alpha
	d := &dfa{alpha: a}
	type pair struct{ i, j int }
	idx := map[pair]int{}
	add := func(p pair) int {
		if id, ok := idx[p]; ok {
			return id
		}
		id := len(d.states)
		idx[p] = id
		d.states = append(d.states, []int{p.i, p.j})
		d.trans = append(d.trans, make([]int, a.minterms()))
		d.accept = append(d.accept, accept(x.accept[p.i], y.accept[p.j]))
		return id
	}
	start := add(pair{0, 0})
	processed := map[int]bool{}
	queue := []int{start}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		if processed[s] {
			continue
		}
		processed[s] = true
		p := pair{d.states[s][0], d.states[s][1]}
		for m := 0; m < a.minterms(); m++ {
			next := add(pair{x.trans[p.i][m], y.trans[p.j][m]})
			d.trans[s][m] = next
			if !processed[next] {
				queue = append(queue, next)
			}
		}
	}
	return d
}

func andNot(a, b bool) bool { return a && !b }
func or(a, b bool) bool     { return a || b }

// match runs a concrete path through the DFA.
func (d *dfa) match(path []string) bool {
	s := 0
	for _, seg := range path {
		s = d.trans[s][d.alpha.mintermOf(seg)]
	}
	return d.accept[s]
}

// ruleLanguage compiles one rule to a DFA: include minus all exclusions.
func ruleLanguage(r Rule, a *alphabet) *dfa {
	d := determinize(buildNFA(r.include, a), a)
	for _, ex := range r.excludes {
		de := determinize(buildNFA(ex, a), a)
		d = combine(d, de, andNot)
	}
	return d
}

// Emptiness is the result of an empty-language check: either a shortest
// witness path, or a complete certificate that no accepting state is
// reachable from the start state.
type Emptiness struct {
	Empty       bool
	Witness     []string // shortest accepted path, when !Empty
	Certificate []string // full reachable graph, when Empty
}

// checkEmpty explores the reachable graph of d. If an accepting state is
// reachable it returns a shortest witness path (BFS); otherwise it returns
// a complete certificate: every reachable state and transition, none of
// them accepting.
func checkEmpty(d *dfa) Emptiness {
	a := d.alpha
	type edge struct {
		from, to int
		m        int
	}
	parent := make([]edge, len(d.states))
	seen := make([]bool, len(d.states))
	seen[0] = true
	order := []int{0}
	queue := []int{0}
	found := -1
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		if d.accept[s] {
			found = s
			break
		}
		for m := 0; m < a.minterms(); m++ {
			t := d.trans[s][m]
			if !seen[t] {
				seen[t] = true
				parent[t] = edge{from: s, to: t, m: m}
				order = append(order, t)
				queue = append(queue, t)
			}
		}
	}
	if found >= 0 {
		var rev []string
		for s := found; s != 0; s = parent[s].from {
			rev = append(rev, a.representative(parent[s].m))
		}
		witness := make([]string, len(rev))
		for i, seg := range rev {
			witness[len(rev)-1-i] = seg
		}
		return Emptiness{Empty: false, Witness: witness}
	}
	cert := make([]string, 0, len(order)*2+1)
	cert = append(cert, fmt.Sprintf("empty-language certificate: %d reachable states, none accepting", len(order)))
	for _, s := range order {
		cert = append(cert, fmt.Sprintf("state q%d nfa=%v accept=%v", s, d.states[s], d.accept[s]))
		for m := 0; m < a.minterms(); m++ {
			cert = append(cert, fmt.Sprintf("  q%d --%s--> q%d", s, a.representative(m), d.trans[s][m]))
		}
	}
	return Emptiness{Empty: true, Certificate: cert}
}
