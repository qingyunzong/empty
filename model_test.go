package dataeng

import "testing"

func TestVerifyModelAcceptsAndRejectsDirectly(t *testing.T) {
	s := mustSnapshot(t,
		[]string{"A", "B"},
		[]string{"r"},
		[]Axiom{
			Include("a-in-b", "A", "B"),
			Exists("a-needs-b", "A", "r", "B"),
		})

	good := &Model{
		Root: "o0",
		Domain: []ModelObject{
			{
				ID:       "o0",
				Concepts: []string{"A", "B", "Top"},
				Edges:    []ModelEdge{{From: "o0", To: "o1", Relation: "r"}},
			},
			{ID: "o1", Concepts: []string{"B", "Top"}},
		},
	}
	if err := s.VerifyModel(good); err != nil {
		t.Fatalf("good model rejected: %v", err)
	}
	if err := s.VerifyCountermodel(good, "A", "Bottom"); err != nil {
		t.Fatalf("good countermodel rejected: %v", err)
	}

	cases := []struct {
		name  string
		model *Model
	}{
		{"empty domain", &Model{Root: "o0"}},
		{"missing existential edge", &Model{
			Root: "o0",
			Domain: []ModelObject{
				{ID: "o0", Concepts: []string{"A", "B"}},
				{ID: "o1", Concepts: []string{"B"}},
			},
		}},
		{"Bottom member", &Model{
			Root: "o0",
			Domain: []ModelObject{
				{ID: "o0", Concepts: []string{"A", "B", Bottom}},
				{ID: "o1", Concepts: []string{"B"}},
			},
		}},
		{"inclusion failure", &Model{
			Root: "o0",
			Domain: []ModelObject{
				{ID: "o0", Concepts: []string{"A"}},
			},
		}},
		{"unknown relation", &Model{
			Root: "o0",
			Domain: []ModelObject{
				{ID: "o0", Concepts: []string{"A", "B"}, Edges: []ModelEdge{{From: "o0", To: "o0", Relation: "q"}}},
			},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.VerifyModel(tc.model); err == nil {
				t.Fatalf("expected model rejection")
			}
		})
	}

	// A countermodel root must actually be in A and outside Bottom.
	if err := s.VerifyCountermodel(good, "B", "A"); err == nil {
		t.Fatalf("B object should fail the A-not-B root condition")
	}
}
