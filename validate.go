package dataeng

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type queryData struct {
	head      []Term
	body      []Atom
	vars      []string
	constants []string
	arities   map[string]int
}

func validateSchema(schema Schema) (map[string]int, error) {
	out := make(map[string]int, len(schema.Arities))
	for relation, arity := range schema.Arities {
		if arity <= 0 {
			return nil, fmt.Errorf("relation %q has arity %d; arity must be positive", relation, arity)
		}
		out[relation] = arity
	}
	return out, nil
}

func validateTerm(t Term, context string) error {
	if t.Kind != VariableTerm && t.Kind != ConstantTerm {
		return fmt.Errorf("%s has invalid term kind %d", context, t.Kind)
	}
	return nil
}

func copyTerms(in []Term) []Term {
	return append([]Term(nil), in...)
}

func copyAtoms(in []Atom) []Atom {
	out := make([]Atom, len(in))
	for i, atom := range in {
		out[i] = Atom{
			Relation: atom.Relation,
			Terms:    copyTerms(atom.Terms),
		}
	}
	return out
}

func prepareQuery(label string, q Query, schema map[string]int) (*queryData, error) {
	if len(q.Body) > 20 {
		return nil, fmt.Errorf("%s has %d atoms; limit is 20", label, len(q.Body))
	}

	head := copyTerms(q.Head)
	body := make([]Atom, len(q.Body))
	varSet := make(map[string]struct{})
	constSet := make(map[string]struct{})
	arities := make(map[string]int)

	for i, atom := range q.Body {
		arity, ok := schema[atom.Relation]
		if !ok {
			return nil, fmt.Errorf("%s atom %d uses relation %q, which is not in the schema", label, i, atom.Relation)
		}
		if len(atom.Terms) != arity {
			return nil, fmt.Errorf("%s atom %d on relation %q has %d terms; schema arity is %d",
				label, i, atom.Relation, len(atom.Terms), arity)
		}
		terms := copyTerms(atom.Terms)
		for j, term := range terms {
			if err := validateTerm(term, fmt.Sprintf("%s atom %d term %d", label, i, j)); err != nil {
				return nil, err
			}
			if term.Kind == VariableTerm {
				varSet[term.Name] = struct{}{}
			} else {
				constSet[term.Name] = struct{}{}
			}
		}
		body[i] = Atom{Relation: atom.Relation, Terms: terms}
		arities[atom.Relation] = arity
	}

	if len(varSet) > 12 {
		return nil, fmt.Errorf("%s has %d variables; limit is 12", label, len(varSet))
	}

	headVarSet := make(map[string]struct{})
	for i, term := range head {
		if err := validateTerm(term, fmt.Sprintf("%s head term %d", label, i)); err != nil {
			return nil, err
		}
		if term.Kind == VariableTerm {
			headVarSet[term.Name] = struct{}{}
		} else {
			constSet[term.Name] = struct{}{}
		}
	}
	for name := range headVarSet {
		if _, ok := varSet[name]; !ok {
			return nil, fmt.Errorf("%s head variable %q does not occur in the body", label, name)
		}
	}

	if len(body) == 0 {
		for i, term := range head {
			if term.Kind != ConstantTerm {
				return nil, fmt.Errorf("%s has an empty body but head term %d is a variable; empty-body heads must be constant", label, i)
			}
		}
	}

	vars := make([]string, 0, len(varSet))
	for name := range varSet {
		vars = append(vars, name)
	}
	sort.Strings(vars)

	constants := make([]string, 0, len(constSet))
	for value := range constSet {
		constants = append(constants, value)
	}
	sort.Strings(constants)

	return &queryData{
		head:      head,
		body:      body,
		vars:      vars,
		constants: constants,
		arities:   arities,
	}, nil
}

func (q *queryData) toQuery() Query {
	return Query{
		Head: copyTerms(q.head),
		Body: copyAtoms(q.body),
	}
}

type problemData struct {
	schema map[string]int
	a      *queryData
	b      *queryData

	aAtomsByRel map[string][]Atom
	aBodyByRel  map[string]map[string]struct{}

	sourceVars []string
	sourcePos  map[string]int
	candidates []Term

	canonical string
}

// Problem is one containment question: is A contained in B?
//
// A is the query whose answers must be a subset of B's answers for every
// finite database. Check(problem, ...) therefore searches for a homomorphism
// from B's variables into A's body variables and both queries' constants.
type Problem struct {
	Schema Schema
	A      Query
	B      Query
}

// Reverse swaps A and B using the same schema.
func (p Problem) Reverse() Problem {
	return Problem{Schema: p.Schema, A: p.B, B: p.A}
}

func prepareProblem(problem Problem) (*problemData, error) {
	schema, err := validateSchema(problem.Schema)
	if err != nil {
		return nil, err
	}
	a, err := prepareQuery("A", problem.A, schema)
	if err != nil {
		return nil, err
	}
	b, err := prepareQuery("B", problem.B, schema)
	if err != nil {
		return nil, err
	}
	if len(a.head) != len(b.head) {
		return nil, fmt.Errorf("A and B head lengths differ: %d and %d", len(a.head), len(b.head))
	}

	p := &problemData{
		schema:      schema,
		a:           a,
		b:           b,
		aAtomsByRel: make(map[string][]Atom),
		aBodyByRel:  make(map[string]map[string]struct{}),
		sourceVars:  append([]string(nil), b.vars...),
		sourcePos:   make(map[string]int, len(b.vars)),
	}
	for i, name := range p.sourceVars {
		p.sourcePos[name] = i
	}

	atomSeen := make(map[string]struct{}, len(a.body))
	for _, atom := range a.body {
		key := atomKey(atom)
		if _, ok := atomSeen[key]; !ok {
			atomSeen[key] = struct{}{}
			p.aAtomsByRel[atom.Relation] = append(p.aAtomsByRel[atom.Relation], atom)
		}
		bodySet, ok := p.aBodyByRel[atom.Relation]
		if !ok {
			bodySet = make(map[string]struct{})
			p.aBodyByRel[atom.Relation] = bodySet
		}
		bodySet[termsKey(atom.Terms)] = struct{}{}
	}

	constSet := make(map[string]struct{}, len(a.constants)+len(b.constants))
	for _, value := range a.constants {
		constSet[value] = struct{}{}
	}
	for _, value := range b.constants {
		constSet[value] = struct{}{}
	}
	constants := make([]string, 0, len(constSet))
	for value := range constSet {
		constants = append(constants, value)
	}
	sort.Strings(constants)

	p.candidates = make([]Term, 0, len(constants)+len(a.vars))
	for _, value := range constants {
		p.candidates = append(p.candidates, Const(value))
	}
	for _, name := range a.vars {
		p.candidates = append(p.candidates, Var(name))
	}

	p.canonical = canonicalProblem(schema, a, b)
	return p, nil
}

func canonicalProblem(schema map[string]int, a, b *queryData) string {
	var out strings.Builder
	out.WriteString("schema|")
	relations := make([]string, 0, len(schema))
	for relation := range schema {
		relations = append(relations, relation)
	}
	sort.Strings(relations)
	appendInt(&out, len(relations))
	for _, relation := range relations {
		appendString(&out, relation)
		appendInt(&out, schema[relation])
	}
	out.WriteString("A|")
	appendQueryCanonical(&out, a)
	out.WriteString("B|")
	appendQueryCanonical(&out, b)
	return out.String()
}

func appendQueryCanonical(out *strings.Builder, q *queryData) {
	appendInt(out, len(q.head))
	for _, term := range q.head {
		appendTermCanonical(out, term)
	}
	appendInt(out, len(q.body))
	for _, atom := range q.body {
		appendString(out, atom.Relation)
		appendInt(out, len(atom.Terms))
		for _, term := range atom.Terms {
			appendTermCanonical(out, term)
		}
	}
}

func appendTermCanonical(out *strings.Builder, term Term) {
	appendInt(out, int(term.Kind))
	appendString(out, term.Name)
}

func appendInt(out *strings.Builder, value int) {
	out.WriteString(strconv.Itoa(value))
	out.WriteByte(';')
}

func appendString(out *strings.Builder, value string) {
	out.WriteString(strconv.Itoa(len(value)))
	out.WriteByte(':')
	out.WriteString(value)
	out.WriteByte(';')
}
