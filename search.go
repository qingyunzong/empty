package dataeng

import (
	"fmt"
)

// Cursor is an opaque, resumable containment search state.
//
// A Cursor contains a private snapshot of the validated problem and the exact
// DFS state. Its fields are unexported and it never aliases slices or maps
// supplied by the caller. After a Resume call decides the problem, the cursor
// is marked done and cannot be resumed again.
type Cursor struct {
	problem *problemData

	vars       []string
	candidates []Term
	assign     []Term
	assigned   []bool
	next       []int
	depth      int

	totalSteps int
	done       bool
}

// Progress is a copy of the public portion of a cursor state.
type Progress struct {
	Variables    []string
	Depth        int
	TotalSteps   int
	Assignment   Mapping
	NextVariable string
}

// Progress returns a deep copy of the cursor's progress. Mutating the result
// cannot affect the cursor.
func (c *Cursor) Progress() Progress {
	if c == nil {
		return Progress{}
	}
	variables := append([]string(nil), c.vars...)
	assignment := make(Mapping, 0, len(c.vars))
	for i, variable := range c.vars {
		if c.assigned[i] {
			assignment = append(assignment, Binding{Variable: variable, Target: c.assign[i]})
		}
	}
	nextVariable := ""
	if c.depth >= 0 && c.depth < len(c.vars) {
		nextVariable = c.vars[c.depth]
	}
	return Progress{
		Variables:    variables,
		Depth:        c.depth,
		TotalSteps:   c.totalSteps,
		Assignment:   assignment,
		NextVariable: nextVariable,
	}
}

// TotalSteps returns the number of candidate attempts consumed so far.
func (c *Cursor) TotalSteps() int {
	if c == nil {
		return 0
	}
	return c.totalSteps
}

func newCursor(p *problemData) *Cursor {
	n := len(p.sourceVars)
	return &Cursor{
		problem:    p,
		vars:       append([]string(nil), p.sourceVars...),
		candidates: append([]Term(nil), p.candidates...),
		assign:     make([]Term, n),
		assigned:   make([]bool, n),
		next:       make([]int, n),
		depth:      0,
	}
}

func (c *Cursor) substitute(term Term) (Term, bool) {
	if term.Kind == ConstantTerm {
		return term, true
	}
	pos, ok := c.problem.sourcePos[term.Name]
	if !ok || !c.assigned[pos] {
		return Term{}, false
	}
	return c.assign[pos], true
}

func (p *problemData) compatible(c *Cursor) bool {
	for i, bTerm := range p.b.head {
		aTerm := p.a.head[i]
		switch bTerm.Kind {
		case ConstantTerm:
			if bTerm != aTerm {
				return false
			}
		case VariableTerm:
			pos, ok := p.sourcePos[bTerm.Name]
			if !ok {
				return false
			}
			if c.assigned[pos] && c.assign[pos] != aTerm {
				return false
			}
		default:
			return false
		}
	}

	for _, atom := range p.b.body {
		if !p.atomPartiallyInA(atom, c) {
			return false
		}
	}
	return true
}

func (p *problemData) atomPartiallyInA(atom Atom, c *Cursor) bool {
	aAtoms := p.aAtomsByRel[atom.Relation]
	if len(aAtoms) == 0 {
		return false
	}
	for _, aAtom := range aAtoms {
		if len(aAtom.Terms) != len(atom.Terms) {
			continue
		}
		matchesKnown := true
		for i, bTerm := range atom.Terms {
			var known Term
			knownOK := false
			switch bTerm.Kind {
			case ConstantTerm:
				known = bTerm
				knownOK = true
			case VariableTerm:
				pos, ok := p.sourcePos[bTerm.Name]
				if !ok {
					return false
				}
				if c.assigned[pos] {
					known = c.assign[pos]
					knownOK = true
				}
			default:
				return false
			}
			if knownOK && known != aAtom.Terms[i] {
				matchesKnown = false
				break
			}
		}
		if matchesKnown {
			return true
		}
	}
	return false
}

func (p *problemData) completeOK(c *Cursor) bool {
	for i, bTerm := range p.b.head {
		substituted, ok := c.substitute(bTerm)
		if !ok || substituted != p.a.head[i] {
			return false
		}
	}
	for _, atom := range p.b.body {
		terms := make([]Term, len(atom.Terms))
		for i, bTerm := range atom.Terms {
			substituted, ok := c.substitute(bTerm)
			if !ok {
				return false
			}
			terms[i] = substituted
		}
		bodySet, ok := p.aBodyByRel[atom.Relation]
		if !ok {
			return false
		}
		if _, ok := bodySet[termsKey(terms)]; !ok {
			return false
		}
	}
	return true
}

func (c *Cursor) mapping() (Mapping, error) {
	mapping := make(Mapping, 0, len(c.vars))
	for i, variable := range c.vars {
		if !c.assigned[i] {
			return nil, fmt.Errorf("internal error: variable %q has no target at a complete assignment", variable)
		}
		mapping = append(mapping, Binding{Variable: variable, Target: c.assign[i]})
	}
	return mapping, nil
}

func advance(c *Cursor, budget int) (Result, error) {
	steps := 0
	n := len(c.vars)

	for {
		if c.depth == n {
			if c.problem.completeOK(c) {
				mapping, err := c.mapping()
				if err != nil {
					return Result{}, err
				}
				c.done = true
				return Result{
					Status:     Contained,
					Mapping:    mapping,
					Steps:      steps,
					TotalSteps: c.totalSteps,
				}, nil
			}

			if n == 0 {
				c.depth = -1
				continue
			}

			// A complete assignment failed. This is normally already caught by
			// compatible; backtracking here keeps the state machine total.
			d := c.depth - 1
			c.assigned[d] = false
			c.assign[d] = Term{}
			c.depth = d
			continue
		}

		if c.depth < 0 {
			c.done = true
			counterexample, err := c.problem.buildCounterexample()
			if err != nil {
				return Result{}, err
			}
			return Result{
				Status:         NotContained,
				Counterexample: counterexample,
				Steps:          steps,
				TotalSteps:     c.totalSteps,
			}, nil
		}

		d := c.depth
		if c.next[d] >= len(c.candidates) {
			c.assigned[d] = false
			c.assign[d] = Term{}
			c.depth--
			continue
		}

		// Budget blocks only a new candidate attempt. Backtracking and
		// exhaustion do not consume steps, so a zero-budget resume can still
		// finish a search whose candidate space is already exhausted.
		if steps >= budget {
			return Result{
				Status:     Undecided,
				Cursor:     c,
				Steps:      steps,
				TotalSteps: c.totalSteps,
			}, nil
		}

		candidate := c.candidates[c.next[d]]
		c.next[d]++
		steps++
		c.totalSteps++
		c.assign[d] = candidate
		c.assigned[d] = true

		if c.problem.compatible(c) {
			c.depth = d + 1
			if c.depth < n {
				c.next[c.depth] = 0
				c.assign[c.depth] = Term{}
				c.assigned[c.depth] = false
			}
		} else {
			c.assigned[d] = false
			c.assign[d] = Term{}
		}
	}
}

// Counterexample is a concrete database and head tuple refuting A contained in
// B. It is produced from A only, verified with the query interpreter, and uses
// typed fresh symbols that cannot collide with any user constant.
type Counterexample struct {
	// Database is A's body after replacing each A variable with its fresh
	// symbol. Relations absent from the map are empty. It is under set
	// semantics.
	Database Database
	// Head is A's head tuple under the same replacement.
	Head Tuple
	// AValues records the fresh symbol chosen for each A variable.
	AValues map[string]Value
}

func (p *problemData) buildCounterexample() (*Counterexample, error) {
	fresh := make(map[string]Value, len(p.a.vars))
	for i, variable := range p.a.vars {
		fresh[variable] = FreshValue(i)
	}

	db := Database{Relations: make(map[string][]Tuple)}
	seen := make(map[string]map[string]struct{})
	addTuple := func(relation string, tuple Tuple) {
		relationSeen, ok := seen[relation]
		if !ok {
			relationSeen = make(map[string]struct{})
			seen[relation] = relationSeen
		}
		key := tupleKey(tuple)
		if _, ok := relationSeen[key]; ok {
			return
		}
		relationSeen[key] = struct{}{}
		db.Relations[relation] = append(db.Relations[relation], tuple.Clone())
	}

	for _, atom := range p.a.body {
		tuple := make(Tuple, len(atom.Terms))
		for i, term := range atom.Terms {
			switch term.Kind {
			case ConstantTerm:
				tuple[i] = ConstantValue(term.Name)
			case VariableTerm:
				value, ok := fresh[term.Name]
				if !ok {
					return nil, fmt.Errorf("internal error: no fresh symbol for A variable %q", term.Name)
				}
				tuple[i] = value
			default:
				return nil, fmt.Errorf("internal error: invalid A term kind %d", term.Kind)
			}
		}
		addTuple(atom.Relation, tuple)
	}
	for relation := range db.Relations {
		sortTuples(db.Relations[relation])
	}

	head := make(Tuple, len(p.a.head))
	for i, term := range p.a.head {
		switch term.Kind {
		case ConstantTerm:
			head[i] = ConstantValue(term.Name)
		case VariableTerm:
			value, ok := fresh[term.Name]
			if !ok {
				return nil, fmt.Errorf("internal error: no fresh symbol for A head variable %q", term.Name)
			}
			head[i] = value
		default:
			return nil, fmt.Errorf("internal error: invalid A head term kind %d", term.Kind)
		}
	}

	values := make(map[string]Value, len(fresh))
	for variable, value := range fresh {
		values[variable] = value
	}

	inA, err := ContainsTuple(p.a.toQuery(), db, head)
	if err != nil {
		return nil, fmt.Errorf("verify counterexample in A: %w", err)
	}
	if !inA {
		return nil, fmt.Errorf("internal counterexample verification failed: A does not produce its own head tuple")
	}
	inB, err := ContainsTuple(p.b.toQuery(), db, head)
	if err != nil {
		return nil, fmt.Errorf("verify counterexample outside B: %w", err)
	}
	if inB {
		return nil, fmt.Errorf("internal counterexample verification failed: B also produces the head tuple")
	}

	return &Counterexample{
		Database: db,
		Head:     head,
		AValues:  values,
	}, nil
}
