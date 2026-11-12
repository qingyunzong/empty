package dataeng

import "fmt"

// FactKind identifies what a proof step establishes.
type FactKind uint8

const (
	FactInvalid FactKind = iota
	FactLabel
	FactEdge
	FactAxiom
	FactSubsumption
)

// Fact is the conclusion of a proof step. Its populated fields depend on Kind.
//
//	FactLabel:       Node, Concept
//	FactEdge:        Node (source), Relation, Target
//	FactAxiom:       AxiomID
//	FactSubsumption: A, B
type Fact struct {
	Kind FactKind

	Node    string
	Concept string

	Relation string
	Target   string

	AxiomID string

	A string
	B string
}

// Proof rule names. They are exported so a host can display or audit them.
const (
	RuleInitial                 = "initial"
	RuleAxiom                   = "axiom"
	RuleInclude                 = "include"
	RuleIntersection            = "intersection"
	RuleExists                  = "exists"
	RuleExistsSubsumption       = "exists-subsumption"
	RuleBottomPropagation       = "bottom-propagation"
	RuleSubsumptionLabel        = "subsumption-label"
	RuleSubsumptionEmpty        = "subsumption-empty"
	RuleSubsumptionInconsistent = "subsumption-inconsistent"
)

// ProofStep is one node of a finite derivation DAG. Premises always have
// smaller step IDs, so the DAG is acyclic and can be replayed in order.
type ProofStep struct {
	ID         int
	Rule       string
	Premises   []int
	AxiomID    string
	Conclusion Fact
}

// Proof is an independently replayable derivation DAG. Root is the ID of the
// step that establishes the requested fact.
type Proof struct {
	Steps []ProofStep
	Root  int
}

// RootStep returns the proof step establishing the claimed fact.
func (p *Proof) RootStep() (ProofStep, bool) {
	if p == nil {
		return ProofStep{}, false
	}
	return p.Step(p.Root)
}

// Step returns a defensive copy of the step with the given ID.
func (p *Proof) Step(id int) (ProofStep, bool) {
	if p == nil {
		return ProofStep{}, false
	}
	for _, st := range p.Steps {
		if st.ID == id {
			st.Premises = append([]int(nil), st.Premises...)
			return st, true
		}
	}
	return ProofStep{}, false
}

// Conclusion returns the fact established by the root step.
func (p *Proof) Conclusion() (Fact, bool) {
	st, ok := p.RootStep()
	if !ok {
		return Fact{}, false
	}
	return st.Conclusion, true
}

type labelProofKey struct {
	node    int
	concept int
}

type edgeProofKey struct {
	source   int
	relation int
	target   int
}

// VerifyProof independently replays a proof from the snapshot's input axioms
// and initial completion facts. It does not consult the classifier's saturated
// graph. Any malformed, out-of-order, or cyclic reference is rejected.
func (s *Snapshot) VerifyProof(p *Proof) error {
	if p == nil {
		return fmt.Errorf("nil proof")
	}
	if len(p.Steps) == 0 {
		return fmt.Errorf("empty proof")
	}

	byID := make(map[int]int, len(p.Steps))
	for i, st := range p.Steps {
		if _, exists := byID[st.ID]; exists {
			return fmt.Errorf("duplicate proof step ID %d", st.ID)
		}
		for _, premise := range st.Premises {
			if _, ok := byID[premise]; !ok {
				return fmt.Errorf("step %d references premise %d before it is established", st.ID, premise)
			}
		}
		byID[st.ID] = i
	}
	if _, ok := byID[p.Root]; !ok {
		return fmt.Errorf("proof root %d is missing", p.Root)
	}

	stepFact := make(map[int]Fact, len(p.Steps))
	for _, st := range p.Steps {
		if err := s.verifyProofStep(st, stepFact); err != nil {
			return fmt.Errorf("step %d (%s): %w", st.ID, st.Rule, err)
		}
		stepFact[st.ID] = st.Conclusion
	}
	return nil
}

// VerifyProof is a package-level wrapper for Snapshot.VerifyProof.
func VerifyProof(s *Snapshot, p *Proof) error {
	return s.VerifyProof(p)
}

func (s *Snapshot) verifyProofStep(st ProofStep, facts map[int]Fact) error {
	premises := func() ([]Fact, error) {
		out := make([]Fact, 0, len(st.Premises))
		for _, id := range st.Premises {
			f, ok := facts[id]
			if !ok {
				return nil, fmt.Errorf("missing premise %d", id)
			}
			out = append(out, f)
		}
		return out, nil
	}

	switch st.Rule {
	case RuleAxiom:
		if len(st.Premises) != 0 {
			return fmt.Errorf("axiom leaf must not have premises")
		}
		if st.Conclusion.Kind != FactAxiom {
			return fmt.Errorf("axiom leaf must conclude an axiom fact")
		}
		a, ok := s.axiomByID[st.Conclusion.AxiomID]
		if !ok {
			return fmt.Errorf("unknown axiom ID %q", st.Conclusion.AxiomID)
		}
		if st.AxiomID != "" && st.AxiomID != a.ID {
			return fmt.Errorf("step axiom ID %q does not match conclusion %q", st.AxiomID, a.ID)
		}
		return nil

	case RuleInitial:
		if len(st.Premises) != 0 {
			return fmt.Errorf("initial fact must not have premises")
		}
		if st.Conclusion.Kind != FactLabel {
			return fmt.Errorf("initial fact must be a label fact")
		}
		if !s.HasConcept(st.Conclusion.Node) {
			return fmt.Errorf("unknown initial node %q", st.Conclusion.Node)
		}
		if st.Conclusion.Concept != st.Conclusion.Node && st.Conclusion.Concept != Top {
			return fmt.Errorf("initial label must be the node itself or Top")
		}
		return nil

	case RuleInclude:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 2 {
			return fmt.Errorf("include needs a label and an axiom premise")
		}
		label, axiom, ok := findLabelAndAxiom(ps)
		if !ok {
			return fmt.Errorf("include needs one label and one axiom premise")
		}
		a, ok := s.axiomByID[axiom.AxiomID]
		if !ok || a.Kind != KindInclusion {
			return fmt.Errorf("include requires an inclusion axiom")
		}
		if label.Concept != a.A || st.Conclusion.Kind != FactLabel ||
			st.Conclusion.Node != label.Node || st.Conclusion.Concept != a.B {
			return fmt.Errorf("include conclusion does not match its premises")
		}
		return nil

	case RuleIntersection:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 3 {
			return fmt.Errorf("intersection needs two labels and an axiom premise")
		}
		var labels []Fact
		var axiom Fact
		var seenAxiom bool
		for _, f := range ps {
			if f.Kind == FactAxiom {
				if seenAxiom {
					return fmt.Errorf("intersection has more than one axiom premise")
				}
				axiom = f
				seenAxiom = true
			} else if f.Kind == FactLabel {
				labels = append(labels, f)
			} else {
				return fmt.Errorf("intersection has an unexpected premise kind")
			}
		}
		if len(labels) != 2 || !seenAxiom {
			return fmt.Errorf("intersection needs exactly two label premises")
		}
		a, ok := s.axiomByID[axiom.AxiomID]
		if !ok || a.Kind != KindIntersectionInclusion {
			return fmt.Errorf("intersection requires an intersection axiom")
		}
		if labels[0].Node != labels[1].Node || st.Conclusion.Kind != FactLabel ||
			st.Conclusion.Node != labels[0].Node || st.Conclusion.Concept != a.B {
			return fmt.Errorf("intersection conclusion does not match its premises")
		}
		got1, got2 := labels[0].Concept, labels[1].Concept
		if !((got1 == a.A1 && got2 == a.A2) || (got1 == a.A2 && got2 == a.A1)) {
			return fmt.Errorf("intersection labels do not match axiom antecedent")
		}
		return nil

	case RuleExists:
		ps, err := premises()
		if err != nil {
			return err
		}
		label, axiom, ok := findLabelAndAxiom(ps)
		if !ok || len(ps) != 2 {
			return fmt.Errorf("exists needs one label and one axiom premise")
		}
		a, ok := s.axiomByID[axiom.AxiomID]
		if !ok || a.Kind != KindExistentialInclusion {
			return fmt.Errorf("exists requires an existential inclusion axiom")
		}
		if label.Concept != a.A || st.Conclusion.Kind != FactEdge ||
			st.Conclusion.Node != label.Node || st.Conclusion.Relation != a.R ||
			st.Conclusion.Target != a.B {
			return fmt.Errorf("exists conclusion does not match its premises")
		}
		return nil

	case RuleExistsSubsumption:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 3 {
			return fmt.Errorf("exists-subsumption needs an edge, a label, and an axiom")
		}
		var edge, label, axiom Fact
		for _, f := range ps {
			switch f.Kind {
			case FactEdge:
				if edge.Kind == FactEdge {
					return fmt.Errorf("duplicate edge premise")
				}
				edge = f
			case FactLabel:
				if label.Kind == FactLabel {
					return fmt.Errorf("duplicate label premise")
				}
				label = f
			case FactAxiom:
				if axiom.Kind == FactAxiom {
					return fmt.Errorf("duplicate axiom premise")
				}
				axiom = f
			default:
				return fmt.Errorf("unexpected premise kind")
			}
		}
		a, ok := s.axiomByID[axiom.AxiomID]
		if !ok || a.Kind != KindExistentialSubsumption {
			return fmt.Errorf("exists-subsumption requires an existential subsumption axiom")
		}
		if edge.Node == "" || label.Node != edge.Target || label.Concept != a.A ||
			st.Conclusion.Kind != FactLabel || st.Conclusion.Node != edge.Node ||
			st.Conclusion.Concept != a.B || a.R != edge.Relation {
			return fmt.Errorf("exists-subsumption conclusion does not match its premises")
		}
		return nil

	case RuleBottomPropagation:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 2 {
			return fmt.Errorf("bottom-propagation needs an edge and a Bottom label")
		}
		var edge, label Fact
		for _, f := range ps {
			switch f.Kind {
			case FactEdge:
				if edge.Kind == FactEdge {
					return fmt.Errorf("duplicate edge premise")
				}
				edge = f
			case FactLabel:
				if label.Kind == FactLabel {
					return fmt.Errorf("duplicate label premise")
				}
				label = f
			default:
				return fmt.Errorf("unexpected premise kind")
			}
		}
		if label.Concept != Bottom || label.Node != edge.Target ||
			st.Conclusion.Kind != FactLabel || st.Conclusion.Node != edge.Node ||
			st.Conclusion.Concept != Bottom {
			return fmt.Errorf("bottom-propagation conclusion does not match its premises")
		}
		return nil

	case RuleSubsumptionLabel:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 1 || ps[0].Kind != FactLabel || st.Conclusion.Kind != FactSubsumption {
			return fmt.Errorf("label subsumption needs one label premise")
		}
		if ps[0].Node != st.Conclusion.A || ps[0].Concept != st.Conclusion.B {
			return fmt.Errorf("label subsumption conclusion does not match its premise")
		}
		return nil

	case RuleSubsumptionEmpty:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 1 || ps[0].Kind != FactLabel ||
			ps[0].Concept != Bottom || st.Conclusion.Kind != FactSubsumption {
			return fmt.Errorf("empty subsumption needs a Bottom label premise")
		}
		if ps[0].Node != st.Conclusion.A {
			return fmt.Errorf("empty subsumption premise is on the wrong node")
		}
		return nil

	case RuleSubsumptionInconsistent:
		ps, err := premises()
		if err != nil {
			return err
		}
		if len(ps) != 1 || ps[0].Kind != FactLabel ||
			ps[0].Node != Top || ps[0].Concept != Bottom ||
			st.Conclusion.Kind != FactSubsumption {
			return fmt.Errorf("inconsistent subsumption needs Bottom in S(Top)")
		}
		return nil

	default:
		return fmt.Errorf("unknown proof rule %q", st.Rule)
	}
}

func findLabelAndAxiom(facts []Fact) (label Fact, axiom Fact, ok bool) {
	for _, f := range facts {
		switch f.Kind {
		case FactLabel:
			if label.Kind == FactLabel {
				return Fact{}, Fact{}, false
			}
			label = f
		case FactAxiom:
			if axiom.Kind == FactAxiom {
				return Fact{}, Fact{}, false
			}
			axiom = f
		default:
			return Fact{}, Fact{}, false
		}
	}
	return label, axiom, label.Kind == FactLabel && axiom.Kind == FactAxiom
}
