package dataeng

import (
	"fmt"
	"strconv"
	"strings"
)

type evalQuery struct {
	head    []Term
	body    []Atom
	vars    []string
	varIdx  map[string]int
	arities map[string]int
}

type evalDB struct {
	rows map[string][]Tuple
}

type atomPlan struct {
	atom     Atom
	boundPos []int
	rows     []Tuple
	index    map[string][]Tuple
}

type evalRun struct {
	q *evalQuery

	plans      []atomPlan
	binding    []Value
	assigned   []bool
	targeted   bool
	target     Tuple
	found      bool
	results    Tuples
	resultKeys map[string]struct{}
}

func prepareEvalQuery(q Query) (*evalQuery, error) {
	inferred, err := inferSchema(q)
	if err != nil {
		return nil, err
	}
	data, err := prepareQuery("query", q, inferred)
	if err != nil {
		return nil, err
	}

	body := make([]Atom, 0, len(data.body))
	seen := make(map[string]struct{}, len(data.body))
	for _, atom := range data.body {
		key := atomKey(atom)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		body = append(body, atom)
	}

	varIdx := make(map[string]int, len(data.vars))
	for i, variable := range data.vars {
		varIdx[variable] = i
	}
	return &evalQuery{
		head:    data.head,
		body:    body,
		vars:    data.vars,
		varIdx:  varIdx,
		arities: data.arities,
	}, nil
}

func inferSchema(q Query) (map[string]int, error) {
	arities := make(map[string]int)
	for i, atom := range q.Body {
		if len(atom.Terms) == 0 {
			return nil, fmt.Errorf("atom %d on relation %q has zero terms; relation arity must be positive", i, atom.Relation)
		}
		if previous, ok := arities[atom.Relation]; ok && previous != len(atom.Terms) {
			return nil, fmt.Errorf("relation %q is used with arities %d and %d", atom.Relation, previous, len(atom.Terms))
		}
		arities[atom.Relation] = len(atom.Terms)
	}
	return arities, nil
}

func newEvalDB(q *evalQuery, db Database) (*evalDB, error) {
	out := &evalDB{rows: make(map[string][]Tuple, len(q.arities))}
	for relation, arity := range q.arities {
		input := db.Relations[relation]
		seen := make(map[string]struct{}, len(input))
		rows := make([]Tuple, 0, len(input))
		for i, tuple := range input {
			if len(tuple) != arity {
				return nil, fmt.Errorf("relation %q tuple %d has arity %d; expected %d", relation, i, len(tuple), arity)
			}
			for j, value := range tuple {
				if !value.valid() {
					return nil, fmt.Errorf("relation %q tuple %d value %d has invalid kind %d", relation, i, j, value.kind)
				}
			}
			key := tupleKey(tuple)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			rows = append(rows, tuple.Clone())
		}
		sortTuples(rows)
		out.rows[relation] = rows
	}
	return out, nil
}

func buildPlans(q *evalQuery, db *evalDB, initiallyAssigned []bool) []atomPlan {
	bound := make(map[string]bool, len(q.vars))
	for i, variable := range q.vars {
		if initiallyAssigned != nil && initiallyAssigned[i] {
			bound[variable] = true
		}
	}

	remaining := make([]bool, len(q.body))
	for i := range remaining {
		remaining[i] = true
	}
	plans := make([]atomPlan, 0, len(q.body))

	for len(plans) < len(q.body) {
		best := -1
		bestBound := -1
		bestRows := 0
		bestUnbound := 0
		for i, atom := range q.body {
			if !remaining[i] {
				continue
			}
			boundPositions := 0
			unbound := make(map[string]struct{})
			for _, term := range atom.Terms {
				if term.Kind == ConstantTerm {
					boundPositions++
				} else if bound[term.Name] {
					boundPositions++
				} else {
					unbound[term.Name] = struct{}{}
				}
			}
			rows := len(db.rows[atom.Relation])
			candidateUnbound := len(unbound)
			if best == -1 ||
				boundPositions > bestBound ||
				(boundPositions == bestBound && rows < bestRows) ||
				(boundPositions == bestBound && rows == bestRows && candidateUnbound < bestUnbound) ||
				(boundPositions == bestBound && rows == bestRows && candidateUnbound == bestUnbound && i < best) {
				best = i
				bestBound = boundPositions
				bestRows = rows
				bestUnbound = candidateUnbound
			}
		}

		atom := q.body[best]
		rows := db.rows[atom.Relation]
		boundPos := make([]int, 0, len(atom.Terms))
		for i, term := range atom.Terms {
			if term.Kind == ConstantTerm || bound[term.Name] {
				boundPos = append(boundPos, i)
			}
		}
		plan := atomPlan{atom: atom, boundPos: boundPos, rows: rows}
		if len(boundPos) > 0 {
			plan.index = make(map[string][]Tuple, len(rows))
			for _, row := range rows {
				key := partialRowKey(row, boundPos)
				plan.index[key] = append(plan.index[key], row)
			}
		}
		plans = append(plans, plan)
		remaining[best] = false

		for _, term := range atom.Terms {
			if term.Kind == VariableTerm {
				bound[term.Name] = true
			}
		}
	}
	return plans
}

func partialRowKey(row Tuple, positions []int) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(positions)))
	b.WriteByte('|')
	for _, position := range positions {
		appendValueKey(&b, row[position])
	}
	return b.String()
}

func (p atomPlan) candidateRows(q *evalQuery, binding []Value, assigned []bool) ([]Tuple, error) {
	if len(p.boundPos) == 0 {
		return p.rows, nil
	}
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(p.boundPos)))
	b.WriteByte('|')
	for _, position := range p.boundPos {
		term := p.atom.Terms[position]
		switch term.Kind {
		case ConstantTerm:
			appendValueKey(&b, ConstantValue(term.Name))
		case VariableTerm:
			idx, ok := q.varIdx[term.Name]
			if !ok {
				return nil, fmt.Errorf("internal error: unknown variable %q in atom plan", term.Name)
			}
			if !assigned[idx] {
				return nil, fmt.Errorf("internal error: variable %q is used as a bound plan position but is unassigned", term.Name)
			}
			appendValueKey(&b, binding[idx])
		default:
			return nil, fmt.Errorf("internal error: invalid term kind %d", term.Kind)
		}
	}
	return p.index[b.String()], nil
}

func bindHeadTarget(q *evalQuery, target Tuple) ([]Value, []bool, bool) {
	if len(target) != len(q.head) {
		return nil, nil, false
	}
	binding := make([]Value, len(q.vars))
	assigned := make([]bool, len(q.vars))
	for i, term := range q.head {
		switch term.Kind {
		case ConstantTerm:
			if target[i] != ConstantValue(term.Name) {
				return nil, nil, false
			}
		case VariableTerm:
			idx, ok := q.varIdx[term.Name]
			if !ok {
				return nil, nil, false
			}
			if assigned[idx] {
				if binding[idx] != target[i] {
					return nil, nil, false
				}
			} else {
				binding[idx] = target[i]
				assigned[idx] = true
			}
		default:
			return nil, nil, false
		}
	}
	return binding, assigned, true
}

func matchRow(atom Atom, row Tuple, q *evalQuery, binding []Value, assigned []bool) ([]int, bool, error) {
	if len(row) != len(atom.Terms) {
		return nil, false, fmt.Errorf("internal error: row arity %d does not match atom arity %d", len(row), len(atom.Terms))
	}
	newVars := make([]int, 0, len(atom.Terms))
	for i, term := range atom.Terms {
		switch term.Kind {
		case ConstantTerm:
			if row[i] != ConstantValue(term.Name) {
				return newVars, false, nil
			}
		case VariableTerm:
			idx, ok := q.varIdx[term.Name]
			if !ok {
				return newVars, false, fmt.Errorf("internal error: unknown variable %q", term.Name)
			}
			if assigned[idx] {
				if binding[idx] != row[i] {
					return newVars, false, nil
				}
			} else {
				binding[idx] = row[i]
				assigned[idx] = true
				newVars = append(newVars, idx)
			}
		default:
			return newVars, false, fmt.Errorf("internal error: invalid term kind %d", term.Kind)
		}
	}
	return newVars, true, nil
}

func undoAssignments(binding []Value, assigned []bool, vars []int) {
	for _, idx := range vars {
		assigned[idx] = false
		binding[idx] = Value{}
	}
}

func (r *evalRun) substituteHead() (Tuple, error) {
	head := make(Tuple, len(r.q.head))
	for i, term := range r.q.head {
		switch term.Kind {
		case ConstantTerm:
			head[i] = ConstantValue(term.Name)
		case VariableTerm:
			idx, ok := r.q.varIdx[term.Name]
			if !ok {
				return nil, fmt.Errorf("internal error: unknown head variable %q", term.Name)
			}
			if !r.assigned[idx] {
				return nil, fmt.Errorf("head variable %q is unbound", term.Name)
			}
			head[i] = r.binding[idx]
		default:
			return nil, fmt.Errorf("internal error: invalid head term kind %d", term.Kind)
		}
	}
	return head, nil
}

func (r *evalRun) visit(planIndex int) error {
	if r.targeted && r.found {
		return nil
	}
	if planIndex == len(r.plans) {
		head, err := r.substituteHead()
		if err != nil {
			return err
		}
		if r.targeted {
			if head.Equal(r.target) {
				r.found = true
			}
			return nil
		}
		key := tupleKey(head)
		if _, ok := r.resultKeys[key]; ok {
			return nil
		}
		r.resultKeys[key] = struct{}{}
		r.results = append(r.results, head)
		return nil
	}

	plan := r.plans[planIndex]
	rows, err := plan.candidateRows(r.q, r.binding, r.assigned)
	if err != nil {
		return err
	}
	for _, row := range rows {
		newVars, ok, matchErr := matchRow(plan.atom, row, r.q, r.binding, r.assigned)
		if matchErr != nil {
			undoAssignments(r.binding, r.assigned, newVars)
			return matchErr
		}
		if !ok {
			undoAssignments(r.binding, r.assigned, newVars)
			continue
		}
		err := r.visit(planIndex + 1)
		undoAssignments(r.binding, r.assigned, newVars)
		if err != nil {
			return err
		}
		if r.targeted && r.found {
			return nil
		}
	}
	return nil
}

// Evaluate executes a parsed conjunctive query over db under set semantics.
// Relations absent from db are empty. Duplicate database tuples are ignored.
// It does not use sample data to decide containment; this is the independent
// interpreter used to verify generated counterexamples.
func Evaluate(q Query, db Database) (Tuples, error) {
	prepared, err := prepareEvalQuery(q)
	if err != nil {
		return nil, err
	}
	execDB, err := newEvalDB(prepared, db)
	if err != nil {
		return nil, err
	}
	binding := make([]Value, len(prepared.vars))
	assigned := make([]bool, len(prepared.vars))
	run := &evalRun{
		q:          prepared,
		plans:      buildPlans(prepared, execDB, assigned),
		binding:    binding,
		assigned:   assigned,
		results:    make(Tuples, 0),
		resultKeys: make(map[string]struct{}),
	}
	if err := run.visit(0); err != nil {
		return nil, err
	}
	sortTuples(run.results)
	return run.results, nil
}

// ContainsTuple reports whether tuple belongs to q's answer set on db.
// A tuple whose length differs from q's head length does not belong to the
// answer set. The body search starts with all head variables constrained to
// the tuple, which is the interpreter used to verify counterexamples.
func ContainsTuple(q Query, db Database, tuple Tuple) (bool, error) {
	prepared, err := prepareEvalQuery(q)
	if err != nil {
		return false, err
	}
	if len(tuple) != len(prepared.head) {
		return false, nil
	}
	execDB, err := newEvalDB(prepared, db)
	if err != nil {
		return false, err
	}
	binding, assigned, ok := bindHeadTarget(prepared, tuple)
	if !ok {
		return false, nil
	}
	run := &evalRun{
		q:        prepared,
		plans:    buildPlans(prepared, execDB, assigned),
		binding:  binding,
		assigned: assigned,
		targeted: true,
		target:   tuple,
	}
	if err := run.visit(0); err != nil {
		return false, err
	}
	return run.found, nil
}
