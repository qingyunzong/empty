package dataeng

import (
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

var (
	// ErrInconsistent means the snapshot has no model because Top is forced
	// to be empty.
	ErrInconsistent = errors.New("axiom set is globally inconsistent")
	// ErrSubsumptionHolds means a requested countermodel does not exist.
	ErrSubsumptionHolds = errors.New("requested subsumption holds in all models")
	// ErrUnknownName means a query used an undeclared concept or relation.
	ErrUnknownName = errors.New("unknown concept or relation")
	// ErrNoProof means the requested positive statement is false.
	ErrNoProof = errors.New("no proof exists for a false statement")
	// ErrNoInconsistency means no inconsistency proof exists.
	ErrNoInconsistency = errors.New("snapshot is consistent")
)

const labelWords = 3 // 128 ordinary concepts + Top + Bottom fit in 130 bits.

type labelSet [labelWords]uint64

func (s *labelSet) has(index int) bool {
	return s[index/64]&(uint64(1)<<uint(index%64)) != 0
}

func (s *labelSet) add(index int) bool {
	word, bit := index/64, uint64(1)<<uint(index%64)
	if s[word]&bit != 0 {
		return false
	}
	s[word] |= bit
	return true
}

func (s *labelSet) forEach(fn func(int)) {
	for word, value := range s {
		for value != 0 {
			offset := bits.TrailingZeros64(value)
			fn(word*64 + offset)
			value &= value - 1
		}
	}
}

type graphEdge struct {
	source   int
	relation int
	target   int
}

type includeRule struct {
	b       int
	axiomID string
	proof   int
}

type intersectionRule struct {
	other   int
	b       int
	axiomID string
	proof   int
}

type existentialRule struct {
	relation int
	b        int
	axiomID  string
	proof    int
}

type existentialSubsumptionRule struct {
	b       int
	axiomID string
	proof   int
}

type workKind uint8

const (
	workLabel workKind = iota
	workEdge
)

type workItem struct {
	kind    workKind
	node    int
	concept int
	edge    int
}

// Stats records the number of distinct new graph facts. Initial facts are the
// labels X and Top placed in every concept node before propagation starts.
// DerivedFacts counts only facts added by a rule after initialisation.
type Stats struct {
	Nodes              int
	InitialFacts       int
	NewLabelFacts      int
	NewEdgeFacts       int
	WorkItemsProcessed int
}

// DerivedFacts is the number of new label and edge facts discovered by rules.
func (s Stats) DerivedFacts() int {
	return s.NewLabelFacts + s.NewEdgeFacts
}

// TotalFacts includes the initial label facts.
func (s Stats) TotalFacts() int {
	return s.InitialFacts + s.DerivedFacts()
}

type proofStore struct {
	steps       []ProofStep
	labelProofs map[labelProofKey]int
	edgeProofs  map[edgeProofKey]int
	axiomProofs map[string]int
}

func newProofStore() *proofStore {
	return &proofStore{
		labelProofs: make(map[labelProofKey]int),
		edgeProofs:  make(map[edgeProofKey]int),
		axiomProofs: make(map[string]int),
	}
}

func (p *proofStore) appendStep(rule string, premises []int, axiomID string, conclusion Fact) int {
	id := len(p.steps)
	premisesCopy := append([]int(nil), premises...)
	p.steps = append(p.steps, ProofStep{
		ID:         id,
		Rule:       rule,
		Premises:   premisesCopy,
		AxiomID:    axiomID,
		Conclusion: conclusion,
	})
	return id
}

func (p *proofStore) closure(root int) *Proof {
	seen := make(map[int]bool)
	stack := []int{root}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id < 0 || id >= len(p.steps) || seen[id] {
			continue
		}
		seen[id] = true
		for _, premise := range p.steps[id].Premises {
			if !seen[premise] {
				stack = append(stack, premise)
			}
		}
	}

	ids := make([]int, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	steps := make([]ProofStep, 0, len(ids))
	for _, id := range ids {
		st := p.steps[id]
		st.Premises = append([]int(nil), st.Premises...)
		steps = append(steps, st)
	}
	return &Proof{Steps: steps, Root: root}
}

type completion struct {
	snapshot  *Snapshot
	names     []string
	relations []string
	top       int
	bottom    int

	labels  []labelSet
	edges   []graphEdge
	outEdge [][]int
	inEdge  [][]int

	stats Stats
	proof *proofStore

	inconsistent bool
	holds        [][]bool
	pairProof    [][]int
	empty        []bool
}

// Classification is an immutable classification result tied to one Snapshot.
type Classification struct {
	snapshot   *Snapshot
	completion *completion
}

// ConceptPair is a queryable ordered concept pair.
type ConceptPair struct {
	A string
	B string
}

// Verdict describes one subsumption query and, when applicable, its proof or
// countermodel.
type Verdict struct {
	A            string
	B            string
	Holds        bool
	Inconsistent bool
	Proof        *Proof
	Countermodel *Model
}

// EmptinessVerdict describes whether a concept is necessarily empty.
type EmptinessVerdict struct {
	Concept      string
	Empty        bool
	Inconsistent bool
	Proof        *Proof
}

// Classify computes the saturated finite completion graph and its subsumption
// closure. It never mutates the snapshot or any prior result.
func (s *Snapshot) Classify() *Classification {
	c := s.complete()
	return &Classification{snapshot: s, completion: c}
}

func (s *Snapshot) complete() *completion {
	names := s.Concepts()
	relations := s.Relations()
	nodes := len(names)
	nrels := len(relations)
	top := s.conceptIndex[Top]
	bottom := s.conceptIndex[Bottom]

	c := &completion{
		snapshot:  s,
		names:     names,
		relations: relations,
		top:       top,
		bottom:    bottom,
		labels:    make([]labelSet, nodes),
		outEdge:   make([][]int, nodes),
		inEdge:    make([][]int, nodes),
		proof:     newProofStore(),
	}
	c.stats.Nodes = nodes

	includeByConcept := make([][]includeRule, nodes)
	intersectionByConcept := make([][]intersectionRule, nodes)
	existentialByConcept := make([][]existentialRule, nodes)
	existentialSubByKey := make([][]existentialSubsumptionRule, nrels*nodes)

	for _, a := range s.axioms {
		proofID := c.proof.appendStep(RuleAxiom, nil, a.ID, Fact{Kind: FactAxiom, AxiomID: a.ID})
		c.proof.axiomProofs[a.ID] = proofID

		switch a.Kind {
		case KindInclusion:
			left := s.conceptIndex[a.A]
			right := s.conceptIndex[a.B]
			includeByConcept[left] = append(includeByConcept[left], includeRule{
				b: right, axiomID: a.ID, proof: proofID,
			})
		case KindIntersectionInclusion:
			left1 := s.conceptIndex[a.A1]
			left2 := s.conceptIndex[a.A2]
			right := s.conceptIndex[a.B]
			intersectionByConcept[left1] = append(intersectionByConcept[left1], intersectionRule{
				other: left2, b: right, axiomID: a.ID, proof: proofID,
			})
			intersectionByConcept[left2] = append(intersectionByConcept[left2], intersectionRule{
				other: left1, b: right, axiomID: a.ID, proof: proofID,
			})
		case KindExistentialInclusion:
			left := s.conceptIndex[a.A]
			right := s.conceptIndex[a.B]
			existentialByConcept[left] = append(existentialByConcept[left], existentialRule{
				relation: s.relationIndex[a.R], b: right, axiomID: a.ID, proof: proofID,
			})
		case KindExistentialSubsumption:
			rel := s.relationIndex[a.R]
			left := s.conceptIndex[a.A]
			right := s.conceptIndex[a.B]
			key := rel*nodes + left
			existentialSubByKey[key] = append(existentialSubByKey[key], existentialSubsumptionRule{
				b: right, axiomID: a.ID, proof: proofID,
			})
		}
	}

	queue := make([]workItem, 0, 2*nodes)
	addInitialLabel := func(node, concept int) {
		if !c.labels[node].add(concept) {
			return
		}
		key := labelProofKey{node: node, concept: concept}
		id := c.proof.appendStep(RuleInitial, nil, "", Fact{
			Kind:    FactLabel,
			Node:    names[node],
			Concept: names[concept],
		})
		c.proof.labelProofs[key] = id
		queue = append(queue, workItem{kind: workLabel, node: node, concept: concept})
		c.stats.InitialFacts++
	}
	for node := range names {
		addInitialLabel(node, node)
		addInitialLabel(node, top)
	}

	edgeSet := make(map[edgeProofKey]bool)
	addEdge := func(source, relation, target int, rule string, premises []int, axiomID string) bool {
		key := edgeProofKey{source: source, relation: relation, target: target}
		if edgeSet[key] {
			return false
		}
		edgeSet[key] = true
		index := len(c.edges)
		c.edges = append(c.edges, graphEdge{source: source, relation: relation, target: target})
		c.outEdge[source] = append(c.outEdge[source], index)
		c.inEdge[target] = append(c.inEdge[target], index)
		id := c.proof.appendStep(rule, premises, axiomID, Fact{
			Kind:     FactEdge,
			Node:     names[source],
			Relation: relations[relation],
			Target:   names[target],
		})
		c.proof.edgeProofs[key] = id
		queue = append(queue, workItem{kind: workEdge, edge: index})
		c.stats.NewEdgeFacts++
		return true
	}
	addLabel := func(node, concept int, rule string, premises []int, axiomID string) bool {
		if !c.labels[node].add(concept) {
			return false
		}
		key := labelProofKey{node: node, concept: concept}
		id := c.proof.appendStep(rule, premises, axiomID, Fact{
			Kind:    FactLabel,
			Node:    names[node],
			Concept: names[concept],
		})
		c.proof.labelProofs[key] = id
		queue = append(queue, workItem{kind: workLabel, node: node, concept: concept})
		c.stats.NewLabelFacts++
		return true
	}

	for cursor := 0; cursor < len(queue); cursor++ {
		item := queue[cursor]
		c.stats.WorkItemsProcessed++
		switch item.kind {
		case workLabel:
			node, concept := item.node, item.concept
			labelID := c.proof.labelProofs[labelProofKey{node: node, concept: concept}]

			for _, rule := range includeByConcept[concept] {
				addLabel(node, rule.b, RuleInclude, []int{labelID, rule.proof}, rule.axiomID)
			}
			for _, rule := range intersectionByConcept[concept] {
				if c.labels[node].has(rule.other) {
					otherID := c.proof.labelProofs[labelProofKey{node: node, concept: rule.other}]
					addLabel(node, rule.b, RuleIntersection, []int{labelID, otherID, rule.proof}, rule.axiomID)
				}
			}
			for _, rule := range existentialByConcept[concept] {
				addEdge(node, rule.relation, rule.b, RuleExists, []int{labelID, rule.proof}, rule.axiomID)
			}

			for _, edgeIndex := range c.inEdge[node] {
				edge := c.edges[edgeIndex]
				for _, rule := range existentialSubByKey[edge.relation*nodes+concept] {
					edgeID := c.proof.edgeProofs[edgeProofKey{
						source: edge.source, relation: edge.relation, target: edge.target,
					}]
					addLabel(edge.source, rule.b, RuleExistsSubsumption,
						[]int{edgeID, labelID, rule.proof}, rule.axiomID)
				}
			}
			if concept == bottom {
				for _, edgeIndex := range c.inEdge[node] {
					edge := c.edges[edgeIndex]
					edgeID := c.proof.edgeProofs[edgeProofKey{
						source: edge.source, relation: edge.relation, target: edge.target,
					}]
					bottomID := c.proof.labelProofs[labelProofKey{node: node, concept: bottom}]
					addLabel(edge.source, bottom, RuleBottomPropagation,
						[]int{edgeID, bottomID}, "")
				}
			}

		case workEdge:
			edge := c.edges[item.edge]
			edgeID := c.proof.edgeProofs[edgeProofKey{
				source: edge.source, relation: edge.relation, target: edge.target,
			}]
			c.labels[edge.target].forEach(func(concept int) {
				for _, rule := range existentialSubByKey[edge.relation*nodes+concept] {
					labelID := c.proof.labelProofs[labelProofKey{node: edge.target, concept: concept}]
					addLabel(edge.source, rule.b, RuleExistsSubsumption,
						[]int{edgeID, labelID, rule.proof}, rule.axiomID)
				}
			})
			if c.labels[edge.target].has(bottom) {
				labelID := c.proof.labelProofs[labelProofKey{node: edge.target, concept: bottom}]
				addLabel(edge.source, bottom, RuleBottomPropagation, []int{edgeID, labelID}, "")
			}
		}
	}

	c.inconsistent = c.labels[top].has(bottom)
	c.empty = make([]bool, nodes)
	c.holds = make([][]bool, nodes)
	c.pairProof = make([][]int, nodes)
	for a := 0; a < nodes; a++ {
		c.holds[a] = make([]bool, nodes)
		c.pairProof[a] = make([]int, nodes)
		for b := 0; b < nodes; b++ {
			c.pairProof[a][b] = -1
		}
	}

	var bottomTopProof int
	if c.inconsistent {
		bottomTopProof = c.proof.labelProofs[labelProofKey{node: top, concept: bottom}]
	}
	for a := 0; a < nodes; a++ {
		c.empty[a] = c.inconsistent || c.labels[a].has(bottom)
		for b := 0; b < nodes; b++ {
			var root int
			switch {
			case c.inconsistent:
				root = c.proof.appendStep(RuleSubsumptionInconsistent, []int{bottomTopProof}, "",
					Fact{Kind: FactSubsumption, A: names[a], B: names[b]})
			case c.labels[a].has(bottom):
				emptyID := c.proof.labelProofs[labelProofKey{node: a, concept: bottom}]
				root = c.proof.appendStep(RuleSubsumptionEmpty, []int{emptyID}, "",
					Fact{Kind: FactSubsumption, A: names[a], B: names[b]})
			case c.labels[a].has(b):
				labelID := c.proof.labelProofs[labelProofKey{node: a, concept: b}]
				root = c.proof.appendStep(RuleSubsumptionLabel, []int{labelID}, "",
					Fact{Kind: FactSubsumption, A: names[a], B: names[b]})
			default:
				continue
			}
			c.holds[a][b] = true
			c.pairProof[a][b] = root
		}
	}
	return c
}

// Snapshot returns the immutable snapshot this result belongs to.
func (c *Classification) Snapshot() *Snapshot {
	return c.snapshot
}

// Inconsistent reports whether Top is necessarily empty. In that case every
// subsumption is true and every concept is necessarily empty.
func (c *Classification) Inconsistent() bool {
	return c.completion.inconsistent
}

// Consistent reports whether at least one non-empty-domain model exists.
func (c *Classification) Consistent() bool {
	return !c.completion.inconsistent
}

// Statistics returns the completion graph's new-fact counters.
func (c *Classification) Statistics() Stats {
	return c.completion.stats
}

func (c *Classification) conceptIndex(name string) (int, error) {
	index, ok := c.snapshot.conceptIndex[name]
	if !ok {
		return 0, fmt.Errorf("%w: concept %q", ErrUnknownName, name)
	}
	return index, nil
}

// Subsumes reports whether A is included in B in every model of the snapshot.
func (c *Classification) Subsumes(a, b string) (bool, error) {
	ai, err := c.conceptIndex(a)
	if err != nil {
		return false, err
	}
	bi, err := c.conceptIndex(b)
	if err != nil {
		return false, err
	}
	return c.completion.holds[ai][bi], nil
}

// IsEmpty reports whether a concept is necessarily empty in every model.
func (c *Classification) IsEmpty(concept string) (bool, error) {
	ci, err := c.conceptIndex(concept)
	if err != nil {
		return false, err
	}
	return c.completion.empty[ci], nil
}

// AllSubsumptions returns a copy of the complete concept-pair classification.
func (c *Classification) AllSubsumptions() map[ConceptPair]bool {
	out := make(map[ConceptPair]bool, len(c.completion.names)*len(c.completion.names))
	for a, nameA := range c.completion.names {
		for b, nameB := range c.completion.names {
			out[ConceptPair{A: nameA, B: nameB}] = c.completion.holds[a][b]
		}
	}
	return out
}

// EmptyConcepts returns a copy of the concept emptiness classification.
func (c *Classification) EmptyConcepts() map[string]bool {
	out := make(map[string]bool, len(c.completion.names))
	for i, name := range c.completion.names {
		out[name] = c.completion.empty[i]
	}
	return out
}

// ProofFor returns a finite derivation DAG for a true subsumption. Its axiom
// leaves and initial-fact leaves can be replayed with Snapshot.VerifyProof.
func (c *Classification) ProofFor(a, b string) (*Proof, error) {
	ai, err := c.conceptIndex(a)
	if err != nil {
		return nil, err
	}
	bi, err := c.conceptIndex(b)
	if err != nil {
		return nil, err
	}
	if !c.completion.holds[ai][bi] {
		return nil, fmt.Errorf("%w: %s <= %s", ErrNoProof, a, b)
	}
	return c.completion.proof.closure(c.completion.pairProof[ai][bi]), nil
}

// Proof is an alias for ProofFor.
func (c *Classification) Proof(a, b string) (*Proof, error) {
	return c.ProofFor(a, b)
}

// EmptyProof returns the proof that is also the derivation of concept <=
// Bottom.
func (c *Classification) EmptyProof(concept string) (*Proof, error) {
	empty, err := c.IsEmpty(concept)
	if err != nil {
		return nil, err
	}
	if !empty {
		return nil, fmt.Errorf("%w: concept %q is not empty", ErrNoProof, concept)
	}
	return c.ProofFor(concept, Bottom)
}

// Explain returns either a replayable proof or a verified countermodel.
func (c *Classification) Explain(a, b string) (*Verdict, error) {
	holds, err := c.Subsumes(a, b)
	if err != nil {
		return nil, err
	}
	v := &Verdict{A: a, B: b, Holds: holds, Inconsistent: c.Inconsistent()}
	if holds {
		v.Proof, err = c.ProofFor(a, b)
		if err != nil {
			return nil, err
		}
		return v, nil
	}
	v.Countermodel, err = c.Countermodel(a, b)
	if err != nil {
		return nil, err
	}
	return v, nil
}

// ExplainEmpty returns the emptiness result and, when empty, its proof.
func (c *Classification) ExplainEmpty(concept string) (*EmptinessVerdict, error) {
	empty, err := c.IsEmpty(concept)
	if err != nil {
		return nil, err
	}
	v := &EmptinessVerdict{Concept: concept, Empty: empty, Inconsistent: c.Inconsistent()}
	if empty {
		v.Proof, err = c.EmptyProof(concept)
		if err != nil {
			return nil, err
		}
	}
	return v, nil
}

// InconsistencyProof returns the derivation that Bottom belongs to Top.
func (c *Classification) InconsistencyProof() (*Proof, error) {
	if !c.completion.inconsistent {
		return nil, ErrNoInconsistency
	}
	root := c.completion.proof.labelProofs[labelProofKey{
		node: c.completion.top, concept: c.completion.bottom,
	}]
	return c.completion.proof.closure(root), nil
}

// Countermodel constructs a finite model whose root belongs to a and not to
// b. It verifies the constructed model with the independent direct checker.
func (c *Classification) Countermodel(a, b string) (*Model, error) {
	ai, err := c.conceptIndex(a)
	if err != nil {
		return nil, err
	}
	bi, err := c.conceptIndex(b)
	if err != nil {
		return nil, err
	}
	if c.completion.inconsistent {
		return nil, fmt.Errorf("%w: cannot build a model for %s <= %s", ErrInconsistent, a, b)
	}
	if c.completion.holds[ai][bi] {
		return nil, fmt.Errorf("%w: %s <= %s", ErrSubsumptionHolds, a, b)
	}
	m, err := c.completion.buildCountermodel(ai, bi)
	if err != nil {
		return nil, err
	}
	if err := c.snapshot.VerifyCountermodel(m, a, b); err != nil {
		return nil, fmt.Errorf("internal countermodel verification failed: %w", err)
	}
	return m, nil
}
