package automata

import (
	"fmt"
	"strconv"
	"strings"
)

// Status is the outcome of a language comparison.
type Status int

const (
	// Equal: the two languages are identical (exploration closed).
	Equal Status = iota
	// NotEqual: a distinguishing string was found.
	NotEqual
	// Unknown: the expansion budget was exhausted before closure.
	Unknown
)

func (s Status) String() string {
	switch s {
	case Equal:
		return "equal"
	case NotEqual:
		return "not-equal"
	default:
		return "unknown"
	}
}

// CertEdge is one subset transition: on Symbol, go to state To.
type CertEdge struct {
	Symbol byte
	To     int
}

// CertState is one pair of NFA subsets in the product exploration.
type CertState struct {
	ID      int
	A       []int // subset of states of the first NFA
	B       []int // subset of states of the second NFA
	AcceptA bool
	AcceptB bool
	Edges   []CertEdge // nil if this state was never expanded
}

// Certificate records the subset-transition graph explored by Compare.
type Certificate struct {
	Alphabet []byte
	States   []CertState
	Expanded int  // number of states actually expanded
	Complete bool // false if the budget cut exploration short
}

// Result is the outcome of Compare.
type Result struct {
	Status     Status
	Witness    string // distinguishing string, when Status == NotEqual
	WitnessInA bool   // true if Witness is accepted by the first NFA
	Cert       *Certificate
}

type pairState struct {
	a, b []int
	path string // a shortest string reaching this pair
}

func pairKey(a, b []int) string {
	var sb strings.Builder
	writeInts := func(v []int) {
		for i, x := range v {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(strconv.Itoa(x))
		}
	}
	writeInts(a)
	sb.WriteByte('|')
	writeInts(b)
	return sb.String()
}

func unionAlphabet(a, b *NFA) []byte {
	seen := map[byte]bool{}
	var out []byte
	for _, c := range append(a.Alphabet(), b.Alphabet()...) {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	for i := 1; i < len(out); i++ { // insertion sort, alphabets are tiny
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Compare decides whether a and b accept the same language. It explores
// the product of subset constructions breadth-first, so the witness it
// returns is a shortest distinguishing string, and among those the
// smallest in byte order. At most budget pair-states are expanded; if
// exploration has not closed by then, the result is Unknown. The
// returned certificate records every subset transition explored.
func Compare(a, b *NFA, budget int) Result {
	alpha := unionAlphabet(a, b)
	cert := &Certificate{Alphabet: alpha}

	start := pairState{a: a.EpsilonClosure(a.Start), b: b.EpsilonClosure(b.Start)}
	ids := map[string]int{}
	addState := func(p pairState) int {
		id := len(cert.States)
		ids[pairKey(p.a, p.b)] = id
		cert.States = append(cert.States, CertState{
			ID:      id,
			A:       p.a,
			B:       p.b,
			AcceptA: acceptsIn(a, toSet(p.a, a.NumStates)),
			AcceptB: acceptsIn(b, toSet(p.b, b.NumStates)),
		})
		return id
	}

	queue := []pairState{start}
	addState(start)

	// A difference is detectable on discovery, before any expansion.
	if cert.States[0].AcceptA != cert.States[0].AcceptB {
		cert.Complete = true
		return Result{Status: NotEqual, Witness: "", WitnessInA: cert.States[0].AcceptA, Cert: cert}
	}

	for len(queue) > 0 {
		if cert.Expanded >= budget {
			return Result{Status: Unknown, Cert: cert}
		}
		cur := queue[0]
		queue = queue[1:]
		curID := ids[pairKey(cur.a, cur.b)]
		setA := toSet(cur.a, a.NumStates)
		setB := toSet(cur.b, b.NumStates)

		for _, c := range alpha {
			next := pairState{
				a:    a.moveClosure(setA, c),
				b:    b.moveClosure(setB, c),
				path: cur.path + string(c),
			}
			id, seen := ids[pairKey(next.a, next.b)]
			if !seen {
				id = addState(next)
				st := cert.States[id]
				if st.AcceptA != st.AcceptB {
					cert.States[curID].Edges = append(cert.States[curID].Edges, CertEdge{Symbol: c, To: id})
					cert.Expanded++
					cert.Complete = true
					return Result{Status: NotEqual, Witness: next.path, WitnessInA: st.AcceptA, Cert: cert}
				}
				queue = append(queue, next)
			}
			cert.States[curID].Edges = append(cert.States[curID].Edges, CertEdge{Symbol: c, To: id})
		}
		cert.Expanded++
	}
	cert.Complete = true
	return Result{Status: Equal, Cert: cert}
}

// Verify checks the certificate against the two NFAs: state 0 must be
// the pair of start closures, every recorded acceptance flag must match
// the subset contents, and every recorded transition must lead to the
// subset pair recomputed from the NFAs. Edge lists may be a prefix of
// the alphabet order, since a NotEqual search stops mid-expansion.
func (c *Certificate) Verify(a, b *NFA) error {
	if len(c.States) == 0 {
		return fmt.Errorf("certificate has no states")
	}
	for i := range c.States {
		if c.States[i].ID != i {
			return fmt.Errorf("state %d: id mismatch", i)
		}
	}
	s0 := c.States[0]
	if pairKey(s0.A, s0.B) != pairKey(a.EpsilonClosure(a.Start), b.EpsilonClosure(b.Start)) {
		return fmt.Errorf("state 0 is not the pair of start closures")
	}
	for _, st := range c.States {
		if st.AcceptA != acceptsIn(a, toSet(st.A, a.NumStates)) ||
			st.AcceptB != acceptsIn(b, toSet(st.B, b.NumStates)) {
			return fmt.Errorf("state %d: acceptance flags do not match subsets", st.ID)
		}
		if len(st.Edges) == 0 {
			continue
		}
		if len(st.Edges) > len(c.Alphabet) {
			return fmt.Errorf("state %d: %d edges for %d symbols",
				st.ID, len(st.Edges), len(c.Alphabet))
		}
		setA := toSet(st.A, a.NumStates)
		setB := toSet(st.B, b.NumStates)
		prev := -1
		for _, e := range st.Edges {
			idx := -1
			for i, c := range c.Alphabet {
				if c == e.Symbol {
					idx = i
					break
				}
			}
			if idx < 0 {
				return fmt.Errorf("state %d: edge on %q not in alphabet", st.ID, e.Symbol)
			}
			if idx <= prev {
				return fmt.Errorf("state %d: edges out of alphabet order", st.ID)
			}
			prev = idx
			if e.To < 0 || e.To >= len(c.States) {
				return fmt.Errorf("state %d: edge on %q targets missing state %d", st.ID, e.Symbol, e.To)
			}
			want := pairKey(a.moveClosure(setA, e.Symbol), b.moveClosure(setB, e.Symbol))
			got := pairKey(c.States[e.To].A, c.States[e.To].B)
			if want != got {
				return fmt.Errorf("state %d: edge on %q leads to %s, want %s", st.ID, e.Symbol, got, want)
			}
		}
	}
	return nil
}
