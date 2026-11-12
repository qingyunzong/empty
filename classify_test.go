package dataeng

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func mustSnapshot(t *testing.T, concepts, relations []string, axioms []Axiom) *Snapshot {
	t.Helper()
	s, err := NewSnapshot(Vocabulary{Concepts: concepts, Relations: relations}, axioms)
	if err != nil {
		t.Fatalf("NewSnapshot: %v", err)
	}
	return s
}

func mustSubsumes(t *testing.T, c *Classification, a, b string) bool {
	t.Helper()
	got, err := c.Subsumes(a, b)
	if err != nil {
		t.Fatalf("Subsumes(%q,%q): %v", a, b, err)
	}
	return got
}

func mustEmpty(t *testing.T, c *Classification, concept string) bool {
	t.Helper()
	got, err := c.IsEmpty(concept)
	if err != nil {
		t.Fatalf("IsEmpty(%q): %v", concept, err)
	}
	return got
}

func verifyProof(t *testing.T, s *Snapshot, p *Proof) {
	t.Helper()
	if p == nil {
		t.Fatalf("nil proof")
	}
	if err := s.VerifyProof(p); err != nil {
		t.Fatalf("VerifyProof: %v", err)
	}
}

func proofHasRule(p *Proof, rule string) bool {
	for _, step := range p.Steps {
		if step.Rule == rule {
			return true
		}
	}
	return false
}

func countermodel(t *testing.T, c *Classification, a, b string) *Model {
	t.Helper()
	m, err := c.Countermodel(a, b)
	if err != nil {
		t.Fatalf("Countermodel(%q,%q): %v", a, b, err)
	}
	if err := c.Snapshot().VerifyCountermodel(m, a, b); err != nil {
		t.Fatalf("VerifyCountermodel(%q,%q): %v", a, b, err)
	}
	bound := len(c.Snapshot().Concepts()) - 2 + 1
	if len(m.Domain) > bound {
		t.Fatalf("countermodel has %d objects, bound is %d", len(m.Domain), bound)
	}
	return m
}

func TestOnlyConceptEmptyTopSatisfiable(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B", "C"},
		nil,
		[]Axiom{
			Include("a-empty", "A", Bottom),
			Include("b-in-c", "B", "C"),
		})
	c := s.Classify()

	if c.Inconsistent() {
		t.Fatalf("Top should be satisfiable")
	}
	if !mustEmpty(t, c, "A") {
		t.Fatalf("A should be necessarily empty")
	}
	if mustEmpty(t, c, "Top") {
		t.Fatalf("Top must not be empty")
	}
	if mustEmpty(t, c, "B") || mustEmpty(t, c, "C") {
		t.Fatalf("B and C should be non-empty")
	}
	if !mustSubsumes(t, c, "A", "B") {
		t.Fatalf("empty A should be included in B")
	}
	if mustSubsumes(t, c, "Top", Bottom) {
		t.Fatalf("Top should not be included in Bottom")
	}

	proof, err := c.EmptyProof("A")
	if err != nil {
		t.Fatalf("EmptyProof: %v", err)
	}
	verifyProof(t, s, proof)
	if !proofHasRule(proof, RuleSubsumptionEmpty) {
		t.Fatalf("expected empty-left proof rule")
	}

	m := countermodel(t, c, Top, Bottom)
	if len(m.Domain) == 0 {
		t.Fatalf("countermodel domain must be non-empty")
	}
}

func TestTopIncludedInBottomInconsistent(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B"},
		nil,
		[]Axiom{Include("inconsistent", Top, Bottom)})
	c := s.Classify()

	if !c.Inconsistent() {
		t.Fatalf("Top <= Bottom should make the snapshot inconsistent")
	}
	for pair, holds := range c.AllSubsumptions() {
		if !holds {
			t.Fatalf("inconsistent snapshot should entail %s <= %s", pair.A, pair.B)
		}
	}
	for concept, empty := range c.EmptyConcepts() {
		if !empty {
			t.Fatalf("inconsistent snapshot should make %s empty", concept)
		}
	}

	for _, pair := range []ConceptPair{{"A", "B"}, {"B", "A"}, {"A", Top}, {"Top", Bottom}} {
		p, err := c.ProofFor(pair.A, pair.B)
		if err != nil {
			t.Fatalf("ProofFor(%s,%s): %v", pair.A, pair.B, err)
		}
		verifyProof(t, s, p)
		if !proofHasRule(p, RuleSubsumptionInconsistent) {
			t.Fatalf("expected inconsistency rule in proof for %s <= %s", pair.A, pair.B)
		}
	}
	ip, err := c.InconsistencyProof()
	if err != nil {
		t.Fatalf("InconsistencyProof: %v", err)
	}
	verifyProof(t, s, ip)
	conclusion, ok := ip.Conclusion()
	if !ok || conclusion.Kind != FactLabel || conclusion.Node != Top || conclusion.Concept != Bottom {
		t.Fatalf("inconsistency proof conclusion = %+v", conclusion)
	}
	if _, err := c.Countermodel("A", "B"); !errors.Is(err, ErrInconsistent) {
		t.Fatalf("Countermodel error = %v, want ErrInconsistent", err)
	}
}

func TestExistentialCycleIsSatisfiable(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{Exists("cycle", "A", "r", "A")})
	c := s.Classify()

	if c.Inconsistent() {
		t.Fatalf("A <= exists r.A should have a finite cyclic model")
	}
	if mustEmpty(t, c, "A") {
		t.Fatalf("A should not be empty")
	}
	p, err := c.ProofFor("A", "A")
	if err != nil {
		t.Fatalf("ProofFor(A,A): %v", err)
	}
	verifyProof(t, s, p)

	m := countermodel(t, c, "A", "B")
	if len(m.Domain) != 1 {
		t.Fatalf("cyclic witness model domain = %d, want 1", len(m.Domain))
	}
	root, ok := m.Object(m.Root)
	if !ok || !root.ConceptHas("A") || root.ConceptHas("B") {
		t.Fatalf("bad root object: %+v", root)
	}
	if len(root.Edges) != 1 || root.Edges[0].Relation != "r" || root.Edges[0].To != root.ID {
		t.Fatalf("expected one self r edge, got %+v", root.Edges)
	}
}

func TestDistinctExistentialWitnessesAreNotMerged(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B", "C", "D", "E"},
		[]string{"r"},
		[]Axiom{
			Exists("a-to-b", "A", "r", "B"),
			Exists("a-to-c", "A", "r", "C"),
			Intersect("b-and-c", "B", "C", "D"),
			ExistsSubsumed("witness-d", "r", "D", "E"),
		})
	c := s.Classify()
	if mustSubsumes(t, c, "A", "E") {
		t.Fatalf("two separate witnesses must not be merged into one B-and-C object")
	}

	m := countermodel(t, c, "A", "E")
	if len(m.Domain) != 3 {
		t.Fatalf("countermodel domain = %d, want root plus two distinct witnesses", len(m.Domain))
	}
	var bObjects, cObjects int
	for _, obj := range m.Domain {
		hasB, hasC := obj.ConceptHas("B"), obj.ConceptHas("C")
		if hasB {
			bObjects++
		}
		if hasC {
			cObjects++
		}
		if hasB && hasC {
			t.Fatalf("B and C witnesses were incorrectly merged into object %q", obj.ID)
		}
	}
	if bObjects != 1 || cObjects != 1 {
		t.Fatalf("B objects = %d, C objects = %d, want one each", bObjects, cObjects)
	}
	root, _ := m.Object(m.Root)
	if len(root.Edges) != 2 {
		t.Fatalf("root should have two existential edges, got %d", len(root.Edges))
	}

	// The same separation must prevent a false emptiness result when the two
	// witness concepts are declared disjoint.
	s2 := mustSnapshot(t,
		[]string{"A", "B", "C"},
		[]string{"r"},
		[]Axiom{
			Exists("a-to-b", "A", "r", "B"),
			Exists("a-to-c", "A", "r", "C"),
			Intersect("disjoint-witnesses", "B", "C", Bottom),
		})
	c2 := s2.Classify()
	if mustEmpty(t, c2, "A") {
		t.Fatalf("A must remain satisfiable with two distinct disjoint witnesses")
	}
	m2 := countermodel(t, c2, "A", Bottom)
	if len(m2.Domain) != 3 {
		t.Fatalf("expected root plus two witnesses, got %d objects", len(m2.Domain))
	}
}

func TestBottomSuccessorEmptiesPredecessor(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{
			Exists("a-needs-b", "A", "r", "B"),
			Include("b-empty", "B", Bottom),
		})
	c := s.Classify()
	if c.Inconsistent() {
		t.Fatalf("only A and B are empty; Top should still be satisfiable")
	}
	if !mustEmpty(t, c, "A") || !mustEmpty(t, c, "B") {
		t.Fatalf("A and B should both be empty")
	}
	if mustEmpty(t, c, "Top") {
		t.Fatalf("Top should not be empty")
	}

	p, err := c.EmptyProof("A")
	if err != nil {
		t.Fatalf("EmptyProof(A): %v", err)
	}
	verifyProof(t, s, p)
	if !proofHasRule(p, RuleBottomPropagation) {
		t.Fatalf("A's emptiness proof must use bottom-propagation")
	}

	s2 := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{
			Exists("top-needs-b", Top, "r", "B"),
			Include("b-empty", "B", Bottom),
		})
	c2 := s2.Classify()
	if !c2.Inconsistent() {
		t.Fatalf("Top <= exists r.B with empty B must be inconsistent")
	}

	s3 := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{
			Exists("a-needs-bottom", "A", "r", Bottom),
			ExistsSubsumed("vacuous-bottom", "r", Bottom, "B"),
		})
	c3 := s3.Classify()
	if c3.Inconsistent() || !mustEmpty(t, c3, "A") || mustEmpty(t, c3, "B") {
		t.Fatalf("exists r.Bottom should empty A while leaving B and Top satisfiable")
	}

	s4 := mustSnapshot(t,
		[]string{"A", "C", "B"},
		[]string{"r"},
		[]Axiom{
			Include("a-in-c", "A", "C"),
			Exists("c-needs-b", "C", "r", "B"),
			Include("b-empty", "B", Bottom),
		})
	c4 := s4.Classify()
	if c4.Inconsistent() || !mustEmpty(t, c4, "A") || !mustEmpty(t, c4, "C") || !mustEmpty(t, c4, "B") {
		t.Fatalf("emptiness must propagate through inclusion and existential successors")
	}
}

func TestIntersectionAntecedentIsNotSplit(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A1", "A2", "B"},
		nil,
		[]Axiom{
			Intersect("both", "A1", "A2", "B"),
			Include("a1-in-a2", "A1", "A2"),
		})
	c := s.Classify()
	if !mustSubsumes(t, c, "A1", "B") {
		t.Fatalf("A1 <= A2 and A1&A2 <= B should entail A1 <= B")
	}
	p, err := c.ProofFor("A1", "B")
	if err != nil {
		t.Fatalf("ProofFor(A1,B): %v", err)
	}
	verifyProof(t, s, p)
	if !proofHasRule(p, RuleIntersection) {
		t.Fatalf("expected intersection rule in proof")
	}

	if mustSubsumes(t, c, "A2", "B") {
		t.Fatalf("A2 <= B must not follow from the unsplit intersection axiom")
	}
	m := countermodel(t, c, "A2", "B")
	for _, obj := range m.Domain {
		if obj.ConceptHas("A1") && obj.ConceptHas("A2") && !obj.ConceptHas("B") {
			t.Fatalf("countermodel violates the intersection axiom")
		}
	}
}

func TestStatisticsCountOnlyNewFacts(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B", "C"},
		nil,
		[]Axiom{
			Include("a-b", "A", "B"),
			Include("b-c", "B", "C"),
		})
	c := s.Classify()
	stats := c.Statistics()
	if stats.Nodes != 5 {
		t.Fatalf("nodes = %d, want 5 (A,B,C,Top,Bottom)", stats.Nodes)
	}
	if stats.InitialFacts != 9 {
		t.Fatalf("initial facts = %d, want 9", stats.InitialFacts)
	}
	if stats.NewLabelFacts != 3 || stats.NewEdgeFacts != 0 {
		t.Fatalf("new labels/edges = %d/%d, want 3/0", stats.NewLabelFacts, stats.NewEdgeFacts)
	}
	if stats.DerivedFacts() != 3 || stats.TotalFacts() != 12 {
		t.Fatalf("derived/total = %d/%d, want 3/12", stats.DerivedFacts(), stats.TotalFacts())
	}
	if stats.WorkItemsProcessed != 12 {
		t.Fatalf("processed work items = %d, want 12", stats.WorkItemsProcessed)
	}
}

func TestLargeAcyclicChainTerminatesAndReplays(t *testing.T) {
	const n = 100
	concepts := make([]string, 0, n+1)
	relations := []string{"r"}
	axioms := make([]Axiom, 0, 2*(n-1))
	for i := 0; i < n; i++ {
		concepts = append(concepts, fmt.Sprintf("C%d", i))
	}
	concepts = append(concepts, "Z")
	for i := 0; i < n-1; i++ {
		axioms = append(axioms,
			Include(fmt.Sprintf("inc-%d", i), fmt.Sprintf("C%d", i), fmt.Sprintf("C%d", i+1)),
			Exists(fmt.Sprintf("ex-%d", i), fmt.Sprintf("C%d", i), "r", fmt.Sprintf("C%d", i+1)))
	}
	s := mustSnapshot(t, concepts, relations, axioms)
	c := s.Classify()
	if c.Inconsistent() {
		t.Fatalf("large acyclic chain should be satisfiable")
	}
	if !mustSubsumes(t, c, "C0", fmt.Sprintf("C%d", n-1)) {
		t.Fatalf("C0 should imply the end of the chain")
	}
	if mustSubsumes(t, c, "C0", "Z") {
		t.Fatalf("C0 should not imply unrelated Z")
	}

	p, err := c.ProofFor("C0", fmt.Sprintf("C%d", n-1))
	if err != nil {
		t.Fatalf("ProofFor: %v", err)
	}
	verifyProof(t, s, p)
	if len(p.Steps) < n {
		t.Fatalf("proof has only %d steps, expected a non-trivial chain", len(p.Steps))
	}
	countermodel(t, c, "C0", "Z")
}

func TestLargeCyclicCompletionTerminates(t *testing.T) {
	const n = 80
	concepts := make([]string, 0, n+1)
	relations := []string{"r"}
	axioms := make([]Axiom, 0, 2*n)
	for i := 0; i < n; i++ {
		concepts = append(concepts, fmt.Sprintf("C%d", i))
	}
	concepts = append(concepts, "Z")
	for i := 0; i < n; i++ {
		axioms = append(axioms,
			Include(fmt.Sprintf("inc-%d", i), fmt.Sprintf("C%d", i), fmt.Sprintf("C%d", (i+1)%n)),
			Exists(fmt.Sprintf("ex-%d", i), fmt.Sprintf("C%d", i), "r", fmt.Sprintf("C%d", (i+1)%n)))
	}
	s := mustSnapshot(t, concepts, relations, axioms)
	c := s.Classify()
	if c.Inconsistent() {
		t.Fatalf("existential cycle should be satisfiable")
	}
	if !mustSubsumes(t, c, "C0", fmt.Sprintf("C%d", n-1)) ||
		!mustSubsumes(t, c, fmt.Sprintf("C%d", n-1), "C0") {
		t.Fatalf("cyclic inclusions should make all C concepts equivalent")
	}
	p, err := c.ProofFor("C0", fmt.Sprintf("C%d", n-1))
	if err != nil {
		t.Fatalf("ProofFor: %v", err)
	}
	verifyProof(t, s, p)
	m := countermodel(t, c, "C0", "Z")
	if len(m.Domain) > len(concepts)+1 {
		t.Fatalf("countermodel domain %d exceeds bound", len(m.Domain))
	}
}

func TestSnapshotsAndResultsAreImmutable(t *testing.T) {
	concepts := []string{"A", "B"}
	axioms := []Axiom{Include("a-b", "A", "B")}
	s1, err := NewSnapshot(Vocabulary{Concepts: concepts, Relations: nil}, axioms)
	if err != nil {
		t.Fatalf("NewSnapshot: %v", err)
	}
	c1 := s1.Classify()
	if !mustSubsumes(t, c1, "A", "B") || mustEmpty(t, c1, "A") {
		t.Fatalf("unexpected initial classification")
	}

	s2, err := s1.WithAxioms([]Axiom{Include("a-empty", "A", Bottom)})
	if err != nil {
		t.Fatalf("WithAxioms: %v", err)
	}
	c2 := s2.Classify()
	if !mustEmpty(t, c2, "A") {
		t.Fatalf("new snapshot should make A empty")
	}

	c3, err := s1.Reclassify([]Axiom{Include("b-empty", "B", Bottom)})
	if err != nil {
		t.Fatalf("Reclassify: %v", err)
	}
	if !mustEmpty(t, c3, "B") || mustSubsumes(t, c3, "A", "B") {
		t.Fatalf("replacement classification has unexpected results")
	}

	if mustSubsumes(t, c1, "A", Bottom) || mustEmpty(t, c1, "A") {
		t.Fatalf("old classification changed after reclassification")
	}
	if len(s1.Axioms()) != 1 || s1.Axioms()[0].ID != "a-b" {
		t.Fatalf("old snapshot axioms changed")
	}

	concepts[0] = "Mutated"
	axioms[0] = Include("mutated", "Mutated", "B")
	if !s1.HasConcept("A") || s1.HasConcept("Mutated") {
		t.Fatalf("snapshot retained caller's mutable concept slice")
	}
	if len(s1.Axioms()) != 1 || s1.Axioms()[0].A != "A" {
		t.Fatalf("snapshot retained caller's mutable axiom slice")
	}
	gotConcepts := s1.Concepts()
	gotConcepts[0] = "Changed"
	if s1.Concepts()[0] != "A" {
		t.Fatalf("Concepts() did not return a copy")
	}
}

func TestValidationRejectsWholeBatch(t *testing.T) {
	vc := []string{"A", "B"}
	vr := []string{"r"}
	cases := []struct {
		name   string
		axioms []Axiom
	}{
		{"unknown concept", []Axiom{Include("x", "A", "Missing")}},
		{"unknown relation", []Axiom{Exists("x", "A", "missing", "B")}},
		{"unknown relation in inverse", []Axiom{ExistsSubsumed("x", "missing", "A", "B")}},
		{"duplicate ID", []Axiom{Include("same", "A", "B"), Include("same", "B", "A")}},
		{"empty ID", []Axiom{Include("", "A", "B")}},
		{"invalid kind", []Axiom{{ID: "bad", Kind: AxiomKind(99), A: "A", B: "B"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewSnapshot(Vocabulary{Concepts: vc, Relations: vr}, tc.axioms); err == nil {
				t.Fatalf("expected rejection")
			}
		})
	}
}

func TestValidationLimits(t *testing.T) {
	concepts := make([]string, 130)
	for i := range concepts {
		concepts[i] = fmt.Sprintf("C%d", i)
	}
	if _, err := NewSnapshot(Vocabulary{Concepts: concepts}, nil); err == nil {
		t.Fatalf("129 ordinary concepts should be rejected")
	}
	relations := make([]string, 33)
	for i := range relations {
		relations[i] = fmt.Sprintf("r%d", i)
	}
	if _, err := NewSnapshot(Vocabulary{Concepts: []string{"A"}, Relations: relations}, nil); err == nil {
		t.Fatalf("33 relations should be rejected")
	}
	axioms := make([]Axiom, maxAxioms+1)
	for i := range axioms {
		axioms[i] = Include(fmt.Sprintf("id-%d", i), "A", Top)
	}
	if _, err := NewSnapshot(Vocabulary{Concepts: []string{"A"}}, axioms); err == nil {
		t.Fatalf("%d axioms should be rejected", len(axioms))
	}
}

func TestMaximumVocabularyAccepted(t *testing.T) {
	concepts := make([]string, maxConcepts)
	for i := range concepts {
		concepts[i] = fmt.Sprintf("C%d", i)
	}
	relations := make([]string, maxRelations)
	for i := range relations {
		relations[i] = fmt.Sprintf("r%d", i)
	}
	axioms := []Axiom{
		Include("max-inc", concepts[0], concepts[len(concepts)-1]),
		Exists("max-exists", concepts[0], relations[0], concepts[1]),
		ExistsSubsumed("max-exsub", relations[1], concepts[0], concepts[2]),
		Intersect("max-inter", concepts[0], concepts[1], concepts[2]),
	}
	s := mustSnapshot(t, concepts, relations, axioms)
	c := s.Classify()
	if !mustSubsumes(t, c, concepts[0], concepts[len(concepts)-1]) {
		t.Fatalf("maximum vocabulary chain did not classify")
	}
	if len(c.Snapshot().Concepts()) != maxConcepts+2 {
		t.Fatalf("all concepts accessor returned %d names", len(c.Snapshot().Concepts()))
	}
}

func TestUnknownQueryNames(t *testing.T) {
	s := mustSnapshot(t, []string{"A"}, nil, nil)
	c := s.Classify()
	if _, err := c.Subsumes("A", "Nope"); !errors.Is(err, ErrUnknownName) {
		t.Fatalf("Subsumes error = %v", err)
	}
	if _, err := c.IsEmpty("Nope"); !errors.Is(err, ErrUnknownName) {
		t.Fatalf("IsEmpty error = %v", err)
	}
}

func TestEmptyVocabularyOnlyReservedConcepts(t *testing.T) {
	s := mustSnapshot(t, nil, nil, nil)
	c := s.Classify()
	if c.Inconsistent() {
		t.Fatalf("reserved Top should be satisfiable")
	}
	if !mustSubsumes(t, c, Top, Top) || mustSubsumes(t, c, Top, Bottom) {
		t.Fatalf("unexpected reserved-concept classification")
	}
	if !mustEmpty(t, c, Bottom) || mustEmpty(t, c, Top) {
		t.Fatalf("unexpected reserved-concept emptiness")
	}
	m := countermodel(t, c, Top, Bottom)
	if len(m.Domain) != 1 {
		t.Fatalf("reserved-only countermodel domain = %d, want 1", len(m.Domain))
	}
}

func TestProofReplayRejectsCyclicReferences(t *testing.T) {
	s := mustSnapshot(t, []string{"A"}, nil, nil)
	p := &Proof{
		Steps: []ProofStep{
			{ID: 0, Rule: RuleSubsumptionLabel, Premises: []int{1}, Conclusion: Fact{Kind: FactSubsumption, A: "A", B: "A"}},
			{ID: 1, Rule: RuleInitial, Conclusion: Fact{Kind: FactLabel, Node: "A", Concept: "A"}},
		},
		Root: 0,
	}
	if err := s.VerifyProof(p); err == nil {
		t.Fatalf("expected a forward-reference/cycle to be rejected")
	}
}

func TestProofDAGHasNoCycles(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B", "C"},
		[]string{"r"},
		[]Axiom{
			Exists("a-b", "A", "r", "B"),
			ExistsSubsumed("b-c", "r", "B", "C"),
			Include("c-a", "C", "A"),
		})
	c := s.Classify()
	p, err := c.ProofFor("C", "A")
	if err != nil {
		t.Fatalf("ProofFor: %v", err)
	}
	verifyProof(t, s, p)
	last := -1
	for _, step := range p.Steps {
		if step.ID <= last {
			t.Fatalf("proof steps are not topologically ordered")
		}
		for _, premise := range step.Premises {
			if premise >= step.ID {
				t.Fatalf("step %d references non-earlier premise %d", step.ID, premise)
			}
		}
		last = step.ID
	}
	if !strings.Contains(c.Snapshot().Axioms()[0].String(), "exists") {
		t.Fatalf("unexpected axiom rendering")
	}
}

func TestCyclicExistentialProofDoesNotUseItself(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{
			Exists("self-loop", "A", "r", "A"),
			ExistsSubsumed("successor-a", "r", "A", "B"),
		})
	c := s.Classify()
	if !mustSubsumes(t, c, "A", "B") {
		t.Fatalf("A <= exists r.A and exists r.A <= B should entail A <= B")
	}
	p, err := c.ProofFor("A", "B")
	if err != nil {
		t.Fatalf("ProofFor(A,B): %v", err)
	}
	verifyProof(t, s, p)
	if !proofHasRule(p, RuleExists) || !proofHasRule(p, RuleExistsSubsumption) {
		t.Fatalf("expected existential witness and propagation rules")
	}
	seenIDs := make(map[int]bool)
	for _, step := range p.Steps {
		for _, premise := range step.Premises {
			if !seenIDs[premise] {
				t.Fatalf("step %d refers to later/unestablished premise %d", step.ID, premise)
			}
		}
		if seenIDs[step.ID] {
			t.Fatalf("duplicate step ID %d", step.ID)
		}
		seenIDs[step.ID] = true
	}
}

func TestVocabularyAlignmentExample(t *testing.T) {
	ex, err := VocabularyAlignmentExample()
	if err != nil {
		t.Fatalf("VocabularyAlignmentExample: %v", err)
	}
	if !ex.Aligned.Holds || ex.Aligned.Proof == nil {
		t.Fatalf("Visit <= Encounter should be positively proved")
	}
	verifyProof(t, ex.Snapshot, ex.Aligned.Proof)

	if ex.NotAligned.Holds || ex.NotAligned.Countermodel == nil {
		t.Fatalf("Visit <= Doctor should have a countermodel")
	}
	if err := ex.Snapshot.VerifyCountermodel(ex.NotAligned.Countermodel, "Visit", "Doctor"); err != nil {
		t.Fatalf("bad alignment countermodel: %v", err)
	}

	if ex.NotSubject.Holds || ex.NotSubject.Countermodel == nil {
		t.Fatalf("an existential Patient successor must not imply Visit <= Person")
	}
	if err := ex.Snapshot.VerifyCountermodel(ex.NotSubject.Countermodel, "Visit", "Person"); err != nil {
		t.Fatalf("bad subject countermodel: %v", err)
	}
}
