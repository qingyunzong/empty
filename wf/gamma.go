package wf

import (
	"container/heap"
	"sort"
)

// Derivation records the rule that actually first derived an atom inside one
// Gamma application, together with the positive-premise trigger sequence.
//
// Seq is the 1-based position of the head atom in this Gamma's derivation
// order. PremiseSeq maps every distinct positive body atom to the Seq at
// which that premise was derived; a fact rule (empty positive body) has an
// empty map. PremiseSeq never contains the head itself: a positive cycle has
// no external support and cannot make its own atoms true.
type Derivation struct {
	Head       string
	RuleID     string
	Seq        int
	PremiseSeq map[string]int
}

// ErasureRecord documents why negative body literals could be dropped. The
// reason always points at the concrete S passed to that Gamma call: a negative
// literal not n is dropped only when n belongs to S. Rules whose negative body
// intersects S are removed instead.
type ErasureRecord struct {
	RuleID string
	Atom   string
}

// RemovalRecord documents a rule deleted in step 1 of Gamma because one of its
// negative body atoms is a member of the input set S.
type RemovalRecord struct {
	RuleID string
	Atom   string
}

// GammaTrace is the full audit material of one Gamma(S) application.
type GammaTrace struct {
	S           []string
	Derivations []Derivation
	Closure     []string
	Erasures    []ErasureRecord
	Removals    []RemovalRecord
}

type ruleHeap []*compiledRule

func (h ruleHeap) Len() int           { return len(h) }
func (h ruleHeap) Less(i, j int) bool { return h[i].id < h[j].id }
func (h ruleHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *ruleHeap) Push(x any)        { *h = append(*h, x.(*compiledRule)) }
func (h *ruleHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return item
}

type atomHeap []string

func (h atomHeap) Len() int           { return len(h) }
func (h atomHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h atomHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *atomHeap) Push(x any)        { *h = append(*h, x.(string)) }
func (h *atomHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = ""
	*h = old[:n-1]
	return item
}

type gammaState struct {
	prog *Program

	// Dependency index: for each positive atom a, the rules whose positive
	// body contains a. Set semantics guarantee one entry per (rule, atom):
	// a repeated premise counts only once.
	waitingOn map[string][]*compiledRule
	remaining map[*compiledRule]int
	ready     ruleHeap

	derived   map[string]bool
	seqOf     map[string]int
	firstRule map[string]*compiledRule
	premSeq   map[*compiledRule]map[string]int

	pending atomHeap
	fired   map[*compiledRule]bool

	trace *GammaTrace
}

// gamma applies the alternating operator to S.
//
// Step 1 deletes every rule whose negative body intersects S. Step 2 erases
// all not literals from the surviving rules. The resulting positive program
// is closed from the empty set using dependency indexes and remaining
// premise counters, so unsupported positive cycles can never bootstrap
// themselves into the closure.
func gamma(prog *Program, S []string) GammaTrace {
	inS := make(map[string]bool, len(S))
	for _, atom := range S {
		inS[atom] = true
	}

	st := &gammaState{
		prog:      prog,
		waitingOn: make(map[string][]*compiledRule),
		remaining: make(map[*compiledRule]int),
		derived:   make(map[string]bool),
		seqOf:     make(map[string]int),
		firstRule: make(map[string]*compiledRule),
		premSeq:   make(map[*compiledRule]map[string]int),
		fired:     make(map[*compiledRule]bool),
		trace:     &GammaTrace{S: append([]string(nil), S...)},
	}
	heap.Init(&st.ready)
	heap.Init(&st.pending)

	var survivors []*compiledRule
	for _, id := range prog.ruleIDs {
		rule := prog.rules[id]
		if blockedBy, blocked := firstIntersection(rule.neg, inS); blocked {
			st.trace.Removals = append(st.trace.Removals, RemovalRecord{RuleID: id, Atom: blockedBy})
			continue
		}
		for _, neg := range rule.neg {
			st.trace.Erasures = append(st.trace.Erasures, ErasureRecord{RuleID: id, Atom: neg})
		}
		survivors = append(survivors, rule)
	}

	// Build the dependency index and remaining-premise counters from the
	// positive program obtained after erasure.
	for _, rule := range survivors {
		st.remaining[rule] = len(rule.pos)
		st.premSeq[rule] = make(map[string]int)
		for _, premise := range rule.pos {
			st.waitingOn[premise] = append(st.waitingOn[premise], rule)
		}
		if len(rule.pos) == 0 {
			heap.Push(&st.ready, rule)
		}
	}

	st.advance()

	closure := make([]string, 0, len(st.derived))
	for atom := range st.derived {
		closure = append(closure, atom)
	}
	sort.Strings(closure)
	st.trace.Closure = closure

	derivations := make([]Derivation, 0, len(closure))
	firedOrder := make([]string, 0, len(closure))
	for atom := range st.seqOf {
		firedOrder = append(firedOrder, atom)
	}
	sort.Slice(firedOrder, func(i, j int) bool {
		return st.seqOf[firedOrder[i]] < st.seqOf[firedOrder[j]]
	})
	for _, atom := range firedOrder {
		rule := st.firstRule[atom]
		derivations = append(derivations, Derivation{
			Head:       atom,
			RuleID:     rule.id,
			Seq:        st.seqOf[atom],
			PremiseSeq: copyIntMap(st.premSeq[rule]),
		})
	}
	st.trace.Derivations = derivations
	return *st.trace
}

// advance repeatedly fires the ASCII-smallest ready rule, queues newly
// activated atoms in ASCII order, then activates the ASCII-smallest pending
// atom.
func (st *gammaState) advance() {
	for st.ready.Len() > 0 || st.pending.Len() > 0 {
		for st.ready.Len() > 0 {
			rule := heap.Pop(&st.ready).(*compiledRule)
			if st.fired[rule] || st.derived[rule.head] {
				continue
			}
			st.fired[rule] = true
			st.derived[rule.head] = true
			st.seqOf[rule.head] = len(st.derived)
			st.firstRule[rule.head] = rule
			heap.Push(&st.pending, rule.head)
		}
		if st.pending.Len() == 0 {
			return
		}
		atom := heap.Pop(&st.pending).(string)
		for _, rule := range st.waitingOn[atom] {
			if st.fired[rule] || st.derived[rule.head] {
				continue
			}
			st.premSeq[rule][atom] = st.seqOf[atom]
			st.remaining[rule]--
			if st.remaining[rule] == 0 {
				heap.Push(&st.ready, rule)
			}
		}
	}
}

func firstIntersection(orderedNeg []string, inS map[string]bool) (string, bool) {
	for _, atom := range orderedNeg {
		if inS[atom] {
			return atom, true
		}
	}
	return "", false
}

func copyIntMap(in map[string]int) map[string]int {
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
