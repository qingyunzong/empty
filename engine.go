package datalog

import "sort"

// Engine holds a rule set, an extensional database (base facts) and the
// materialized least model with derivations.
type Engine struct {
	rules []Rule
	edb   map[string]Fact
	model map[string]*Derivation
}

// New returns an empty engine.
func New() *Engine {
	return &Engine{
		edb:   map[string]Fact{},
		model: map[string]*Derivation{},
	}
}

// AddRule validates and appends a rule, then re-derives the model.
func (e *Engine) AddRule(r Rule) error {
	if err := validateRule(r); err != nil {
		return err
	}
	e.rules = append(e.rules, r)
	e.model = evaluate(e.rules, e.edb)
	return nil
}

// Rules returns a copy of the current rule set.
func (e *Engine) Rules() []Rule { return append([]Rule(nil), e.rules...) }

// Change is a single fact insertion or deletion.
type Change struct {
	Insert bool
	Fact   Fact
}

// Insert builds an insertion change.
func Insert(f Fact) Change { return Change{Insert: true, Fact: f} }

// Delete builds a deletion change.
func Delete(f Fact) Change { return Change{Fact: f} }

// Apply atomically applies a batch of fact changes: every change is
// validated first, and the model is fully re-derived from the updated EDB.
// If any change is invalid, the engine is left completely untouched.
// Because the model is recomputed as the least fixpoint of rules over the
// remaining base facts, deletion is recursive: facts that only supported
// each other (circular derivations) never survive.
func (e *Engine) Apply(changes ...Change) error {
	edb := make(map[string]Fact, len(e.edb))
	for k, v := range e.edb {
		edb[k] = v
	}
	for _, c := range changes {
		if err := validateFact(c.Fact); err != nil {
			return err
		}
		if c.Insert {
			edb[c.Fact.key()] = c.Fact
		} else {
			delete(edb, c.Fact.key())
		}
	}
	model := evaluate(e.rules, edb)
	e.edb = edb
	e.model = model
	return nil
}

// Contains reports whether the fact holds in the current model.
func (e *Engine) Contains(f Fact) bool {
	_, ok := e.model[f.key()]
	return ok
}

// DerivationOf returns the finite derivation of a fact in the model.
func (e *Engine) DerivationOf(f Fact) (*Derivation, bool) {
	d, ok := e.model[f.key()]
	return d, ok
}

// Model returns all facts (base and derived) in sorted order.
func (e *Engine) Model() []Fact {
	out := make([]Fact, 0, len(e.model))
	for _, d := range e.model {
		out = append(out, d.Fact)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out
}

// EDB returns the base facts in sorted order.
func (e *Engine) EDB() []Fact {
	out := make([]Fact, 0, len(e.edb))
	for _, f := range e.edb {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key() < out[j].key() })
	return out
}

type subst map[string]string

// evaluate computes the least fixpoint of rules over edb, starting from
// the empty intensional database, recording one finite derivation per fact.
func evaluate(rules []Rule, edb map[string]Fact) map[string]*Derivation {
	model := make(map[string]*Derivation, len(edb))
	for k, f := range edb {
		model[k] = &Derivation{Fact: f, Rule: -1}
	}
	for changed := true; changed; {
		changed = false
		for i, r := range rules {
			for _, s := range matchBody(r.Body, model) {
				f := instantiate(r.Head, s)
				k := f.key()
				if _, ok := model[k]; ok {
					continue
				}
				children := make([]*Derivation, len(r.Body))
				for j, b := range r.Body {
					children[j] = model[instantiate(b, s).key()]
				}
				model[k] = &Derivation{Fact: f, Rule: i, Children: children}
				changed = true
			}
		}
	}
	return model
}

// matchBody left-to-right joins the body atoms against the model and
// returns all satisfying substitutions.
func matchBody(body []Atom, model map[string]*Derivation) []subst {
	var out []subst
	var rec func(i int, s subst)
	rec = func(i int, s subst) {
		if i == len(body) {
			out = append(out, s)
			return
		}
		a := body[i]
		for _, d := range model {
			if d.Fact.Pred != a.Pred || len(d.Fact.Args) != len(a.Args) {
				continue
			}
			if ns, ok := unifyArgs(a.Args, d.Fact.Args, s); ok {
				rec(i+1, ns)
			}
		}
	}
	rec(0, subst{})
	return out
}

func unifyArgs(args []Term, ground []string, s subst) (subst, bool) {
	ns := make(subst, len(s)+len(args))
	for k, v := range s {
		ns[k] = v
	}
	for i, t := range args {
		if !t.Variable {
			if t.Name != ground[i] {
				return nil, false
			}
			continue
		}
		if bound, ok := ns[t.Name]; ok {
			if bound != ground[i] {
				return nil, false
			}
		} else {
			ns[t.Name] = ground[i]
		}
	}
	return ns, true
}

// instantiate grounds a rule atom under a substitution. Safety guarantees
// every variable is bound.
func instantiate(a Atom, s subst) Fact {
	f := Fact{Pred: a.Pred, Args: make([]string, len(a.Args))}
	for i, t := range a.Args {
		if t.Variable {
			f.Args[i] = s[t.Name]
		} else {
			f.Args[i] = t.Name
		}
	}
	return f
}
