package main

// Assertion is a candidate diagnostic assertion. An assertion distinguishes a
// fault model from normal when its outcome differs between the two.
type Assertion struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cost int    `json:"cost"`
	// SideEffectGroup marks assertions whose side effects are mutually
	// exclusive: at most one assertion per non-empty group may be selected.
	// An empty group means the assertion has no side effects.
	SideEffectGroup string `json:"side_effect_group,omitempty"`
	// Preconditions are public: they are declared in the spec and disclosed
	// in the coverage certificate.
	Preconditions []string `json:"preconditions,omitempty"`
	// Distinguishes lists fault model IDs this assertion separates from
	// normal behavior.
	Distinguishes []string `json:"distinguishes"`
}

// FaultModel is a faulty behavior that must be distinguishable from normal.
type FaultModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Spec is the planning input: candidate assertions and fault models.
type Spec struct {
	Assertions []Assertion  `json:"assertions"`
	Models     []FaultModel `json:"models"`
}
