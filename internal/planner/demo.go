package planner

// DemoSpec returns a built-in spec with the maximum 18 candidate assertions
// and 12 fault models, exercising mutex side effects, prerequisite chains,
// and indistinguishable models.
func DemoSpec() Spec {
	assertions := []Assertion{
		{ID: "A01", Cost: 9},
		{ID: "A02", Cost: 4, Requires: []string{"A01"}},
		{ID: "A03", Cost: 3},
		{ID: "A04", Cost: 6, Mutex: []string{"A05"}},
		{ID: "A05", Cost: 2},
		{ID: "A06", Cost: 5, Requires: []string{"A05"}},
		{ID: "A07", Cost: 7, Mutex: []string{"A03"}},
		{ID: "A08", Cost: 1},
		{ID: "A09", Cost: 8, Requires: []string{"A08"}},
		{ID: "A10", Cost: 3, Mutex: []string{"A11"}},
		{ID: "A11", Cost: 4},
		{ID: "A12", Cost: 2},
		{ID: "A13", Cost: 6, Requires: []string{"A12"}},
		{ID: "A14", Cost: 5},
		{ID: "A15", Cost: 3, Mutex: []string{"A14"}},
		{ID: "A16", Cost: 4},
		{ID: "A17", Cost: 2, Requires: []string{"A16"}},
		{ID: "A18", Cost: 10},
	}
	// flips lists the assertions whose outcome each fault model flips
	// relative to the normal model. F11 and F12 flip nothing and are
	// therefore indistinguishable from normal.
	flips := map[string][]string{
		"F01": {"A01", "A03", "A08"},
		"F02": {"A02", "A09"},
		"F03": {"A03", "A04", "A15"},
		"F04": {"A05", "A06"},
		"F05": {"A04", "A07", "A18"},
		"F06": {"A08", "A10", "A12"},
		"F07": {"A11", "A13"},
		"F08": {"A12", "A14", "A16"},
		"F09": {"A15", "A17"},
		"F10": {"A01", "A18"},
		"F11": {},
		"F12": {},
	}
	models := []Model{{ID: "NORM", Outcomes: map[string]bool{}}}
	for _, a := range assertions {
		models[0].Outcomes[a.ID] = false
	}
	for _, id := range []string{"F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09", "F10", "F11", "F12"} {
		out := map[string]bool{}
		for _, a := range assertions {
			out[a.ID] = false
		}
		for _, f := range flips[id] {
			out[f] = true
		}
		models = append(models, Model{ID: id, Outcomes: out})
	}
	return Spec{NormalID: "NORM", Assertions: assertions, Models: models}
}
