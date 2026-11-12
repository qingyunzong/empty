package dataeng

import "fmt"

// ModelEdge is one binary-relation tuple of a finite countermodel.
type ModelEdge struct {
	From     string
	To       string
	Relation string
}

// ModelObject lists the concept members and outgoing relation edges of one
// concrete domain object.
type ModelObject struct {
	ID       string
	Concepts []string
	Edges    []ModelEdge
}

// Model is a finite, explicitly enumerated first-order interpretation. Top is
// always the whole Domain and Bottom is always empty, even if a caller omits
// Top from an object's Concepts list.
type Model struct {
	Domain []ModelObject
	Root   string
}

// Edges returns a flat copy of all outgoing edges in the model.
func (m *Model) Edges() []ModelEdge {
	if m == nil {
		return nil
	}
	var out []ModelEdge
	for _, obj := range m.Domain {
		out = append(out, obj.Edges...)
	}
	return out
}

// Objects returns a defensive copy of the domain objects.
func (m *Model) Objects() []ModelObject {
	if m == nil {
		return nil
	}
	out := make([]ModelObject, len(m.Domain))
	for i, obj := range m.Domain {
		out[i] = obj
		out[i].Concepts = append([]string(nil), obj.Concepts...)
		out[i].Edges = append([]ModelEdge(nil), obj.Edges...)
	}
	return out
}

// Object returns the object with the given ID.
func (m *Model) Object(id string) (ModelObject, bool) {
	if m == nil {
		return ModelObject{}, false
	}
	for _, obj := range m.Domain {
		if obj.ID == id {
			obj.Concepts = append([]string(nil), obj.Concepts...)
			obj.Edges = append([]ModelEdge(nil), obj.Edges...)
			return obj, true
		}
	}
	return ModelObject{}, false
}

// VerifyModel evaluates every input axiom directly against the explicit sets
// and relations of m. This checker is independent of the completion algorithm.
func (s *Snapshot) VerifyModel(m *Model) error {
	if m == nil {
		return fmt.Errorf("nil model")
	}
	if len(m.Domain) == 0 {
		return fmt.Errorf("the domain must be non-empty")
	}

	type objectInfo struct {
		concepts map[string]bool
		obj      ModelObject
	}
	objects := make(map[string]*objectInfo, len(m.Domain))
	for i, obj := range m.Domain {
		if obj.ID == "" {
			return fmt.Errorf("object %d has an empty ID", i)
		}
		if _, exists := objects[obj.ID]; exists {
			return fmt.Errorf("duplicate object ID %q", obj.ID)
		}
		if obj.ConceptHas(Bottom) {
			return fmt.Errorf("object %q is in Bottom", obj.ID)
		}
		info := &objectInfo{concepts: make(map[string]bool, len(obj.Concepts)+2), obj: obj}
		info.concepts[Top] = true
		for _, c := range obj.Concepts {
			switch c {
			case Top:
				continue
			case Bottom:
				return fmt.Errorf("object %q contains Bottom", obj.ID)
			}
			if !s.HasConcept(c) {
				return fmt.Errorf("object %q uses unknown concept %q", obj.ID, c)
			}
			info.concepts[c] = true
		}
		objects[obj.ID] = info
	}
	if _, ok := objects[m.Root]; !ok {
		return fmt.Errorf("root object %q is not in the domain", m.Root)
	}

	for _, info := range objects {
		for _, e := range info.obj.Edges {
			if e.From != info.obj.ID {
				return fmt.Errorf("edge on object %q has From %q", info.obj.ID, e.From)
			}
			if _, ok := objects[e.To]; !ok {
				return fmt.Errorf("edge %s -%s-> %s has an unknown target", e.From, e.Relation, e.To)
			}
			if !s.HasRelation(e.Relation) {
				return fmt.Errorf("edge uses unknown relation %q", e.Relation)
			}
		}
	}

	in := func(id, concept string) bool {
		if concept == Top {
			return true
		}
		if concept == Bottom {
			return false
		}
		info := objects[id]
		return info != nil && info.concepts[concept]
	}
	hasSuccessor := func(id, relation, concept string) bool {
		info := objects[id]
		if info == nil {
			return false
		}
		for _, e := range info.obj.Edges {
			if e.Relation == relation && in(e.To, concept) {
				return true
			}
		}
		return false
	}

	for _, a := range s.axioms {
		switch a.Kind {
		case KindInclusion:
			for id := range objects {
				if in(id, a.A) && !in(id, a.B) {
					return fmt.Errorf("axiom %q fails at object %q", a.ID, id)
				}
			}
		case KindIntersectionInclusion:
			for id := range objects {
				if in(id, a.A1) && in(id, a.A2) && !in(id, a.B) {
					return fmt.Errorf("axiom %q fails at object %q", a.ID, id)
				}
			}
		case KindExistentialInclusion:
			for id := range objects {
				if in(id, a.A) && !hasSuccessor(id, a.R, a.B) {
					return fmt.Errorf("axiom %q fails at object %q", a.ID, id)
				}
			}
		case KindExistentialSubsumption:
			for id := range objects {
				info := objects[id]
				for _, e := range info.obj.Edges {
					if e.Relation == a.R && in(e.To, a.A) && !in(id, a.B) {
						return fmt.Errorf("axiom %q fails at object %q", a.ID, id)
					}
				}
			}
		default:
			return fmt.Errorf("axiom %q has unsupported kind %d", a.ID, a.Kind)
		}
	}
	return nil
}

// VerifyCountermodel verifies that m satisfies the snapshot and that its
// designated root belongs to a but not to b.
func (s *Snapshot) VerifyCountermodel(m *Model, a, b string) error {
	if !s.HasConcept(a) {
		return fmt.Errorf("unknown concept %q", a)
	}
	if !s.HasConcept(b) {
		return fmt.Errorf("unknown concept %q", b)
	}
	if err := s.VerifyModel(m); err != nil {
		return err
	}
	root, ok := m.Object(m.Root)
	if !ok {
		return fmt.Errorf("root object %q is missing", m.Root)
	}
	inRoot := func(c string) bool {
		if c == Top {
			return true
		}
		if c == Bottom {
			return false
		}
		return root.ConceptHas(c)
	}
	if !inRoot(a) {
		return fmt.Errorf("root %q is not in %q", m.Root, a)
	}
	if inRoot(b) {
		return fmt.Errorf("root %q is unexpectedly in %q", m.Root, b)
	}
	return nil
}

// VerifyModel is a package-level wrapper for Snapshot.VerifyModel.
func VerifyModel(s *Snapshot, m *Model) error {
	return s.VerifyModel(m)
}

// VerifyCountermodel is a package-level wrapper for
// Snapshot.VerifyCountermodel.
func VerifyCountermodel(s *Snapshot, m *Model, a, b string) error {
	return s.VerifyCountermodel(m, a, b)
}

// ConceptHas reports whether the object's explicit concept list contains c.
func (o ModelObject) ConceptHas(c string) bool {
	for _, have := range o.Concepts {
		if have == c {
			return true
		}
	}
	return false
}

func (c *completion) buildCountermodel(root, notIn int) (*Model, error) {
	if c.labels[root].has(c.bottom) {
		return nil, fmt.Errorf("root concept is forced empty")
	}

	visited := map[int]bool{root: true}
	order := []int{root}
	for cursor := 0; cursor < len(order); cursor++ {
		node := order[cursor]
		for _, edgeIndex := range c.outEdge[node] {
			edge := c.edges[edgeIndex]
			if c.labels[edge.target].has(c.bottom) {
				continue
			}
			if !visited[edge.target] {
				visited[edge.target] = true
				order = append(order, edge.target)
			}
		}
	}

	if len(order) > len(c.snapshot.concepts)+1 {
		return nil, fmt.Errorf("countermodel has %d objects, more than %d", len(order), len(c.snapshot.concepts)+1)
	}

	ids := make(map[int]string, len(order))
	for i, node := range order {
		ids[node] = fmt.Sprintf("o%d", i)
	}

	model := &Model{Domain: make([]ModelObject, 0, len(order)), Root: ids[root]}
	for _, node := range order {
		obj := ModelObject{ID: ids[node], Concepts: make([]string, 0, len(c.names))}
		for concept := 0; concept < len(c.names); concept++ {
			if concept == c.bottom || !c.labels[node].has(concept) {
				continue
			}
			obj.Concepts = append(obj.Concepts, c.names[concept])
		}
		for _, edgeIndex := range c.outEdge[node] {
			edge := c.edges[edgeIndex]
			if !visited[edge.target] {
				continue
			}
			obj.Edges = append(obj.Edges, ModelEdge{
				From:     ids[node],
				To:       ids[edge.target],
				Relation: c.relations[edge.relation],
			})
		}
		model.Domain = append(model.Domain, obj)
	}

	if c.labels[root].has(notIn) {
		return nil, fmt.Errorf("root belongs to the forbidden concept")
	}
	return model, nil
}
