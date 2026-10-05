package automata

import "fmt"

// Verdict is the outcome of a language comparison.
type Verdict int

const (
	// Equivalent means the two NFAs accept the same language (proved by
	// exhausting the subset-pair space within budget).
	Equivalent Verdict = iota
	// Different means a distinguishing string was found.
	Different
	// Unknown means the expansion budget was exhausted before the search
	// space was closed; no conclusion is drawn.
	Unknown
)

func (v Verdict) String() string {
	switch v {
	case Equivalent:
		return "equivalent"
	case Different:
		return "different"
	default:
		return "unknown"
	}
}

// CertStep is one transition of a subset-pair certificate: from the subset
// pair (FromA, FromB), reading Symbol leads to (ToA, ToB).
type CertStep struct {
	FromA, FromB []int
	Symbol       byte
	ToA, ToB     []int
}

// Certificate records the subset-pair transitions witnessing a difference
// between two NFAs. The final pair (FinalA, FinalB) has differing
// acceptance.
type Certificate struct {
	Steps []CertStep
	// FinalA and FinalB are the subsets reached after all steps; exactly
	// one of them contains an accepting state of its NFA.
	FinalA, FinalB []int
}

// Result is the outcome of Compare.
type Result struct {
	Verdict Verdict
	// Witness is the shortest distinguishing string (byte-order minimal
	// among shortest) when Verdict is Different.
	Witness string
	// Cert is the subset-transition certificate for Witness.
	Cert Certificate
	// Expanded is the number of subset pairs dequeued and processed.
	Expanded int
}

// pair is a subset-construction state pair.
type pair struct {
	a, b []int
}

func pairKey(p pair) string { return subsetKey(p.a) + "|" + subsetKey(p.b) }

// parentInfo records how a BFS node was reached.
type parentInfo struct {
	prev   string
	symbol byte
}

// Compare decides whether a and b accept the same language over the union
// of their alphabets. It performs BFS over pairs of subsets (product of
// subset constructions), expanding at most budget pairs. If the queue is
// not empty when the budget is exhausted, it returns Verdict Unknown.
//
// Because BFS dequeues pairs in order of increasing path length and symbols
// are tried in ascending byte order, the reported witness is the shortest
// distinguishing string, byte-order minimal among those.
func Compare(a, b *NFA, budget int) Result {
	alpha := unionAlphabet(a, b)
	start := pair{a.EpsilonClosure([]int{a.Start}), b.EpsilonClosure([]int{b.Start})}

	seen := map[string]bool{pairKey(start): true}
	par := map[string]parentInfo{}
	nodes := map[string]pair{pairKey(start): start}
	queue := []string{pairKey(start)}

	expanded := 0
	for len(queue) > 0 {
		if expanded >= budget {
			return Result{Verdict: Unknown, Expanded: expanded}
		}
		key := queue[0]
		queue = queue[1:]
		cur := nodes[key]
		expanded++

		if a.AcceptsAny(cur.a) != b.AcceptsAny(cur.b) {
			wit, cert := buildCertificate(a, b, start, key, par)
			return Result{Verdict: Different, Witness: wit, Cert: cert, Expanded: expanded}
		}
		for _, c := range alpha {
			next := pair{a.Step(cur.a, c), b.Step(cur.b, c)}
			nk := pairKey(next)
			if seen[nk] {
				continue
			}
			seen[nk] = true
			par[nk] = parentInfo{prev: key, symbol: c}
			nodes[nk] = next
			queue = append(queue, nk)
		}
	}
	return Result{Verdict: Equivalent, Expanded: expanded}
}

// buildCertificate reconstructs the witness string and the subset-pair
// transition chain from the start pair to the divergent pair key.
func buildCertificate(a, b *NFA, start pair, key string, par map[string]parentInfo) (string, Certificate) {
	type edge struct{ symbol byte }
	var rev []edge
	for k := key; k != pairKey(start); {
		p := par[k]
		rev = append(rev, edge{symbol: p.symbol})
		k = p.prev
	}
	wit := make([]byte, len(rev))
	cert := Certificate{}
	cur := start
	for i := len(rev) - 1; i >= 0; i-- {
		c := rev[i].symbol
		next := pair{a.Step(cur.a, c), b.Step(cur.b, c)}
		cert.Steps = append(cert.Steps, CertStep{
			FromA:  cur.a,
			FromB:  cur.b,
			Symbol: c,
			ToA:    next.a,
			ToB:    next.b,
		})
		wit[len(rev)-1-i] = c
		cur = next
	}
	cert.FinalA = cur.a
	cert.FinalB = cur.b
	return string(wit), cert
}

// Verify checks that the certificate is a valid subset-transition chain for
// a and b whose final pair has differing acceptance.
func (c Certificate) Verify(a, b *NFA) bool {
	curA := a.EpsilonClosure([]int{a.Start})
	curB := b.EpsilonClosure([]int{b.Start})
	for _, st := range c.Steps {
		if !eqInts(curA, st.FromA) || !eqInts(curB, st.FromB) {
			return false
		}
		curA = a.Step(curA, st.Symbol)
		curB = b.Step(curB, st.Symbol)
		if !eqInts(curA, st.ToA) || !eqInts(curB, st.ToB) {
			return false
		}
	}
	if !eqInts(curA, c.FinalA) || !eqInts(curB, c.FinalB) {
		return false
	}
	return a.AcceptsAny(c.FinalA) != b.AcceptsAny(c.FinalB)
}

// String renders the certificate as a readable subset-transition chain.
func (c Certificate) String() string {
	out := ""
	for i, st := range c.Steps {
		out += fmt.Sprintf("step %d: (%v,%v) --%q--> (%v,%v)\n", i, st.FromA, st.FromB, st.Symbol, st.ToA, st.ToB)
	}
	out += fmt.Sprintf("final: A=%v B=%v (acceptance differs)", c.FinalA, c.FinalB)
	return out
}

func unionAlphabet(a, b *NFA) []byte {
	seen := map[byte]bool{}
	for _, c := range a.Alphabet() {
		seen[c] = true
	}
	for _, c := range b.Alphabet() {
		seen[c] = true
	}
	out := make([]byte, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func eqInts(x, y []int) bool {
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}
