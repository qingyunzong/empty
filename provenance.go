// Package provenance evaluates finite, non-recursive relational rules and
// computes why-provenance: for every output tuple it keeps the alternative
// minimal source sets (witnesses) of input facts that derive it.
//
// Deleting a fact retracts exactly the witnesses containing it; a tuple
// survives as long as any alternative witness remains. Witness sets that are
// supersets of another witness of the same tuple are discarded, so only
// minimal witnesses are kept.
package provenance

import (
	"fmt"
	"math/bits"
	"sort"
	"strings"
)

// MaxFacts bounds the number of input facts so that a witness set always
// fits in a bitmask.
const MaxFacts = 64

// Fact is a ground tuple of an extensional (base) relation.
type Fact struct {
	Rel  string
	Args []string
}

// Literal is a relation applied to terms. A term is a variable iff it starts
// with '?'; any other term is a constant.
type Literal struct {
	Rel  string
	Args []string
}

// Rule is a single Horn rule Head :- Body[0], ..., Body[n-1]. Rules must be
// non-recursive: the dependency graph between relations must be acyclic.
type Rule struct {
	Head Literal
	Body []Literal
}

// Tuple is an output row.
type Tuple []string

// Witness is a set of input facts deriving one output tuple, encoded as a
// bitmask over fact indexes.
type Witness uint64

// Facts returns the fact indexes contained in w, in increasing order.
func (w Witness) Facts() []int {
	var out []int
	for i := 0; i < MaxFacts; i++ {
		if w.Contains(i) {
			out = append(out, i)
		}
	}
	return out
}

// Contains reports whether fact index i is part of the witness.
func (w Witness) Contains(factIdx int) bool {
	return w&(1<<uint(factIdx)) != 0
}

func isVar(term string) bool { return strings.HasPrefix(term, "?") }

func tupleKey(args []string) string { return strings.Join(args, "\x00") }

// Engine holds a fixed set of facts and non-recursive rules.
type Engine struct {
	facts       []Fact
	rulesByHead map[string][]Rule
	order       []string // IDB relations, dependencies first
}

// New validates the program and returns an engine ready for queries.
func New(facts []Fact, rules []Rule) (*Engine, error) {
	if len(facts) > MaxFacts {
		return nil, fmt.Errorf("provenance: %d facts exceed the maximum of %d", len(facts), MaxFacts)
	}
	seen := make(map[string]bool, len(facts))
	deduped := make([]Fact, 0, len(facts))
	for _, f := range facts {
		if f.Rel == "" {
			return nil, fmt.Errorf("provenance: fact with empty relation")
		}
		key := f.Rel + "\x00" + tupleKey(f.Args)
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, f)
		}
	}
	byHead := make(map[string][]Rule)
	for _, r := range rules {
		if err := validateRule(r); err != nil {
			return nil, err
		}
		byHead[r.Head.Rel] = append(byHead[r.Head.Rel], r)
	}
	order, err := CheckNonRecursive(rules)
	if err != nil {
		return nil, err
	}
	return &Engine{facts: deduped, rulesByHead: byHead, order: order}, nil
}

// Facts returns the deduplicated input facts; index i corresponds to bit i
// in every Witness produced by this engine.
func (e *Engine) Facts() []Fact { return append([]Fact(nil), e.facts...) }

func validateRule(r Rule) error {
	if r.Head.Rel == "" {
		return fmt.Errorf("provenance: rule with empty head relation")
	}
	bound := map[string]bool{}
	for _, lit := range r.Body {
		if lit.Rel == "" {
			return fmt.Errorf("provenance: rule for %q has a body literal with empty relation", r.Head.Rel)
		}
		for _, a := range lit.Args {
			if isVar(a) {
				bound[a] = true
			}
		}
	}
	for _, a := range r.Head.Args {
		if isVar(a) && !bound[a] {
			return fmt.Errorf("provenance: unsafe head variable %q in rule for %q", a, r.Head.Rel)
		}
	}
	return nil
}

// CheckNonRecursive topologically sorts the intensional relations of the
// program (dependencies first) and reports an error if the rules are
// recursive.
func CheckNonRecursive(rules []Rule) ([]string, error) {
	isHead := map[string]bool{}
	for _, r := range rules {
		isHead[r.Head.Rel] = true
	}
	deps := map[string][]string{}
	for _, r := range rules {
		for _, b := range r.Body {
			if isHead[b.Rel] {
				deps[r.Head.Rel] = append(deps[r.Head.Rel], b.Rel)
			}
		}
	}
	names := make([]string, 0, len(isHead))
	for name := range isHead {
		names = append(names, name)
	}
	sort.Strings(names)
	const (
		white = iota
		gray
		black
	)
	color := map[string]int{}
	var order []string
	var visit func(rel string) error
	visit = func(rel string) error {
		switch color[rel] {
		case gray:
			return fmt.Errorf("provenance: recursive rules involving relation %q are not supported", rel)
		case black:
			return nil
		}
		color[rel] = gray
		for _, d := range deps[rel] {
			if err := visit(d); err != nil {
				return err
			}
		}
		color[rel] = black
		order = append(order, rel)
		return nil
	}
	for _, name := range names {
		if err := visit(name); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// relation stores tuples with their alternative witness sets.
type relation struct {
	keys []string
	tups map[string]Tuple
	prov map[string][]Witness
}

func newRelation() *relation {
	return &relation{tups: map[string]Tuple{}, prov: map[string][]Witness{}}
}

func (r *relation) add(tup Tuple, w Witness) {
	key := tupleKey(tup)
	if _, ok := r.tups[key]; !ok {
		r.keys = append(r.keys, key)
		r.tups[key] = append(Tuple(nil), tup...)
	}
	r.prov[key] = append(r.prov[key], w)
}

func (r *relation) minimize() {
	for _, key := range r.keys {
		r.prov[key] = minimizeWitnesses(r.prov[key])
	}
}

// minimizeWitnesses drops duplicate witnesses and any witness that is a
// superset of another one, keeping only the minimal source sets.
func minimizeWitnesses(ws []Witness) []Witness {
	sorted := append([]Witness(nil), ws...)
	sort.Slice(sorted, func(i, j int) bool {
		ci, cj := bits.OnesCount64(uint64(sorted[i])), bits.OnesCount64(uint64(sorted[j]))
		if ci != cj {
			return ci < cj
		}
		return sorted[i] < sorted[j]
	})
	kept := make([]Witness, 0, len(sorted))
	for _, w := range sorted {
		superset := false
		for _, k := range kept {
			if k&w == k { // k subseteq w (duplicates included)
				superset = true
				break
			}
		}
		if !superset {
			kept = append(kept, w)
		}
	}
	return kept
}

func (e *Engine) evaluate() map[string]*relation {
	rels := map[string]*relation{}
	get := func(name string) *relation {
		r := rels[name]
		if r == nil {
			r = newRelation()
			rels[name] = r
		}
		return r
	}
	for i, f := range e.facts {
		get(f.Rel).add(f.Args, Witness(1)<<uint(i))
	}
	for _, name := range e.order {
		out := get(name)
		for _, rule := range e.rulesByHead[name] {
			evalRule(rule, rels, out)
		}
		out.minimize()
	}
	return rels
}

func evalRule(rule Rule, rels map[string]*relation, out *relation) {
	var rec func(idx int, bind map[string]string, w Witness)
	rec = func(idx int, bind map[string]string, w Witness) {
		if idx == len(rule.Body) {
			tup := make(Tuple, len(rule.Head.Args))
			for i, a := range rule.Head.Args {
				if isVar(a) {
					v, ok := bind[a]
					if !ok {
						return // unreachable: validated by New
					}
					tup[i] = v
				} else {
					tup[i] = a
				}
			}
			out.add(tup, w)
			return
		}
		lit := rule.Body[idx]
		rel := rels[lit.Rel]
		if rel == nil {
			return
		}
		for _, key := range rel.keys {
			nb, ok := matchLiteral(lit, rel.tups[key], bind)
			if !ok {
				continue
			}
			for _, w2 := range rel.prov[key] {
				rec(idx+1, nb, w|w2)
			}
		}
	}
	rec(0, map[string]string{}, 0)
}

func matchLiteral(lit Literal, tup Tuple, bind map[string]string) (map[string]string, bool) {
	if len(lit.Args) != len(tup) {
		return nil, false
	}
	nb := make(map[string]string, len(bind)+len(lit.Args))
	for k, v := range bind {
		nb[k] = v
	}
	for i, term := range lit.Args {
		if isVar(term) {
			if v, ok := nb[term]; ok {
				if v != tup[i] {
					return nil, false
				}
			} else {
				nb[term] = tup[i]
			}
		} else if term != tup[i] {
			return nil, false
		}
	}
	return nb, true
}

// Result is the outcome of a Query: each derived tuple with its minimal
// alternative witnesses.
type Result struct {
	keys []string
	tups map[string]Tuple
	prov map[string][]Witness
}

// Query evaluates the program and returns the tuples of relation rel
// together with their minimal alternative witnesses.
func (e *Engine) Query(rel string) *Result {
	rels := e.evaluate()
	res := &Result{tups: map[string]Tuple{}, prov: map[string][]Witness{}}
	if r := rels[rel]; r != nil {
		res.keys = append(res.keys, r.keys...)
		sort.Strings(res.keys)
		for _, key := range res.keys {
			res.tups[key] = r.tups[key]
			res.prov[key] = append([]Witness(nil), r.prov[key]...)
		}
	}
	return res
}

// Tuples returns the derived tuples in deterministic (sorted) order.
func (r *Result) Tuples() []Tuple {
	out := make([]Tuple, 0, len(r.keys))
	for _, key := range r.keys {
		out = append(out, append(Tuple(nil), r.tups[key]...))
	}
	return out
}

// Witnesses returns the minimal alternative witnesses of t, or nil if t is
// not derived.
func (r *Result) Witnesses(t Tuple) []Witness {
	return append([]Witness(nil), r.prov[tupleKey(t)]...)
}

// Without returns the result of deleting fact index factIdx: exactly the
// witnesses containing that fact are retracted, and tuples with surviving
// alternative witnesses remain. The filtered witnesses stay minimal, so
// Without can be chained for multiple deletions.
func (r *Result) Without(factIdx int) *Result {
	nr := &Result{tups: map[string]Tuple{}, prov: map[string][]Witness{}}
	for _, key := range r.keys {
		var kept []Witness
		for _, w := range r.prov[key] {
			if !w.Contains(factIdx) {
				kept = append(kept, w)
			}
		}
		if len(kept) > 0 {
			nr.keys = append(nr.keys, key)
			nr.tups[key] = r.tups[key]
			nr.prov[key] = kept
		}
	}
	return nr
}
