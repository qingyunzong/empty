// Package datalog implements a rule store for finite, function-free,
// positive Datalog. Base facts can be added and removed in atomic
// batches; derived facts are recomputed as the least fixpoint of the
// rules over the remaining base facts, so after a deletion no fact is
// retained whose only support is mutual recursion with other derived
// facts. Every derived fact carries a finite derivation (proof tree).
package datalog

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// MaxArity is the maximum relation arity supported by the store.
const MaxArity = 3

// Term is a constant or a variable. Function symbols are not supported.
type Term struct {
	IsVar bool
	Val   string
}

// V returns a variable term.
func V(name string) Term { return Term{IsVar: true, Val: name} }

// C returns a constant term.
func C(val string) Term { return Term{Val: val} }

// Atom is a predicate applied to at most MaxArity terms.
type Atom struct {
	Pred  string
	Args  [MaxArity]Term
	Arity int
}

// A builds an atom from a predicate and 0..MaxArity terms.
func A(pred string, args ...Term) Atom {
	a := Atom{Pred: pred, Arity: len(args)}
	copy(a.Args[:], args)
	return a
}

// Fact is a ground atom: a predicate applied to at most MaxArity
// constants. It is comparable and usable as a map key.
type Fact struct {
	Pred  string
	Args  [MaxArity]string
	Arity int
}

// F builds a fact from a predicate and 0..MaxArity constants.
func F(pred string, args ...string) Fact {
	f := Fact{Pred: pred, Arity: len(args)}
	copy(f.Args[:], args)
	return f
}

func (f Fact) String() string {
	s := f.Pred + "("
	for i := 0; i < f.Arity; i++ {
		if i > 0 {
			s += ","
		}
		s += f.Args[i]
	}
	return s + ")"
}

// Rule is a positive Datalog clause: Head :- Body[0], ..., Body[n-1].
// An empty body is rejected; base facts are added via Apply instead.
type Rule struct {
	Head Atom
	Body []Atom
}

// R builds a rule with the given head and body atoms.
func R(head Atom, body ...Atom) Rule { return Rule{Head: head, Body: body} }

// Derivation is a finite proof tree for a fact. Base facts have a nil
// Rule and no Sub derivations; derived facts record the rule and the
// derivations of the body facts used in the firing that produced them.
type Derivation struct {
	Fact Fact
	Rule *Rule
	Sub  []*Derivation
}

// Depth returns the height of the derivation tree (0 for base facts).
func (d *Derivation) Depth() int {
	max := 0
	for _, s := range d.Sub {
		if h := s.Depth() + 1; h > max {
			max = h
		}
	}
	return max
}

// Leaves returns the distinct base facts the derivation rests on.
func (d *Derivation) Leaves() []Fact {
	seen := map[Fact]bool{}
	var walk func(d *Derivation)
	walk = func(d *Derivation) {
		if d.Rule == nil {
			seen[d.Fact] = true
			return
		}
		for _, s := range d.Sub {
			walk(s)
		}
	}
	walk(d)
	out := make([]Fact, 0, len(seen))
	for f := range seen {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

func validateAtom(a Atom, what string) error {
	if a.Pred == "" {
		return fmt.Errorf("%s: empty predicate", what)
	}
	if a.Arity < 0 || a.Arity > MaxArity {
		return fmt.Errorf("%s: arity %d exceeds maximum %d", what, a.Arity, MaxArity)
	}
	for i := a.Arity; i < MaxArity; i++ {
		if a.Args[i] != (Term{}) {
			return fmt.Errorf("%s: argument %d set beyond arity %d", what, i, a.Arity)
		}
	}
	for i := 0; i < a.Arity; i++ {
		if a.Args[i].Val == "" {
			return fmt.Errorf("%s: argument %d has empty value", what, i)
		}
	}
	return nil
}

func validateFact(f Fact) error {
	if f.Pred == "" {
		return errors.New("fact: empty predicate")
	}
	if f.Arity < 0 || f.Arity > MaxArity {
		return fmt.Errorf("fact %s: arity %d exceeds maximum %d", f.Pred, f.Arity, MaxArity)
	}
	for i := 0; i < f.Arity; i++ {
		if f.Args[i] == "" {
			return fmt.Errorf("fact %s: argument %d is empty", f.Pred, i)
		}
	}
	for i := f.Arity; i < MaxArity; i++ {
		if f.Args[i] != "" {
			return fmt.Errorf("fact %s: argument %d set beyond arity %d", f.Pred, i, f.Arity)
		}
	}
	return nil
}

// ValidateRule checks that a rule is a safe, function-free, positive
// Datalog clause within the arity limit: non-empty body, every head
// variable occurs in the body (safety, guaranteeing finiteness), and
// no variable occurs only in a negative position (negation is not
// supported, so all body atoms are positive by construction).
func ValidateRule(r Rule) error {
	if err := validateAtom(r.Head, "rule head"); err != nil {
		return err
	}
	if len(r.Body) == 0 {
		return errors.New("rule: empty body (add base facts via Apply)")
	}
	bound := map[string]bool{}
	for i, b := range r.Body {
		if err := validateAtom(b, fmt.Sprintf("rule body atom %d", i)); err != nil {
			return err
		}
		for j := 0; j < b.Arity; j++ {
			if b.Args[j].IsVar {
				bound[b.Args[j].Val] = true
			}
		}
	}
	for j := 0; j < r.Head.Arity; j++ {
		if t := r.Head.Args[j]; t.IsVar && !bound[t.Val] {
			return fmt.Errorf("rule head: variable %q not bound in body (unsafe)", t.Val)
		}
	}
	return nil
}

// substMap maps variable names to constants.
type substMap map[string]string

func matchAtom(a Atom, f Fact, s substMap) (substMap, bool) {
	if a.Pred != f.Pred || a.Arity != f.Arity {
		return nil, false
	}
	ns := s
	copied := false
	for i := 0; i < a.Arity; i++ {
		t := a.Args[i]
		if !t.IsVar {
			if t.Val != f.Args[i] {
				return nil, false
			}
			continue
		}
		if bound, ok := ns[t.Val]; ok {
			if bound != f.Args[i] {
				return nil, false
			}
		} else {
			if !copied {
				ns = make(substMap, len(s)+a.Arity)
				for k, v := range s {
					ns[k] = v
				}
				copied = true
			}
			ns[t.Val] = f.Args[i]
		}
	}
	return ns, true
}

func groundHead(a Atom, s substMap) Fact {
	f := Fact{Pred: a.Pred, Arity: a.Arity}
	for i := 0; i < a.Arity; i++ {
		if a.Args[i].IsVar {
			f.Args[i] = s[a.Args[i].Val]
		} else {
			f.Args[i] = a.Args[i].Val
		}
	}
	return f
}

// Evaluate computes the least fixpoint model of the rules over the
// given base facts, starting from the empty interpretation, and
// records one finite derivation per model fact. Base facts appear in
// the result with a nil-rule derivation.
func Evaluate(base []Fact, rules []Rule) map[Fact]*Derivation {
	model := make(map[Fact]*Derivation, len(base))
	byPred := make(map[string][]Fact)
	add := func(f Fact, d *Derivation) bool {
		if _, ok := model[f]; ok {
			return false
		}
		model[f] = d
		byPred[f.Pred] = append(byPred[f.Pred], f)
		return true
	}
	for _, f := range base {
		add(f, &Derivation{Fact: f})
	}
	for changed := true; changed; {
		changed = false
		for ri := range rules {
			r := &rules[ri]
			type match struct {
				s    substMap
				subs []*Derivation
			}
			partials := []match{{s: substMap{}}}
			for _, bodyAtom := range r.Body {
				var next []match
				for _, p := range partials {
					for _, f := range byPred[bodyAtom.Pred] {
						if ns, ok := matchAtom(bodyAtom, f, p.s); ok {
							subs := make([]*Derivation, len(p.subs), len(p.subs)+1)
							copy(subs, p.subs)
							subs = append(subs, model[f])
							next = append(next, match{s: ns, subs: subs})
						}
					}
				}
				partials = next
				if len(partials) == 0 {
					break
				}
			}
			for _, p := range partials {
				head := groundHead(r.Head, p.s)
				if add(head, &Derivation{Fact: head, Rule: r, Sub: p.subs}) {
					changed = true
				}
			}
		}
	}
	return model
}

// DB is a Datalog rule-and-fact store. Facts change only through
// atomic batches; the derived model is the least fixpoint of the rules
// over the current base facts, recomputed from empty after each batch,
// so no derived fact survives on cyclic mutual support alone.
type DB struct {
	mu    sync.RWMutex
	base  map[Fact]struct{}
	rules []Rule
	model map[Fact]*Derivation
}

// New returns an empty store.
func New() *DB {
	return &DB{
		base:  map[Fact]struct{}{},
		model: map[Fact]*Derivation{},
	}
}

// AddRule validates and installs a rule, then re-derives the model.
func (db *DB) AddRule(r Rule) error {
	if err := ValidateRule(r); err != nil {
		return err
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	db.rules = append(db.rules, r)
	db.deriveLocked()
	return nil
}

// Rules returns a copy of the installed rules.
func (db *DB) Rules() []Rule {
	db.mu.RLock()
	defer db.mu.RUnlock()
	out := make([]Rule, len(db.rules))
	copy(out, db.rules)
	return out
}

// Apply atomically applies a batch of base-fact additions and
// deletions: every fact is validated first, and if any is invalid the
// batch is rejected and the store is left untouched. Deletions are
// recursive in effect: the model is recomputed as the least fixpoint
// over the remaining base facts, so facts that were supported only by
// deleted facts — directly or through mutual recursion — disappear.
// Deleting an absent fact and adding a present fact are no-ops.
func (db *DB) Apply(adds, dels []Fact) error {
	for _, f := range adds {
		if err := validateFact(f); err != nil {
			return fmt.Errorf("batch rejected, nothing applied: %w", err)
		}
	}
	for _, f := range dels {
		if err := validateFact(f); err != nil {
			return fmt.Errorf("batch rejected, nothing applied: %w", err)
		}
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	for _, f := range dels {
		delete(db.base, f)
	}
	for _, f := range adds {
		db.base[f] = struct{}{}
	}
	db.deriveLocked()
	return nil
}

func (db *DB) deriveLocked() {
	base := make([]Fact, 0, len(db.base))
	for f := range db.base {
		base = append(base, f)
	}
	db.model = Evaluate(base, db.rules)
}

// Holds reports whether the fact is in the current model (base or
// derived).
func (db *DB) Holds(f Fact) bool {
	db.mu.RLock()
	defer db.mu.RUnlock()
	_, ok := db.model[f]
	return ok
}

// Facts returns all facts in the current model, sorted.
func (db *DB) Facts() []Fact {
	db.mu.RLock()
	defer db.mu.RUnlock()
	out := make([]Fact, 0, len(db.model))
	for f := range db.model {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

// BaseFacts returns the current base facts, sorted.
func (db *DB) BaseFacts() []Fact {
	db.mu.RLock()
	defer db.mu.RUnlock()
	out := make([]Fact, 0, len(db.base))
	for f := range db.base {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

// Explain returns the finite derivation of a model fact.
func (db *DB) Explain(f Fact) (*Derivation, bool) {
	db.mu.RLock()
	defer db.mu.RUnlock()
	d, ok := db.model[f]
	return d, ok
}

// Query returns the model facts matching the atom (variables are
// wildcards; constants must match exactly), sorted.
func (db *DB) Query(a Atom) []Fact {
	db.mu.RLock()
	defer db.mu.RUnlock()
	var out []Fact
	for f := range db.model {
		if _, ok := matchAtom(a, f, substMap{}); ok {
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
