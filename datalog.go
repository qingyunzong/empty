// Package datalog implements a function-free, finite, positive Datalog
// engine. Relations have arity at most MaxArity, rules contain no function
// symbols (terms are only constants or variables) and no negation, so the
// least model is always finite. Every derived fact carries a finite
// derivation (proof tree), and batch fact changes are applied atomically.
package datalog

import (
	"fmt"
	"strings"
)

// MaxArity is the maximum number of arguments a relation may take.
const MaxArity = 3

// Term is a constant or a variable. Function symbols do not exist.
type Term struct {
	Variable bool
	Name     string
}

// V builds a variable term.
func V(name string) Term { return Term{Variable: true, Name: name} }

// C builds a constant term.
func C(name string) Term { return Term{Name: name} }

func (t Term) String() string {
	if t.Variable {
		return "?" + t.Name
	}
	return t.Name
}

// Atom is a predicate applied to terms, used in rule heads and bodies.
type Atom struct {
	Pred string
	Args []Term
}

// Lit builds an Atom.
func Lit(pred string, args ...Term) Atom { return Atom{Pred: pred, Args: args} }

// Fact is a ground atom.
type Fact struct {
	Pred string
	Args []string
}

// F builds a Fact.
func F(pred string, args ...string) Fact { return Fact{Pred: pred, Args: args} }

func (f Fact) key() string { return f.Pred + "(" + strings.Join(f.Args, ",") + ")" }

func (f Fact) String() string { return f.key() }

// Rule is a positive Horn clause: Head :- Body[0], ..., Body[n-1].
type Rule struct {
	Head Atom
	Body []Atom
}

// R builds a Rule.
func R(head Atom, body ...Atom) Rule { return Rule{Head: head, Body: body} }

// Derivation is a finite proof tree for a fact. Rule is the index of the
// rule in the engine's rule set, or -1 for an EDB (base) fact.
type Derivation struct {
	Fact     Fact
	Rule     int
	Children []*Derivation
}

func validateTerm(t Term) error {
	if t.Name == "" {
		return fmt.Errorf("datalog: empty term name")
	}
	return nil
}

func validateAtom(a Atom) error {
	if a.Pred == "" {
		return fmt.Errorf("datalog: empty predicate")
	}
	if len(a.Args) > MaxArity {
		return fmt.Errorf("datalog: predicate %q has arity %d, max is %d", a.Pred, len(a.Args), MaxArity)
	}
	for _, t := range a.Args {
		if err := validateTerm(t); err != nil {
			return err
		}
	}
	return nil
}

// validateRule checks arity limits and safety: every head variable must
// occur in the (positive) body, guaranteeing a finite model.
func validateRule(r Rule) error {
	if err := validateAtom(r.Head); err != nil {
		return err
	}
	bound := map[string]bool{}
	for _, b := range r.Body {
		if err := validateAtom(b); err != nil {
			return err
		}
		for _, t := range b.Args {
			if t.Variable {
				bound[t.Name] = true
			}
		}
	}
	for _, t := range r.Head.Args {
		if t.Variable && !bound[t.Name] {
			return fmt.Errorf("datalog: unsafe rule, head variable ?%s not bound in body", t.Name)
		}
	}
	return nil
}

func validateFact(f Fact) error {
	if f.Pred == "" {
		return fmt.Errorf("datalog: empty predicate")
	}
	if len(f.Args) > MaxArity {
		return fmt.Errorf("datalog: predicate %q has arity %d, max is %d", f.Pred, len(f.Args), MaxArity)
	}
	for _, a := range f.Args {
		if a == "" {
			return fmt.Errorf("datalog: empty constant in fact %s", f)
		}
	}
	return nil
}
