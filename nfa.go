// Package automata provides NFAs with epsilon transitions, language
// comparison with budgeted subset construction, and transition
// certificates.
package automata

import "sort"

// NFA is a nondeterministic finite automaton over a byte alphabet,
// with epsilon transitions. States are numbered 0..NumStates-1.
type NFA struct {
	NumStates int
	Start     int
	Final     []bool
	Eps       [][]int          // Eps[s]: epsilon successors of s
	Next      []map[byte][]int // Next[s][c]: successors of s on byte c
	alpha     map[byte]bool
}

// NewNFA creates an NFA with numStates states and the given start state.
func NewNFA(numStates, start int) *NFA {
	return &NFA{
		NumStates: numStates,
		Start:     start,
		Final:     make([]bool, numStates),
		Eps:       make([][]int, numStates),
		Next:      make([]map[byte][]int, numStates),
		alpha:     make(map[byte]bool),
	}
}

// AddFinal marks s as an accepting state.
func (n *NFA) AddFinal(s int) { n.Final[s] = true }

// AddEps adds an epsilon transition from -> to.
func (n *NFA) AddEps(from, to int) { n.Eps[from] = append(n.Eps[from], to) }

// AddTrans adds a transition from -> to on byte c.
func (n *NFA) AddTrans(from int, c byte, to int) {
	if n.Next[from] == nil {
		n.Next[from] = make(map[byte][]int)
	}
	n.Next[from][c] = append(n.Next[from][c], to)
	n.alpha[c] = true
}

// Alphabet returns the sorted set of bytes used in transitions.
func (n *NFA) Alphabet() []byte {
	out := make([]byte, 0, len(n.alpha))
	for c := range n.alpha {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// closureSet expands the bitset in place by following epsilon edges.
func (n *NFA) closureSet(in []bool) {
	stack := make([]int, 0, n.NumStates)
	for s := 0; s < n.NumStates; s++ {
		if in[s] {
			stack = append(stack, s)
		}
	}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, t := range n.Eps[s] {
			if !in[t] {
				in[t] = true
				stack = append(stack, t)
			}
		}
	}
}

// EpsilonClosure returns the sorted epsilon-closure of the given states.
func (n *NFA) EpsilonClosure(states ...int) []int {
	set := make([]bool, n.NumStates)
	for _, s := range states {
		set[s] = true
	}
	n.closureSet(set)
	return sortedSet(set)
}

// moveClosure computes the epsilon-closure of all c-successors of the
// states in set (set must already be epsilon-closed). Result is sorted.
func (n *NFA) moveClosure(set []bool, c byte) []int {
	out := make([]bool, n.NumStates)
	for s := 0; s < n.NumStates; s++ {
		if !set[s] {
			continue
		}
		for _, t := range n.Next[s][c] {
			out[t] = true
		}
	}
	n.closureSet(out)
	return sortedSet(out)
}

// Accepts reports whether the NFA accepts s, by subset simulation.
func (n *NFA) Accepts(s string) bool {
	set := make([]bool, n.NumStates)
	set[n.Start] = true
	n.closureSet(set)
	for i := 0; i < len(s); i++ {
		next := make([]bool, n.NumStates)
		for st := 0; st < n.NumStates; st++ {
			if !set[st] {
				continue
			}
			for _, t := range n.Next[st][s[i]] {
				next[t] = true
			}
		}
		n.closureSet(next)
		set = next
	}
	return acceptsIn(n, set)
}

func acceptsIn(n *NFA, set []bool) bool {
	for s := 0; s < n.NumStates; s++ {
		if set[s] && n.Final[s] {
			return true
		}
	}
	return false
}

func sortedSet(set []bool) []int {
	var out []int
	for s, ok := range set {
		if ok {
			out = append(out, s)
		}
	}
	return out
}

func toSet(sorted []int, size int) []bool {
	set := make([]bool, size)
	for _, s := range sorted {
		set[s] = true
	}
	return set
}
