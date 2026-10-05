// Package automata provides NFAs with epsilon transitions, language
// comparison with bounded subset-pair exploration, and certificates.
package automata

import (
	"sort"
	"strings"
)

// NFA is a nondeterministic finite automaton with epsilon edges.
// States are integers in [0, NumStates).
type NFA struct {
	NumStates int
	Start     int
	Accept    map[int]bool
	// Trans[s][c] lists destinations of the c-labeled edges leaving s.
	Trans map[int]map[byte][]int
	// Epsilon[s] lists destinations of epsilon edges leaving s.
	Epsilon map[int][]int
}

// New returns an empty NFA with n states and the given start state.
func New(n, start int) *NFA {
	return &NFA{
		NumStates: n,
		Start:     start,
		Accept:    map[int]bool{},
		Trans:     map[int]map[byte][]int{},
		Epsilon:   map[int][]int{},
	}
}

// AddEdge adds a c-labeled transition.
func (n *NFA) AddEdge(from int, c byte, to int) {
	if n.Trans[from] == nil {
		n.Trans[from] = map[byte][]int{}
	}
	n.Trans[from][c] = append(n.Trans[from][c], to)
}

// AddEpsilon adds an epsilon transition.
func (n *NFA) AddEpsilon(from, to int) {
	n.Epsilon[from] = append(n.Epsilon[from], to)
}

// Alphabet returns the sorted set of byte symbols used on any edge.
func (n *NFA) Alphabet() []byte {
	seen := map[byte]bool{}
	for _, m := range n.Trans {
		for c := range m {
			seen[c] = true
		}
	}
	out := make([]byte, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// EpsilonClosure returns the sorted epsilon closure of the given states.
func (n *NFA) EpsilonClosure(states []int) []int {
	in := map[int]bool{}
	stack := append([]int(nil), states...)
	for _, s := range states {
		in[s] = true
	}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, t := range n.Epsilon[s] {
			if !in[t] {
				in[t] = true
				stack = append(stack, t)
			}
		}
	}
	out := make([]int, 0, len(in))
	for s := range in {
		out = append(out, s)
	}
	sort.Ints(out)
	return out
}

// Move returns the sorted set of states reachable from states via symbol c
// (without taking the epsilon closure of the result).
func (n *NFA) Move(states []int, c byte) []int {
	in := map[int]bool{}
	for _, s := range states {
		for _, t := range n.Trans[s][c] {
			in[t] = true
		}
	}
	out := make([]int, 0, len(in))
	for s := range in {
		out = append(out, s)
	}
	sort.Ints(out)
	return out
}

// Step applies Move followed by EpsilonClosure.
func (n *NFA) Step(states []int, c byte) []int {
	return n.EpsilonClosure(n.Move(states, c))
}

// AcceptsAny reports whether any state in the set is accepting.
func (n *NFA) AcceptsAny(states []int) bool {
	for _, s := range states {
		if n.Accept[s] {
			return true
		}
	}
	return false
}

// Eval simulates the NFA on s and reports whether s is accepted.
func (n *NFA) Eval(s string) bool {
	cur := n.EpsilonClosure([]int{n.Start})
	for i := 0; i < len(s); i++ {
		cur = n.Step(cur, s[i])
	}
	return n.AcceptsAny(cur)
}

// subsetKey encodes a sorted subset for use as a map key.
func subsetKey(states []int) string {
	var sb strings.Builder
	for _, s := range states {
		sb.WriteByte(byte(s / 256))
		sb.WriteByte(byte(s % 256))
	}
	return sb.String()
}
