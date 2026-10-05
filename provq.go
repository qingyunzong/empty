// Package provq implements a small query engine over finite, non-recursive
// relational (Datalog-style) rules.
//
// For every output tuple the engine keeps its alternative source sets
// ("witnesses"): the inclusion-minimal sets of input facts from which the
// tuple can be derived. Deleting a fact retracts exactly the witnesses that
// contain it; a tuple survives as long as at least one alternative witness
// remains. A witness that is a superset of another witness is discarded.
package provq

import (
	"fmt"
	"sort"
	"strings"
)

// maxFacts is the capacity of a DB, bounded by the Witness bitmask width.
const maxFacts = 64

// Witness is a set of fact IDs stored as a bitmask.
type Witness uint64

// Contains reports whether fact id is part of the witness.
func (w Witness) Contains(id int) bool { return w&(1<<uint(id)) != 0 }

// FactIDs returns the sorted fact IDs making up the witness.
func (w Witness) FactIDs() []int {
	var ids []int
	for i := 0; i < maxFacts; i++ {
		if w.Contains(i) {
			ids = append(ids, i)
		}
	}
	return ids
}

// Term is an argument of a literal: either a variable or a constant.
type Term struct {
	Var   string
	Const string
	IsVar bool
}

// V builds a variable term.
func V(name string) Term { return Term{Var: name, IsVar: true} }

// C builds a constant term.
func C(val string) Term { return Term{Const: val} }

// Literal is a relation applied to argument terms.
type Literal struct {
	Rel  string
	Args []Term
}

// Rule is a conjunctive rule Head :- Body. Rules must be non-recursive and
// safe: every head variable must occur in the body.
type Rule struct {
	Head Literal
	Body []Literal
}

// Tuple is a row of attribute values.
type Tuple []string

func keyOf(t Tuple) string { return strings.Join(t, "\x00") }

type fact struct {
	rel   string
	tuple Tuple
	live  bool
}

type tupleEntry struct {
	tuple     Tuple
	witnesses []Witness // inclusion-minimal alternative source sets
}

// DB holds facts, rules and the derived output with provenance.
type DB struct {
	facts   []fact
	rules   []Rule
	order   []int // rule indices in topological evaluation order
	derived map[string]bool
	out     map[string]map[string]tupleEntry // rel -> tuple key -> entry
}

// New returns an empty DB.
func New() *DB {
	return &DB{
		derived: map[string]bool{},
		out:     map[string]map[string]tupleEntry{},
	}
}

// AddRule registers a rule and re-derives output. It fails if the rules
// become recursive (cyclic) or unsafe (unbound head variable).
func (db *DB) AddRule(r Rule) error {
	db.rules = append(db.rules, r)
	if err := db.compile(); err != nil {
		db.rules = db.rules[:len(db.rules)-1]
		db.compile()
		return err
	}
	db.recompute()
	return nil
}

// AddFact inserts a base fact and returns its ID. Facts are sources: the
// same atom inserted twice yields two independent alternative witnesses.
func (db *DB) AddFact(rel string, vals ...string) (int, error) {
	if len(db.facts) == maxFacts {
		return -1, fmt.Errorf("provq: fact limit (%d) reached", maxFacts)
	}
	id := len(db.facts)
	t := Tuple(append([]string(nil), vals...))
	db.facts = append(db.facts, fact{rel: rel, tuple: t, live: true})
	db.addWitness(rel, t, Witness(1)<<uint(id))
	db.recompute()
	return id, nil
}

// DeleteFact retracts exactly the witnesses containing id, at every
// derivation level. Tuples with remaining alternative witnesses survive.
func (db *DB) DeleteFact(id int) {
	if id < 0 || id >= len(db.facts) || !db.facts[id].live {
		return
	}
	db.facts[id].live = false
	bit := Witness(1) << uint(id)
	for rel, tuples := range db.out {
		for k, e := range tuples {
			e.witnesses = removeContaining(e.witnesses, bit)
			if len(e.witnesses) == 0 {
				delete(tuples, k)
			} else {
				tuples[k] = e
			}
		}
		if len(tuples) == 0 {
			delete(db.out, rel)
		}
	}
}

// Witnesses returns the minimal alternative source sets deriving the tuple,
// or nil if the tuple is not derivable.
func (db *DB) Witnesses(rel string, tuple ...string) []Witness {
	e, ok := db.out[rel][keyOf(tuple)]
	if !ok {
		return nil
	}
	return append([]Witness(nil), e.witnesses...)
}

// Tuples returns all currently derivable tuples of rel, sorted.
func (db *DB) Tuples(rel string) []Tuple {
	var ts []Tuple
	for _, e := range db.out[rel] {
		ts = append(ts, e.tuple)
	}
	sort.Slice(ts, func(i, j int) bool { return keyOf(ts[i]) < keyOf(ts[j]) })
	return ts
}

// compile topologically orders the rules and rejects recursion and unsafe
// head variables.
func (db *DB) compile() error {
	derived := map[string]bool{}
	for _, r := range db.rules {
		derived[r.Head.Rel] = true
	}
	for _, r := range db.rules {
		bound := map[string]bool{}
		for _, l := range r.Body {
			for _, a := range l.Args {
				if a.IsVar {
					bound[a.Var] = true
				}
			}
		}
		for _, a := range r.Head.Args {
			if a.IsVar && !bound[a.Var] {
				return fmt.Errorf("provq: unsafe rule, head variable %q not bound in body", a.Var)
			}
		}
	}
	producers := map[string]int{}
	for _, r := range db.rules {
		producers[r.Head.Rel]++
	}
	var order []int
	remaining := map[int]bool{}
	for i := range db.rules {
		remaining[i] = true
	}
	done := map[string]int{} // evaluated producer count per derived relation
	for len(remaining) > 0 {
		progress := false
		for i := range remaining {
			ok := true
			for _, l := range db.rules[i].Body {
				if derived[l.Rel] && done[l.Rel] < producers[l.Rel] {
					ok = false
					break
				}
			}
			if ok {
				order = append(order, i)
				done[db.rules[i].Head.Rel]++
				delete(remaining, i)
				progress = true
			}
		}
		if !progress {
			return fmt.Errorf("provq: recursive rules are not supported")
		}
	}
	db.order = order
	db.derived = derived
	return nil
}

// recompute re-derives all rule output from the current base facts.
func (db *DB) recompute() {
	for rel := range db.derived {
		delete(db.out, rel)
	}
	for _, ri := range db.order {
		db.evalRule(db.rules[ri])
	}
}

type binding map[string]string

type candidate struct {
	tuple Tuple
	w     Witness
}

func (db *DB) candidates(rel string) []candidate {
	var out []candidate
	for _, e := range db.out[rel] {
		for _, w := range e.witnesses {
			out = append(out, candidate{e.tuple, w})
		}
	}
	return out
}

func (db *DB) evalRule(r Rule) {
	type partial struct {
		b binding
		w Witness
	}
	partials := []partial{{b: binding{}}}
	for _, lit := range r.Body {
		var next []partial
		for _, p := range partials {
			for _, c := range db.candidates(lit.Rel) {
				if nb, ok := unify(p.b, lit.Args, c.tuple); ok {
					next = append(next, partial{nb, p.w | c.w})
				}
			}
		}
		partials = next
		if len(partials) == 0 {
			return
		}
	}
	for _, p := range partials {
		if t, ok := project(r.Head, p.b); ok {
			db.addWitness(r.Head.Rel, t, p.w)
		}
	}
}

func unify(b binding, args []Term, tuple Tuple) (binding, bool) {
	if len(args) != len(tuple) {
		return nil, false
	}
	nb := make(binding, len(b)+len(args))
	for k, v := range b {
		nb[k] = v
	}
	for i, a := range args {
		if a.IsVar {
			if cur, ok := nb[a.Var]; ok && cur != tuple[i] {
				return nil, false
			}
			nb[a.Var] = tuple[i]
		} else if a.Const != tuple[i] {
			return nil, false
		}
	}
	return nb, true
}

func project(head Literal, b binding) (Tuple, bool) {
	t := make(Tuple, len(head.Args))
	for i, a := range head.Args {
		if a.IsVar {
			v, ok := b[a.Var]
			if !ok {
				return nil, false
			}
			t[i] = v
		} else {
			t[i] = a.Const
		}
	}
	return t, true
}

func (db *DB) addWitness(rel string, t Tuple, w Witness) {
	m := db.out[rel]
	if m == nil {
		m = map[string]tupleEntry{}
		db.out[rel] = m
	}
	k := keyOf(t)
	e := m[k]
	e.tuple = t
	e.witnesses = insertMinimal(e.witnesses, w)
	m[k] = e
}

// insertMinimal adds w to ws keeping only inclusion-minimal witnesses: w is
// dropped if some existing witness is a subset of it, and existing
// supersets of w are removed.
func insertMinimal(ws []Witness, w Witness) []Witness {
	for _, x := range ws {
		if x&w == x { // x ⊆ w
			return ws
		}
	}
	kept := ws[:0]
	for _, x := range ws {
		if w&x != w { // keep x unless w ⊂ x
			kept = append(kept, x)
		}
	}
	return append(kept, w)
}

func removeContaining(ws []Witness, bit Witness) []Witness {
	kept := ws[:0]
	for _, w := range ws {
		if w&bit == 0 {
			kept = append(kept, w)
		}
	}
	return kept
}
