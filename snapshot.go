package dataeng

import "fmt"

const (
	maxConcepts  = 128
	maxRelations = 32
	maxAxioms    = 5000
)

// Snapshot is an immutable, validated vocabulary and axiom set. It never
// shares mutable slices with its caller.
type Snapshot struct {
	concepts  []string // ordinary concepts only
	relations []string
	axioms    []Axiom

	conceptIndex  map[string]int
	relationIndex map[string]int
	axiomByID     map[string]Axiom
}

// Classifier is an alias kept for hosts that prefer the noun "classifier".
type Classifier = Snapshot

// NewSnapshot validates and copies a vocabulary and axiom batch. The whole
// batch is rejected if any name is unknown or any axiom ID is duplicated.
func NewSnapshot(v Vocabulary, axioms []Axiom) (*Snapshot, error) {
	concepts, err := normaliseConcepts(v.Concepts)
	if err != nil {
		return nil, err
	}
	relations, err := normaliseRelations(v.Relations)
	if err != nil {
		return nil, err
	}

	s := &Snapshot{
		concepts:      concepts,
		relations:     relations,
		conceptIndex:  make(map[string]int, len(concepts)+2),
		relationIndex: make(map[string]int, len(relations)),
		axiomByID:     make(map[string]Axiom, len(axioms)),
	}
	for i, c := range concepts {
		s.conceptIndex[c] = i
	}
	s.conceptIndex[Top] = len(concepts)
	s.conceptIndex[Bottom] = len(concepts) + 1
	for i, r := range relations {
		s.relationIndex[r] = i
	}

	if len(axioms) > maxAxioms {
		return nil, fmt.Errorf("too many axioms: %d (maximum %d)", len(axioms), maxAxioms)
	}
	s.axioms = append([]Axiom(nil), axioms...)
	for i, a := range s.axioms {
		if err := s.validateAxiom(a, i); err != nil {
			return nil, err
		}
		if _, exists := s.axiomByID[a.ID]; exists {
			return nil, fmt.Errorf("duplicate axiom ID %q", a.ID)
		}
		s.axiomByID[a.ID] = a
	}
	return s, nil
}

// NewClassifier is equivalent to NewSnapshot.
func NewClassifier(v Vocabulary, axioms []Axiom) (*Classifier, error) {
	return NewSnapshot(v, axioms)
}

// New is a short alias for NewSnapshot.
func New(v Vocabulary, axioms []Axiom) (*Snapshot, error) {
	return NewSnapshot(v, axioms)
}

// BuildSnapshot is a convenience entry point taking parallel name slices.
func BuildSnapshot(concepts, relations []string, axioms []Axiom) (*Snapshot, error) {
	return NewSnapshot(Vocabulary{Concepts: concepts, Relations: relations}, axioms)
}

// Classify is a convenience function that builds a snapshot and classifies it.
func Classify(v Vocabulary, axioms []Axiom) (*Classification, error) {
	s, err := NewSnapshot(v, axioms)
	if err != nil {
		return nil, err
	}
	return s.Classify(), nil
}

func normaliseConcepts(raw []string) ([]string, error) {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, c := range raw {
		if c == "" {
			return nil, fmt.Errorf("empty concept name")
		}
		if c == Top || c == Bottom {
			continue
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	if len(out) > maxConcepts {
		return nil, fmt.Errorf("too many concepts: %d (maximum %d)", len(out), maxConcepts)
	}
	return out, nil
}

func normaliseRelations(raw []string) ([]string, error) {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		if r == "" {
			return nil, fmt.Errorf("empty relation name")
		}
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, r)
	}
	if len(out) > maxRelations {
		return nil, fmt.Errorf("too many relations: %d (maximum %d)", len(out), maxRelations)
	}
	return out, nil
}

func (s *Snapshot) validateAxiom(a Axiom, position int) error {
	if a.ID == "" {
		return fmt.Errorf("axiom at position %d has an empty ID", position)
	}
	checkConcept := func(field, value string) error {
		if _, ok := s.conceptIndex[value]; !ok {
			return fmt.Errorf("axiom %q: unknown concept %q in %s", a.ID, value, field)
		}
		return nil
	}
	checkRelation := func(value string) error {
		if _, ok := s.relationIndex[value]; !ok {
			return fmt.Errorf("axiom %q: unknown relation %q", a.ID, value)
		}
		return nil
	}

	switch a.Kind {
	case KindInclusion:
		if err := checkConcept("A", a.A); err != nil {
			return err
		}
		if err := checkConcept("B", a.B); err != nil {
			return err
		}
	case KindIntersectionInclusion:
		if err := checkConcept("A1", a.A1); err != nil {
			return err
		}
		if err := checkConcept("A2", a.A2); err != nil {
			return err
		}
		if err := checkConcept("B", a.B); err != nil {
			return err
		}
	case KindExistentialInclusion:
		if err := checkConcept("A", a.A); err != nil {
			return err
		}
		if err := checkRelation(a.R); err != nil {
			return err
		}
		if err := checkConcept("B", a.B); err != nil {
			return err
		}
	case KindExistentialSubsumption:
		if err := checkRelation(a.R); err != nil {
			return err
		}
		if err := checkConcept("A", a.A); err != nil {
			return err
		}
		if err := checkConcept("B", a.B); err != nil {
			return err
		}
	default:
		return fmt.Errorf("axiom %q: unsupported axiom kind %d", a.ID, a.Kind)
	}
	return nil
}

// Concepts returns the declared ordinary concepts, followed by Top and
// Bottom. The returned slice is a copy.
func (s *Snapshot) Concepts() []string {
	out := make([]string, 0, len(s.concepts)+2)
	out = append(out, s.concepts...)
	out = append(out, Top, Bottom)
	return out
}

// DeclaredConcepts returns only the ordinary concept names supplied by the
// caller, excluding the reserved Top and Bottom.
func (s *Snapshot) DeclaredConcepts() []string {
	return append([]string(nil), s.concepts...)
}

// AllConcepts is an explicit alias for Concepts.
func (s *Snapshot) AllConcepts() []string {
	return s.Concepts()
}

// Relations returns the declared relation names. The returned slice is a copy.
func (s *Snapshot) Relations() []string {
	return append([]string(nil), s.relations...)
}

// Axioms returns the input axiom batch. The returned slice is a copy.
func (s *Snapshot) Axioms() []Axiom {
	return append([]Axiom(nil), s.axioms...)
}

// HasConcept reports whether name is declared or is Top/Bottom.
func (s *Snapshot) HasConcept(name string) bool {
	_, ok := s.conceptIndex[name]
	return ok
}

// HasRelation reports whether r is a declared relation.
func (s *Snapshot) HasRelation(r string) bool {
	_, ok := s.relationIndex[r]
	return ok
}

// WithAxioms creates a fresh snapshot with the same vocabulary and new axioms.
// Existing snapshots and classifications remain untouched.
func (s *Snapshot) WithAxioms(axioms []Axiom) (*Snapshot, error) {
	return NewSnapshot(Vocabulary{Concepts: s.concepts, Relations: s.relations}, axioms)
}

// ReplaceAxioms is an alias for WithAxioms. It returns a fresh snapshot and
// never mutates the receiver.
func (s *Snapshot) ReplaceAxioms(axioms []Axiom) (*Snapshot, error) {
	return s.WithAxioms(axioms)
}

// Reclassify builds a fresh snapshot with the supplied axiom batch and
// classifies it. The receiver and any earlier Classification are untouched.
func (s *Snapshot) Reclassify(axioms []Axiom) (*Classification, error) {
	replacement, err := s.WithAxioms(axioms)
	if err != nil {
		return nil, err
	}
	return replacement.Classify(), nil
}
