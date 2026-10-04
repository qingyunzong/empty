package checker

import "testing"

func TestInputLimits(t *testing.T) {
	valid := Spec{
		States:  []string{"s0"},
		Initial: "s0",
		Events:  []string{"a"},
	}
	if _, err := NewModel(valid); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}

	cases := map[string]Spec{
		"9 states": {
			States:  []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"},
			Initial: "s0",
			Events:  []string{"a"},
		},
		"6 events": {
			States:  []string{"s0"},
			Initial: "s0",
			Events:  []string{"a", "b", "c", "d", "e", "f"},
		},
		"budget 11": {
			States:  []string{"s0"},
			Initial: "s0",
			Events:  []string{"a"},
			Budget:  ptr(11),
		},
		"negative budget": {
			States:  []string{"s0"},
			Initial: "s0",
			Events:  []string{"a"},
			Budget:  ptr(-1),
		},
		"duplicate state": {
			States:  []string{"s0", "s0"},
			Initial: "s0",
			Events:  []string{"a"},
		},
		"unknown initial": {
			States:  []string{"s0"},
			Initial: "s9",
			Events:  []string{"a"},
		},
		"unknown transition state": {
			States:      []string{"s0"},
			Initial:     "s0",
			Events:      []string{"a"},
			Transitions: []Transition{{From: "s0", Event: "a", To: "s9"}},
		},
		"unknown transition event": {
			States:      []string{"s0"},
			Initial:     "s0",
			Events:      []string{"a"},
			Transitions: []Transition{{From: "s0", Event: "z", To: "s0"}},
		},
		"unknown bad state": {
			States:  []string{"s0"},
			Initial: "s0",
			Events:  []string{"a"},
			Bad:     []string{"s9"},
		},
	}
	for name, spec := range cases {
		if _, err := NewModel(spec); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestMaxLimitsAccepted(t *testing.T) {
	spec := Spec{
		States:  []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"},
		Initial: "s0",
		Events:  []string{"a", "b", "c", "d", "e"},
		Budget:  ptr(10),
	}
	if _, err := NewModel(spec); err != nil {
		t.Fatalf("max-size spec rejected: %v", err)
	}
}

func TestDefaultBudget(t *testing.T) {
	m := mustModel(t, Spec{States: []string{"s0"}, Initial: "s0", Events: []string{"a"}})
	if m.StepBudget() != MaxBudget {
		t.Fatalf("expected default budget %d, got %d", MaxBudget, m.StepBudget())
	}
}
