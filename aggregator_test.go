package formal_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	formal "example.org/dlks/formal/q10095"
)

func record(t *testing.T, a *formal.Aggregator, id formal.InstanceID, kind formal.ProbeKind, result formal.ProbeResult) formal.Snapshot {
	t.Helper()
	snap, err := a.Record(id, kind, result)
	if err != nil {
		t.Fatalf("Record(%q, %s, %s): %v", id, kind, result, err)
	}
	return snap
}

func expectState(t *testing.T, a *formal.Aggregator, id formal.InstanceID, want formal.State) formal.Snapshot {
	t.Helper()
	snap, ok := a.SnapshotFor(id)
	if !ok {
		t.Fatalf("SnapshotFor(%q) missing", id)
	}
	if snap.State != want {
		t.Fatalf("instance %q state = %s, want %s", id, snap.State, want)
	}
	if snap.Ready != want.TrafficEligible() || snap.ReceivesTraffic != want.TrafficEligible() {
		t.Fatalf("instance %q traffic flags disagree with state %s: %+v", id, want, snap)
	}
	return snap
}

func TestLifecycleStartupReadinessLiveness(t *testing.T) {
	a := mustNew(t, formal.DefaultConfig(), "i")

	expectState(t, a, "i", formal.StateStarting)
	// Readiness passes before startup must not grant traffic.
	for i := 0; i < 2; i++ {
		record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
	}
	expectState(t, a, "i", formal.StateStarting)
	if got := a.ReadyInstances(); len(got) != 0 {
		t.Fatalf("ready before startup = %v", got)
	}

	record(t, a, "i", formal.ProbeStartup, formal.ProbePass)
	expectState(t, a, "i", formal.StateReady)
	if got := a.ReadyInstances(); len(got) != 1 || got[0] != "i" {
		t.Fatalf("ready after startup = %v", got)
	}

	// Readiness failure threshold is three consecutive failures.
	record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
	record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
	expectState(t, a, "i", formal.StateReady)
	record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
	expectState(t, a, "i", formal.StateNotReady)

	// Two consecutive successes are required to recover.
	record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
	expectState(t, a, "i", formal.StateNotReady)
	record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
	expectState(t, a, "i", formal.StateReady)

	// Liveness failure removes traffic even while readiness is passing.
	record(t, a, "i", formal.ProbeLiveness, formal.ProbeFail)
	record(t, a, "i", formal.ProbeLiveness, formal.ProbeFail)
	record(t, a, "i", formal.ProbeLiveness, formal.ProbeFail)
	expectState(t, a, "i", formal.StateUnhealthy)
	record(t, a, "i", formal.ProbeLiveness, formal.ProbePass)
	expectState(t, a, "i", formal.StateUnhealthy)
	record(t, a, "i", formal.ProbeLiveness, formal.ProbePass)
	expectState(t, a, "i", formal.StateReady)
}

func TestStartupFailureAndRecovery(t *testing.T) {
	cfg := formal.DefaultConfig()
	cfg.StartupFailureThreshold = 2
	cfg.StartupSuccessThreshold = 2
	a := mustNew(t, cfg, "i")

	record(t, a, "i", formal.ProbeStartup, formal.ProbeFail)
	expectState(t, a, "i", formal.StateStarting)
	record(t, a, "i", formal.ProbeStartup, formal.ProbeFail)
	snap := expectState(t, a, "i", formal.StateUnhealthy)
	if !snap.StartupFailed || snap.StartupDone {
		t.Fatalf("startup failure flags = done:%v failed:%v", snap.StartupDone, snap.StartupFailed)
	}

	record(t, a, "i", formal.ProbeStartup, formal.ProbePass)
	expectState(t, a, "i", formal.StateUnhealthy)
	record(t, a, "i", formal.ProbeStartup, formal.ProbePass)
	snap = expectState(t, a, "i", formal.StateNotReady)
	if !snap.StartupDone || snap.StartupFailed {
		t.Fatalf("startup recovery flags = done:%v failed:%v", snap.StartupDone, snap.StartupFailed)
	}
}

func TestJitterDoesNotFlipState(t *testing.T) {
	cfg := formal.DefaultConfig()
	cfg.ReadinessFailureThreshold = 3
	cfg.ReadinessSuccessThreshold = 3
	a := mustNew(t, cfg, "i")

	record(t, a, "i", formal.ProbeStartup, formal.ProbePass)
	for i := 0; i < cfg.ReadinessSuccessThreshold; i++ {
		record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
	}
	expectState(t, a, "i", formal.StateReady)

	for i := 0; i < 100; i++ {
		record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
		expectState(t, a, "i", formal.StateReady)
		record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
		expectState(t, a, "i", formal.StateReady)
	}

	// Remove the instance, then flap. It must stay removed because neither the
	// three-failure nor three-success streak can complete.
	for i := 0; i < cfg.ReadinessFailureThreshold; i++ {
		record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
	}
	expectState(t, a, "i", formal.StateNotReady)
	for i := 0; i < 100; i++ {
		record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
		expectState(t, a, "i", formal.StateNotReady)
		record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
		expectState(t, a, "i", formal.StateNotReady)
	}
}

func TestBackoffGrowsAndResets(t *testing.T) {
	cfg := formal.DefaultConfig()
	cfg.ReadinessFailureThreshold = 10
	cfg.BackoffBase = 100 * time.Millisecond
	cfg.BackoffMax = 400 * time.Millisecond
	a := mustNew(t, cfg, "i")

	record(t, a, "i", formal.ProbeStartup, formal.ProbePass)
	wantDelays := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 400 * time.Millisecond}
	for i, want := range wantDelays {
		snap := record(t, a, "i", formal.ProbeReadiness, formal.ProbeFail)
		if snap.BackoffLevel != i+1 {
			t.Fatalf("failure %d: backoff level = %d, want %d", i+1, snap.BackoffLevel, i+1)
		}
		if snap.NextProbeDelay != want {
			t.Fatalf("failure %d: delay = %v, want %v", i+1, snap.NextProbeDelay, want)
		}
	}
	snap := record(t, a, "i", formal.ProbeReadiness, formal.ProbePass)
	if snap.BackoffLevel != 0 || snap.NextProbeDelay != 0 {
		t.Fatalf("after success: backoff = %d/%v, want 0/0", snap.BackoffLevel, snap.NextProbeDelay)
	}
}

func TestCountersArePerInstance(t *testing.T) {
	a := mustNew(t, formal.DefaultConfig(), "a", "b")
	for i := 0; i < 4; i++ {
		record(t, a, "a", formal.ProbeReadiness, formal.ProbePass)
	}
	for i := 0; i < 3; i++ {
		record(t, a, "b", formal.ProbeLiveness, formal.ProbeFail)
	}

	sa, _ := a.SnapshotFor("a")
	sb, _ := a.SnapshotFor("b")
	if sa.Readiness.Attempts != 4 || sa.Liveness.Attempts != 0 {
		t.Fatalf("instance a counters leaked: %+v", sa)
	}
	if sb.Liveness.Attempts != 3 || sb.Readiness.Attempts != 0 {
		t.Fatalf("instance b counters leaked: %+v", sb)
	}
	if sa.Readiness.Attempts != sa.Readiness.Successes+sa.Readiness.Failures {
		t.Fatalf("instance a counters inconsistent: %+v", sa.Readiness)
	}
	if sb.Liveness.Attempts != sb.Liveness.Successes+sb.Liveness.Failures {
		t.Fatalf("instance b counters inconsistent: %+v", sb.Liveness)
	}
}

func TestTrafficSelectionNeverUsesNotReadyInstances(t *testing.T) {
	a := mustNew(t, formal.DefaultConfig(), "a", "b", "c")
	for _, id := range []formal.InstanceID{"a", "b", "c"} {
		record(t, a, id, formal.ProbeStartup, formal.ProbePass)
		record(t, a, id, formal.ProbeReadiness, formal.ProbePass)
		record(t, a, id, formal.ProbeReadiness, formal.ProbePass)
	}
	if got := a.ReadyInstances(); fmt.Sprint(got) != "[a b c]" {
		t.Fatalf("ready = %v", got)
	}

	first := a.Select(2)
	if len(first) != 2 || first[0] != "a" || first[1] != "b" {
		t.Fatalf("first selection = %v", first)
	}
	second := a.Select(2)
	if len(second) != 2 || second[0] != "c" || second[1] != "a" {
		t.Fatalf("second selection = %v", second)
	}

	// Removing b must stop every subsequent selection from considering it.
	for i := 0; i < 3; i++ {
		record(t, a, "b", formal.ProbeReadiness, formal.ProbeFail)
	}
	for i := 0; i < 20; i++ {
		for _, id := range a.Select(3) {
			if id == "b" {
				t.Fatalf("selection included not-ready instance b: %v", a.Select(3))
			}
		}
	}
}

func TestNewValidationAndErrors(t *testing.T) {
	if _, err := formal.New(formal.Config{ReadinessFailureThreshold: -1}); err == nil {
		t.Fatal("negative threshold accepted")
	}
	if _, err := formal.New(formal.Config{BackoffBase: time.Second, BackoffMax: time.Millisecond}); err == nil {
		t.Fatal("BackoffMax < BackoffBase accepted")
	}
	if _, err := formal.New(formal.DefaultConfig(), ""); !errors.Is(err, formal.ErrInvalidInstanceID) {
		t.Fatalf("empty ID error = %v", err)
	}

	a := mustNew(t, formal.DefaultConfig(), "a")
	if err := a.Register("a"); !errors.Is(err, formal.ErrDuplicateInstance) {
		t.Fatalf("duplicate error = %v", err)
	}
	if _, err := a.Record("missing", formal.ProbeReadiness, formal.ProbePass); !errors.Is(err, formal.ErrUnknownInstance) {
		t.Fatalf("unknown error = %v", err)
	}
	if _, err := a.Record("a", formal.ProbeKind(99), formal.ProbePass); !errors.Is(err, formal.ErrInvalidProbeKind) {
		t.Fatalf("probe kind error = %v", err)
	}
	if _, err := a.Record("a", formal.ProbeReadiness, formal.ProbeResult(99)); !errors.Is(err, formal.ErrInvalidProbeResult) {
		t.Fatalf("probe result error = %v", err)
	}
}
