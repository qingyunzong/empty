package compaction_test

import (
	"testing"

	"example.org/dlks/formal/q10175/compaction"
)

func TestAliasEntryPoints(t *testing.T) {
	state := compaction.State{Levels: []compaction.Level{
		{Number: 0, SizeLimit: 5, Files: []compaction.File{{
			ID: "f1", Smallest: "a", Largest: "a", Size: 10,
		}}},
		{Number: 1},
	}}
	cfg := compaction.Config{MaxInputBytes: 10}
	planner := compaction.NewPlanner(cfg)
	plan, err := planner.Plan(state)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if plan.WriteBytes != 10 {
		t.Fatalf("WriteBytes = %d, want 10", plan.WriteBytes)
	}
	if err := compaction.ValidatePlan(state, cfg, plan); err != nil {
		t.Fatalf("ValidatePlan() error = %v", err)
	}
	if _, err := compaction.BuildPlan(state); err != nil {
		t.Fatalf("BuildPlan() error = %v", err)
	}
}
