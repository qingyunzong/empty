package formal

import (
	"testing"
	"time"
)

func testPolicy(desired, surge, unavailable int, readiness, grace time.Duration) Policy {
	return Policy{
		DesiredReplicas:  desired,
		MaxSurge:         Int(surge),
		MaxUnavailable:   Int(unavailable),
		ReadinessDelay:   readiness,
		TerminationGrace: grace,
	}
}

func mustPlanner(t *testing.T, policy Policy) *Planner {
	t.Helper()
	planner, err := NewPlanner(policy)
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	return planner
}

func TestPlannerScaleUpFromZero(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, 2*time.Second, 3*time.Second))
	decision, err := planner.Step(Observation{
		Now:      0,
		Total:    0,
		Capacity: 10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}

	if decision.Action.Kind != ActionScaleUp || decision.Action.Replicas != 6 {
		t.Fatalf("action = %+v, want scale-up 6", decision.Action)
	}
	if decision.Action.ReadyAt != 2*time.Second {
		t.Errorf("ReadyAt = %s, want 2s", decision.Action.ReadyAt)
	}
	if decision.ProjectedTotal != 6 || decision.ProjectedAvailable != 0 {
		t.Errorf("projection = total %d available %d, want 6/0", decision.ProjectedTotal, decision.ProjectedAvailable)
	}
	if decision.Feasible != true {
		t.Errorf("Feasible = false, want true")
	}
	if len(decision.PendingTerminations) != 0 {
		t.Errorf("unexpected pending terminations: %+v", decision.PendingTerminations)
	}
}

func TestPlannerUsesSurgeForAvailabilityDeficit(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, time.Second, time.Second))
	decision, err := planner.Step(Observation{
		Now:       0,
		Total:     6,
		Available: 3,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.Action.Kind != ActionScaleUp || decision.Action.Replicas != 2 {
		t.Fatalf("action = %+v, want scale-up 2", decision.Action)
	}
	if decision.ProjectedTotal != 8 || decision.ProjectedTotal > decision.Bounds.MaxTotal {
		t.Errorf("projection = %d with max %d", decision.ProjectedTotal, decision.Bounds.MaxTotal)
	}
	if decision.ProjectedAvailableInBounds {
		t.Errorf("availability 3 is below min 5, projection should not be in bounds")
	}
}

func TestPlannerScaleDownPrefersUnready(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, time.Second, 3*time.Second))
	decision, err := planner.Step(Observation{
		Now:       7 * time.Second,
		Total:     8,
		Available: 5,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.Action.Kind != ActionScaleDown || decision.Action.Replicas != 2 {
		t.Fatalf("action = %+v, want scale-down 2", decision.Action)
	}
	if decision.Action.TerminateUnready != 2 || decision.Action.TerminateReady != 0 {
		t.Errorf("termination split = unready %d/ready %d, want 2/0",
			decision.Action.TerminateUnready, decision.Action.TerminateReady)
	}
	if decision.ProjectedAvailable != 5 {
		t.Errorf("ProjectedAvailable = %d, want 5", decision.ProjectedAvailable)
	}
	if decision.Action.CompleteBy != 10*time.Second {
		t.Errorf("CompleteBy = %s, want 10s", decision.Action.CompleteBy)
	}
}

func TestPlannerScaleDownSplitAndFloor(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, time.Second, time.Second))
	decision, err := planner.Step(Observation{
		Now:       0,
		Total:     8,
		Available: 7,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.Action.TerminateUnready != 1 || decision.Action.TerminateReady != 1 {
		t.Fatalf("termination split = unready %d/ready %d, want 1/1",
			decision.Action.TerminateUnready, decision.Action.TerminateReady)
	}
	if decision.ProjectedAvailable != 6 {
		t.Errorf("ProjectedAvailable = %d, want 6", decision.ProjectedAvailable)
	}
	if decision.ProjectedAvailable < decision.Bounds.MinAvailable {
		t.Errorf("projected availability %d is below floor %d",
			decision.ProjectedAvailable, decision.Bounds.MinAvailable)
	}
}

func TestPlannerNeverTerminatesBelowFloor(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, time.Second, time.Second))
	decision, err := planner.Step(Observation{
		Now:       0,
		Total:     8,
		Available: 5,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.Action.Kind == ActionScaleDown && decision.Action.TerminateReady > 0 {
		t.Fatalf("terminated ready pods at the availability floor: %+v", decision.Action)
	}
	if decision.ProjectedAvailable < decision.Bounds.MinAvailable {
		t.Fatalf("projected availability %d below floor %d", decision.ProjectedAvailable, decision.Bounds.MinAvailable)
	}
}

func TestPlannerCapacityDropAndInfeasibleFloor(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(10, 2, 2, time.Second, time.Second))
	decision, err := planner.Step(Observation{
		Now:       0,
		Total:     10,
		Available: 10,
		Capacity:  8,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.TargetTotal != 8 {
		t.Errorf("TargetTotal = %d, want 8", decision.TargetTotal)
	}
	if decision.Action.Kind != ActionScaleDown || decision.Action.Replicas != 2 ||
		decision.Action.TerminateReady != 2 {
		t.Fatalf("action = %+v, want scale-down 2 ready", decision.Action)
	}
	if decision.ProjectedAvailable != 8 {
		t.Errorf("ProjectedAvailable = %d, want 8", decision.ProjectedAvailable)
	}

	decision, err = planner.Step(Observation{
		Now:       1 * time.Second,
		Total:     3,
		Available: 3,
		Capacity:  3,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if decision.Feasible {
		t.Errorf("Feasible = true, want false when capacity 3 is below floor 8")
	}
	if decision.ObservedAvailableInBounds {
		t.Errorf("availability 3 unexpectedly reported in policy bounds")
	}
	if decision.Action.Kind != ActionNone {
		t.Errorf("action = %+v, want none because the floor is physically impossible", decision.Action)
	}
}

func TestPlannerConvergedAndCapacityLimitedConvergence(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(4, 1, 1, time.Second, time.Second))
	decision, err := planner.Step(Observation{
		Now:       0,
		Total:     4,
		Available: 4,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if !decision.Converged || decision.Action.Kind != ActionNone {
		t.Fatalf("decision = %+v, want converged no-op", decision)
	}

	planner = mustPlanner(t, testPolicy(10, 2, 2, time.Second, time.Second))
	decision, err = planner.Step(Observation{
		Now:       0,
		Total:     8,
		Available: 8,
		Capacity:  8,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if !decision.Converged {
		t.Fatalf("capacity-limited workload did not converge: %+v", decision)
	}
	if !decision.Feasible {
		t.Fatalf("capacity 8 equals availability floor 8, want Feasible=true")
	}
}

func TestTerminationLedgerSurvivesPolicyUpdate(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(6, 2, 1, time.Second, 5*time.Second))
	first, err := planner.Step(Observation{
		Now:       0,
		Total:     8,
		Available: 8,
		Capacity:  10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if first.Action.Kind != ActionScaleDown || first.Action.Replicas != 2 {
		t.Fatalf("action = %+v, want scale-down 2", first.Action)
	}
	if len(first.PendingTerminations) != 1 {
		t.Fatalf("pending terminations = %+v, want one batch", first.PendingTerminations)
	}
	original := first.PendingTerminations[0]
	if original.Deadline != 5*time.Second {
		t.Fatalf("deadline = %s, want 5s", original.Deadline)
	}

	if err := planner.UpdatePolicy(testPolicy(4, 2, 1, time.Second, 1*time.Second)); err != nil {
		t.Fatalf("UpdatePolicy() error = %v", err)
	}
	pending := planner.PendingTerminations()
	if len(pending) != 1 || pending[0].Deadline != original.Deadline {
		t.Fatalf("policy update changed pending termination: before %+v after %+v", original, pending)
	}

	// The two originally terminated pods are still terminating. A lower
	// desired count may start more terminations, but it must not revive or
	// cancel the first batch.
	second, err := planner.Step(Observation{
		Now:         1 * time.Second,
		Total:       8,
		Available:   6,
		Terminating: 2,
		Capacity:    10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if second.Action.Kind != ActionScaleDown || second.Action.Replicas != 2 {
		t.Fatalf("action = %+v, want another scale-down 2", second.Action)
	}
	if len(second.PendingTerminations) != 2 {
		t.Fatalf("pending = %+v, want both batches", second.PendingTerminations)
	}
	if second.PendingTerminations[0].ID == second.PendingTerminations[1].ID {
		t.Fatalf("duplicate termination IDs: %+v", second.PendingTerminations)
	}
	if second.PendingTerminations[1].Deadline != 2*time.Second {
		t.Fatalf("new batch deadline = %s, want 2s (new grace)", second.PendingTerminations[1].Deadline)
	}

	atTwo, err := planner.Step(Observation{
		Now:         2 * time.Second,
		Total:       6,
		Available:   4,
		Terminating: 2,
		Capacity:    10,
	})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if len(atTwo.PendingTerminations) != 1 || atTwo.PendingTerminations[0].ID != original.ID {
		t.Fatalf("old batch should survive the new batch: %+v", atTwo.PendingTerminations)
	}
}

func TestPlannerRejectsBackwardsTime(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(4, 1, 1, time.Second, time.Second))
	if _, err := planner.Step(Observation{Now: 5 * time.Second, Total: 4, Available: 4, Capacity: 10}); err != nil {
		t.Fatalf("first Step() error = %v", err)
	}
	if _, err := planner.Step(Observation{Now: 4 * time.Second, Total: 4, Available: 4, Capacity: 10}); err == nil {
		t.Fatal("Step() accepted a backwards clock")
	}
}

func TestZeroGraceExpiresOnNextStep(t *testing.T) {
	t.Parallel()

	planner := mustPlanner(t, testPolicy(3, 1, 1, time.Second, 0))
	first, err := planner.Step(Observation{Now: 0, Total: 4, Available: 4, Capacity: 10})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if len(first.PendingTerminations) != 1 || first.PendingTerminations[0].Deadline != 0 {
		t.Fatalf("pending = %+v, want deadline 0", first.PendingTerminations)
	}
	second, err := planner.Step(Observation{Now: 0, Total: 3, Available: 3, Capacity: 10})
	if err != nil {
		t.Fatalf("Step() error = %v", err)
	}
	if len(second.PendingTerminations) != 0 {
		t.Fatalf("zero-grace batch did not expire: %+v", second.PendingTerminations)
	}
}
