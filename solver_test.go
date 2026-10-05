package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func defaultInstance(t *testing.T) *Instance {
	t.Helper()
	inst, err := NewInstance(DefaultSpec())
	if err != nil {
		t.Fatalf("default spec invalid: %v", err)
	}
	return inst
}

func TestDefaultInstanceShape(t *testing.T) {
	inst := defaultInstance(t)
	if got := len(inst.Spec.Assertions); got != 18 {
		t.Errorf("assertions = %d, want 18", got)
	}
	if got := len(inst.Spec.Models); got != 12 {
		t.Errorf("fault models = %d, want 12", got)
	}
	if len(inst.indistinguishable) != 1 {
		t.Fatalf("indistinguishable models = %v, want exactly [M12]", inst.indistinguishable)
	}
	if id := inst.Spec.Models[inst.indistinguishable[0]].ID; id != "M12" {
		t.Errorf("indistinguishable model = %s, want M12", id)
	}
}

func TestDefaultOptimalPlan(t *testing.T) {
	inst := defaultInstance(t)
	cert := Solve(inst)

	if cert.Selected.Cost != 21 {
		t.Errorf("optimal cost = %d, want 21", cert.Selected.Cost)
	}
	if cert.Optima != 2 {
		t.Errorf("optimal plans = %d, want 2 (A11 or A16 for M09)", cert.Optima)
	}
	if cert.Explored != 1<<18 {
		t.Errorf("explored subsets = %d, want %d", cert.Explored, 1<<18)
	}
	if cert.Selected.Covered != inst.distinguishable {
		t.Errorf("selected plan does not cover every distinguishable model")
	}
	if !inst.mutexOK(cert.Selected.Assertions) {
		t.Errorf("selected plan violates side-effect mutual exclusion")
	}
	sum := 0
	for _, i := range cert.Selected.Assertions {
		sum += inst.Spec.Assertions[i].Cost
	}
	if sum != cert.Selected.Cost {
		t.Errorf("plan cost = %d but assertions sum to %d", cert.Selected.Cost, sum)
	}
}

func TestDefaultGreedyCrossCheck(t *testing.T) {
	inst := defaultInstance(t)
	cert := Solve(inst)
	if cert.Greedy.Cost != 25 {
		t.Errorf("greedy cost = %d, want 25", cert.Greedy.Cost)
	}
	if cert.Greedy.Cost < cert.Selected.Cost {
		t.Fatalf("greedy (%d) beat exhaustive enumeration (%d): impossible",
			cert.Greedy.Cost, cert.Selected.Cost)
	}
}

func TestMutexExclusion(t *testing.T) {
	spec := Spec{
		Models: []FaultModel{{ID: "M1"}, {ID: "M2"}},
		Assertions: []Assertion{
			{ID: "A1", Cost: 1, SideEffectGroup: "g", Distinguishes: []string{"M1"}},
			{ID: "A2", Cost: 1, SideEffectGroup: "g", Distinguishes: []string{"M2"}},
			{ID: "A3", Cost: 5, Distinguishes: []string{"M1", "M2"}},
		},
	}
	inst, err := NewInstance(spec)
	if err != nil {
		t.Fatal(err)
	}
	cert := Solve(inst)
	if cert.Selected.Cost != 5 || len(cert.Selected.Assertions) != 1 {
		t.Errorf("mutex violated: plan = %v cost %d, want [A3] cost 5",
			cert.Selected.Assertions, cert.Selected.Cost)
	}
	if !inst.mutexOK(cert.Selected.Assertions) {
		t.Error("selected plan violates side-effect mutual exclusion")
	}
}

func TestInfeasible(t *testing.T) {
	spec := Spec{
		Models: []FaultModel{{ID: "M1"}, {ID: "M2"}},
		Assertions: []Assertion{
			{ID: "A1", Cost: 1, SideEffectGroup: "g", Distinguishes: []string{"M1"}},
			{ID: "A2", Cost: 1, SideEffectGroup: "g", Distinguishes: []string{"M2"}},
		},
	}
	inst, err := NewInstance(spec)
	if err != nil {
		t.Fatal(err)
	}
	cert := Solve(inst)
	if cert.Optima != 0 {
		t.Errorf("optima = %d, want 0 for infeasible instance", cert.Optima)
	}
	if !strings.Contains(cert.String(), "INFEASIBLE") {
		t.Error("certificate must report INFEASIBLE")
	}
}

func TestValidationErrors(t *testing.T) {
	model := FaultModel{ID: "M1"}
	cases := map[string]Spec{
		"no assertions": {Models: []FaultModel{model}},
		"no models":     {Assertions: []Assertion{{ID: "A1", Distinguishes: []string{"M1"}}}},
		"too many assertions": {
			Models:     []FaultModel{model},
			Assertions: manyAssertions(19),
		},
		"too many models": {
			Models:     manyModels(64),
			Assertions: []Assertion{{ID: "A1", Distinguishes: []string{"M00"}}},
		},
		"duplicate assertion id": {
			Models: []FaultModel{model},
			Assertions: []Assertion{
				{ID: "A1", Distinguishes: []string{"M1"}},
				{ID: "A1", Distinguishes: []string{"M1"}},
			},
		},
		"duplicate model id": {
			Models:     []FaultModel{model, model},
			Assertions: []Assertion{{ID: "A1", Distinguishes: []string{"M1"}}},
		},
		"negative cost": {
			Models:     []FaultModel{model},
			Assertions: []Assertion{{ID: "A1", Cost: -1, Distinguishes: []string{"M1"}}},
		},
		"unknown model reference": {
			Models:     []FaultModel{model},
			Assertions: []Assertion{{ID: "A1", Distinguishes: []string{"M99"}}},
		},
		"empty assertion id": {
			Models:     []FaultModel{model},
			Assertions: []Assertion{{Distinguishes: []string{"M1"}}},
		},
		"empty model id": {
			Models:     []FaultModel{{}},
			Assertions: []Assertion{{ID: "A1"}},
		},
	}
	for name, spec := range cases {
		if _, err := NewInstance(spec); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

func manyAssertions(n int) []Assertion {
	out := make([]Assertion, n)
	for i := range out {
		out[i] = Assertion{ID: fmt.Sprintf("A%02d", i), Distinguishes: []string{"M1"}}
	}
	return out
}

func manyModels(n int) []FaultModel {
	out := make([]FaultModel, n)
	for i := range out {
		out[i] = FaultModel{ID: fmt.Sprintf("M%02d", i)}
	}
	return out
}

func TestCertificateSections(t *testing.T) {
	cert := Solve(defaultInstance(t))
	s := cert.String()
	wants := []string{
		"COVERAGE CERTIFICATE",
		"Indistinguishable models",
		"M12",
		"Selected plan (minimum total cost = 21)",
		"Public preconditions required by the plan",
		"Side-effect mutex groups",
		"Per-model separation from normal",
		"Optimality cross-check (small-subset enumeration)",
		"STATUS: OPTIMAL",
	}
	for _, want := range wants {
		if !strings.Contains(s, want) {
			t.Errorf("certificate missing section %q", want)
		}
	}
}

// TestRandomizedCrossCheck verifies on seeded random instances that the
// exhaustive optimum is never worse than greedy and that every reported
// plan is feasible (full coverage, mutex respected, consistent cost).
func TestRandomizedCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(12)
		m := 1 + rng.Intn(8)
		spec := randomSpec(rng, n, m)
		inst, err := NewInstance(spec)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		cert := Solve(inst)
		if cert.Explored != 1<<uint(n) {
			t.Fatalf("trial %d: explored %d, want %d", trial, cert.Explored, 1<<uint(n))
		}
		if cert.Optima == 0 {
			continue
		}
		if cert.Selected.Covered != inst.distinguishable {
			t.Fatalf("trial %d: plan does not cover all distinguishable models", trial)
		}
		if !inst.mutexOK(cert.Selected.Assertions) {
			t.Fatalf("trial %d: plan violates mutex", trial)
		}
		if cert.Greedy.Covered == inst.distinguishable && cert.Greedy.Cost < cert.Selected.Cost {
			t.Fatalf("trial %d: greedy %d < exhaustive %d", trial, cert.Greedy.Cost, cert.Selected.Cost)
		}
	}
}

func randomSpec(rng *rand.Rand, n, m int) Spec {
	spec := Spec{Models: manyModels(m)}
	groups := []string{"", "", "g1", "g2", "g3"}
	for i := 0; i < n; i++ {
		a := Assertion{
			ID:              fmt.Sprintf("A%02d", i),
			Cost:            1 + rng.Intn(9),
			SideEffectGroup: groups[rng.Intn(len(groups))],
		}
		for j := 0; j < m; j++ {
			if rng.Intn(3) == 0 {
				a.Distinguishes = append(a.Distinguishes, spec.Models[j].ID)
			}
		}
		spec.Assertions = append(spec.Assertions, a)
	}
	return spec
}

func TestExampleSpecMatchesDefault(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("examples", "spec.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(spec, DefaultSpec()) {
		t.Error("examples/spec.json differs from DefaultSpec()")
	}
}

func TestRunCLI(t *testing.T) {
	var buf bytes.Buffer
	if err := run(nil, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "STATUS: OPTIMAL") {
		t.Error("default run should certify OPTIMAL")
	}

	dir := t.TempDir()
	out := filepath.Join(dir, "cert.txt")
	buf.Reset()
	if err := run([]string{"-o", out}, &buf); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "COVERAGE CERTIFICATE") {
		t.Error("written certificate missing header")
	}

	specPath := filepath.Join(dir, "spec.json")
	custom := `{"models":[{"id":"M1"}],"assertions":[{"id":"A1","cost":3,"distinguishes":["M1"]}]}`
	if err := os.WriteFile(specPath, []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	if err := run([]string{"-spec", specPath}, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "minimum total cost = 3") {
		t.Error("custom spec run should select A1 with cost 3")
	}

	if err := run([]string{"-spec", filepath.Join(dir, "missing.json")}, &buf); err == nil {
		t.Error("expected error for missing spec file")
	}
}
