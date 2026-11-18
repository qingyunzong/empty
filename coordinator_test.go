package formal

import (
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

var testEpoch = time.Unix(1_700_000_000, 0).UTC()

func at(seconds float64) time.Time {
	return testEpoch.Add(time.Duration(seconds * float64(time.Second)))
}

func newTestCoordinator(t *testing.T, timeout time.Duration) *Coordinator {
	t.Helper()
	coordinator, err := New(Config{GenerationTimeout: timeout})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return coordinator
}

func mustJoin(t *testing.T, coordinator *Coordinator, id MemberID, now time.Time) {
	t.Helper()
	if err := coordinator.Join(id, now); err != nil {
		t.Fatalf("Join(%q): %v", id, err)
	}
}

func mustReconnect(t *testing.T, coordinator *Coordinator, id MemberID, now time.Time) {
	t.Helper()
	if err := coordinator.Reconnect(id, now); err != nil {
		t.Fatalf("Reconnect(%q): %v", id, err)
	}
}

func mustFail(t *testing.T, coordinator *Coordinator, id MemberID, now time.Time) {
	t.Helper()
	if err := coordinator.Fail(id, now); err != nil {
		t.Fatalf("Fail(%q): %v", id, err)
	}
}

func mustAck(t *testing.T, coordinator *Coordinator, id MemberID, generation uint64, now time.Time) {
	t.Helper()
	if err := coordinator.Ack(id, generation, now); err != nil {
		t.Fatalf("Ack(%q, %d): %v", id, generation, err)
	}
}

func currentGeneration(t *testing.T, coordinator *Coordinator) Generation {
	t.Helper()
	generation, ok := coordinator.Current()
	if !ok {
		t.Fatal("Current: no generation")
	}
	if err := generation.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	return generation
}

func assertMembers(t *testing.T, generation Generation, want ...MemberID) {
	t.Helper()
	if err := generation.Validate(); err != nil {
		t.Fatalf("generation %d: %v", generation.Number, err)
	}
	got := make([]MemberID, len(generation.Members))
	for i, member := range generation.Members {
		if member.Rank != Rank(i) {
			t.Fatalf("generation %d member %q rank %d, want %d",
				generation.Number, member.ID, member.Rank, i)
		}
		got[i] = member.ID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("generation %d members %v, want %v", generation.Number, got, want)
	}
}

func TestCommitRequiresEveryMemberBeforeDeadline(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(1))

	generation := currentGeneration(t, coordinator)
	if generation.Number != 2 {
		t.Fatalf("generation number %d, want 2", generation.Number)
	}
	if generation.State != GenerationPending {
		t.Fatalf("state %s, want pending", generation.State)
	}
	assertMembers(t, generation, "a", "b")
	if !generation.Deadline.Equal(at(11)) {
		t.Fatalf("deadline %s, want %s", generation.Deadline, at(11))
	}

	mustAck(t, coordinator, "a", 2, at(2))
	generation = currentGeneration(t, coordinator)
	if generation.State != GenerationPending {
		t.Fatalf("state after one confirmation %s, want pending", generation.State)
	}

	mustAck(t, coordinator, "b", 2, at(10))
	generation = currentGeneration(t, coordinator)
	if generation.State != GenerationCommitted {
		t.Fatalf("state after all confirmations %s, want committed", generation.State)
	}
	if len(generation.Confirmations) != 2 {
		t.Fatalf("%d confirmations, want 2", len(generation.Confirmations))
	}

	history := coordinator.History()
	if len(history) != 2 {
		t.Fatalf("%d generations, want 2", len(history))
	}
	if history[0].State != GenerationAborted || history[0].AbortReason != AbortSuperseded {
		t.Fatalf("first generation state %s/%s, want aborted/superseded",
			history[0].State, history[0].AbortReason)
	}
}

func TestDeadlineExpiryDropsNonConfirmersAndReRanks(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(0))
	generation := currentGeneration(t, coordinator)
	if generation.Number != 2 {
		t.Fatalf("generation number %d, want 2", generation.Number)
	}
	mustAck(t, coordinator, "a", generation.Number, at(1))

	coordinator.Advance(at(10))

	generation = currentGeneration(t, coordinator)
	if generation.Number != 3 {
		t.Fatalf("generation after expiry %d, want 3", generation.Number)
	}
	if generation.State != GenerationPending || generation.AbortReason != AbortNone {
		t.Fatalf("state %s/%s, want pending/none", generation.State, generation.AbortReason)
	}
	assertMembers(t, generation, "a")
	if len(generation.Confirmations) != 0 {
		t.Fatalf("new generation inherited %d confirmations", len(generation.Confirmations))
	}

	if err := coordinator.Ack("b", 2, at(10)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("late confirmation error %v, want ErrStaleGeneration", err)
	}

	mustReconnect(t, coordinator, "b", at(11))
	generation = currentGeneration(t, coordinator)
	if generation.Number != 4 {
		t.Fatalf("generation after reconnect %d, want 4", generation.Number)
	}
	assertMembers(t, generation, "a", "b")
	if len(generation.Confirmations) != 0 {
		t.Fatalf("reconnected generation inherited %d confirmations", len(generation.Confirmations))
	}

	mustAck(t, coordinator, "a", 4, at(12))
	mustAck(t, coordinator, "b", 4, at(13))
	generation = currentGeneration(t, coordinator)
	if generation.State != GenerationCommitted {
		t.Fatalf("state %s, want committed", generation.State)
	}

	history := coordinator.History()
	if len(history) != 4 {
		t.Fatalf("%d generations, want 4", len(history))
	}
	if history[1].Number != 2 || history[1].State != GenerationAborted || history[1].AbortReason != AbortDeadline {
		t.Fatalf("expired generation = %+v", history[1])
	}
	if history[2].Number != 3 || history[2].State != GenerationAborted || history[2].AbortReason != AbortSuperseded {
		t.Fatalf("superseded generation = %+v", history[2])
	}
}

func TestDeadlineIsStrict(t *testing.T) {
	t.Run("single member confirming at deadline is removed", func(t *testing.T) {
		coordinator := newTestCoordinator(t, 10*time.Second)
		mustJoin(t, coordinator, "a", at(0))

		if err := coordinator.Ack("a", 1, at(10)); !errors.Is(err, ErrStaleGeneration) {
			t.Fatalf("ack at deadline error %v, want ErrStaleGeneration", err)
		}
		if _, ok := coordinator.Current(); ok {
			t.Fatal("generation still active after the only member missed the deadline")
		}
		if members := coordinator.Members(); len(members) != 0 {
			t.Fatalf("members after expiry %v, want none", members)
		}
	})

	t.Run("confirmation one nanosecond before deadline commits", func(t *testing.T) {
		coordinator := newTestCoordinator(t, 10*time.Second)
		mustJoin(t, coordinator, "a", at(0))
		mustJoin(t, coordinator, "b", at(0))
		mustAck(t, coordinator, "a", 2, at(1))
		mustAck(t, coordinator, "b", 2, at(10).Add(-time.Nanosecond))

		generation := currentGeneration(t, coordinator)
		if generation.State != GenerationCommitted {
			t.Fatalf("state %s, want committed", generation.State)
		}
	})
}

func TestJoinDuringPendingGenerationSupersedesIt(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(0))
	mustAck(t, coordinator, "a", 2, at(1))

	mustJoin(t, coordinator, "c", at(2))
	generation := currentGeneration(t, coordinator)
	if generation.Number != 3 {
		t.Fatalf("generation number %d, want 3", generation.Number)
	}
	assertMembers(t, generation, "a", "b", "c")
	if len(generation.Confirmations) != 0 {
		t.Fatalf("generation 3 inherited %d confirmations", len(generation.Confirmations))
	}

	if err := coordinator.Ack("a", 2, at(2)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old confirmation error %v, want ErrStaleGeneration", err)
	}
	generation = currentGeneration(t, coordinator)
	if len(generation.Confirmations) != 0 {
		t.Fatalf("stale confirmation mutated generation 3")
	}
}

func TestRankReassignmentOnFailureAndReconnect(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "c", at(1))
	assertMembers(t, currentGeneration(t, coordinator), "a", "c")
	mustAck(t, coordinator, "a", 2, at(2))
	mustAck(t, coordinator, "c", 2, at(2))

	mustFail(t, coordinator, "a", at(3))
	generation := currentGeneration(t, coordinator)
	assertMembers(t, generation, "c")
	mustAck(t, coordinator, "c", generation.Number, at(4))

	mustReconnect(t, coordinator, "a", at(5))
	generation = currentGeneration(t, coordinator)
	assertMembers(t, generation, "a", "c")
	if generation.Members[1].Rank != 1 {
		t.Fatalf("c rank %d, want 1", generation.Members[1].Rank)
	}
}

func TestReconnectAndDeadlineInterleavingDoesNotMixGenerations(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(0))
	mustAck(t, coordinator, "a", 2, at(1))

	coordinator.Advance(at(10))
	mustReconnect(t, coordinator, "b", at(10))

	generation := currentGeneration(t, coordinator)
	if generation.Number != 4 {
		t.Fatalf("generation number %d, want 4", generation.Number)
	}
	assertMembers(t, generation, "a", "b")
	if len(generation.Confirmations) != 0 {
		t.Fatalf("reconnected generation inherited %d confirmations", len(generation.Confirmations))
	}

	if err := coordinator.Ack("a", 3, at(10)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("superseded generation confirmation error %v, want ErrStaleGeneration", err)
	}
	if err := coordinator.Ack("b", 2, at(10)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("late old-generation confirmation error %v, want ErrStaleGeneration", err)
	}
	generation = currentGeneration(t, coordinator)
	if len(generation.Confirmations) != 0 {
		t.Fatalf("stale confirmations leaked into generation 4")
	}

	mustAck(t, coordinator, "a", 4, at(11))
	mustAck(t, coordinator, "b", 4, at(12))

	history := coordinator.History()
	if len(history) != 4 {
		t.Fatalf("%d generations, want 4", len(history))
	}
	if history[1].Number != 2 || history[1].State != GenerationAborted || history[1].AbortReason != AbortDeadline {
		t.Fatalf("generation 2 = %+v", history[1])
	}
	if len(history[1].Confirmations) != 1 || history[1].Confirmations[0].Member != "a" {
		t.Fatalf("generation 2 confirmations = %+v", history[1].Confirmations)
	}
	if history[2].Number != 3 || history[2].State != GenerationAborted || history[2].AbortReason != AbortSuperseded {
		t.Fatalf("generation 3 = %+v", history[2])
	}
	if len(history[2].Confirmations) != 0 {
		t.Fatalf("generation 3 confirmations = %+v", history[2].Confirmations)
	}
	if history[3].State != GenerationCommitted || len(history[3].Confirmations) != 2 {
		t.Fatalf("generation 4 = %+v", history[3])
	}
}

func TestConfirmationErrors(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)
	if err := coordinator.Ack("a", 1, at(0)); !errors.Is(err, ErrNoGeneration) {
		t.Fatalf("ack with no generation: %v", err)
	}

	mustJoin(t, coordinator, "a", at(0))
	if err := coordinator.Ack("b", 1, at(1)); !errors.Is(err, ErrNotMember) {
		t.Fatalf("ack from non-member: %v", err)
	}
	if err := coordinator.Ack("a", 2, at(1)); !errors.Is(err, ErrUnknownGeneration) {
		t.Fatalf("ack for future generation: %v", err)
	}

	mustAck(t, coordinator, "a", 1, at(2))
	generation := currentGeneration(t, coordinator)
	if generation.State != GenerationCommitted {
		t.Fatalf("state %s, want committed", generation.State)
	}
	mustAck(t, coordinator, "a", 1, at(3))

	mustJoin(t, coordinator, "b", at(3))
	if err := coordinator.Ack("a", 1, at(3)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("ack for superseded generation: %v", err)
	}
	if err := coordinator.Ack("c", 2, at(3)); !errors.Is(err, ErrNotMember) {
		t.Fatalf("ack from failed non-member: %v", err)
	}

	if err := coordinator.Fail("c", at(4)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("fail unknown member: %v", err)
	}
	if err := coordinator.Reconnect("c", at(4)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("reconnect unknown member: %v", err)
	}
	if err := coordinator.Join("", at(4)); !errors.Is(err, ErrInvalidMember) {
		t.Fatalf("empty join: %v", err)
	}
	if err := coordinator.Ack("", 2, at(4)); !errors.Is(err, ErrInvalidMember) {
		t.Fatalf("empty ack: %v", err)
	}
}

func TestIdempotentMembershipEvents(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)

	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "a", at(1))
	if history := coordinator.History(); len(history) != 1 {
		t.Fatalf("%d generations after duplicate join, want 1", len(history))
	}

	mustJoin(t, coordinator, "b", at(2))
	mustReconnect(t, coordinator, "b", at(3))
	if history := coordinator.History(); len(history) != 2 {
		t.Fatalf("%d generations after reconnecting a live member, want 2", len(history))
	}

	mustFail(t, coordinator, "b", at(4))
	mustFail(t, coordinator, "b", at(5))
	if history := coordinator.History(); len(history) != 3 {
		t.Fatalf("%d generations after duplicate failure, want 3", len(history))
	}

	coordinator.Advance(at(6))
	if history := coordinator.History(); len(history) != 3 {
		t.Fatalf("%d generations after early advance, want 3", len(history))
	}
}

func TestTimeRegressionIsClamped(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)
	mustJoin(t, coordinator, "a", at(5))

	coordinator.Advance(at(0))
	generation := currentGeneration(t, coordinator)
	if generation.State != GenerationPending {
		t.Fatalf("clock regression expired the generation: %s", generation.State)
	}

	mustAck(t, coordinator, "a", 1, at(1))
	generation = currentGeneration(t, coordinator)
	if generation.State != GenerationCommitted {
		t.Fatalf("state %s, want committed", generation.State)
	}
	if !generation.Confirmations[0].At.Equal(at(5)) {
		t.Fatalf("confirmation time %s, want clamped time %s", generation.Confirmations[0].At, at(5))
	}
}

func TestLastMemberFailureClearsCurrentGeneration(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)
	mustJoin(t, coordinator, "a", at(0))
	mustFail(t, coordinator, "a", at(1))

	if _, ok := coordinator.Current(); ok {
		t.Fatal("current generation still exists with no live members")
	}
	if members := coordinator.Members(); len(members) != 0 {
		t.Fatalf("members %v, want none", members)
	}
	history := coordinator.History()
	if len(history) != 1 || history[0].State != GenerationAborted || history[0].AbortReason != AbortMemberFailed {
		t.Fatalf("history = %+v", history)
	}

	mustReconnect(t, coordinator, "a", at(2))
	generation := currentGeneration(t, coordinator)
	if generation.Number != 2 {
		t.Fatalf("generation number %d, want 2", generation.Number)
	}
	assertMembers(t, generation, "a")
}

func TestInvalidEventAtDeadlineKeepsReplacementGeneration(t *testing.T) {
	coordinator := newTestCoordinator(t, 10*time.Second)
	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(0))
	mustAck(t, coordinator, "a", 2, at(1))

	if err := coordinator.Fail("unknown", at(10)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("Fail(unknown) error %v, want ErrUnknownMember", err)
	}
	generation := currentGeneration(t, coordinator)
	if generation.Number != 3 {
		t.Fatalf("generation %d, want 3", generation.Number)
	}
	assertMembers(t, generation, "a")

	if err := coordinator.Reconnect("unknown", at(10)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("Reconnect(unknown) error %v, want ErrUnknownMember", err)
	}
	generation = currentGeneration(t, coordinator)
	if generation.Number != 3 || generation.State != GenerationPending {
		t.Fatalf("generation after invalid reconnect = %+v", generation)
	}
}

func TestConcurrentConfirmations(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)

	const memberCount = 16
	members := make([]MemberID, memberCount)
	for i := range members {
		members[i] = MemberID(rune('a' + i))
		mustJoin(t, coordinator, members[i], at(0))
	}
	generation := currentGeneration(t, coordinator)
	if generation.Number != memberCount {
		t.Fatalf("generation number %d, want %d", generation.Number, memberCount)
	}

	var wait sync.WaitGroup
	errs := make(chan error, memberCount)
	for _, member := range members {
		wait.Add(1)
		go func(id MemberID) {
			defer wait.Done()
			errs <- coordinator.Ack(id, generation.Number, at(1))
		}(member)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Ack: %v", err)
		}
	}

	generation = currentGeneration(t, coordinator)
	if generation.State != GenerationCommitted {
		t.Fatalf("state %s, want committed", generation.State)
	}
	if len(generation.Confirmations) != memberCount {
		t.Fatalf("%d confirmations, want %d", len(generation.Confirmations), memberCount)
	}
}

func TestSnapshotsAreImmutable(t *testing.T) {
	coordinator := newTestCoordinator(t, time.Minute)
	mustJoin(t, coordinator, "a", at(0))
	mustJoin(t, coordinator, "b", at(1))
	mustAck(t, coordinator, "a", 2, at(2))
	mustAck(t, coordinator, "b", 2, at(3))

	generation := currentGeneration(t, coordinator)
	generation.Members[0].ID = "mutated"
	generation.Confirmations[0].Member = "mutated"

	again := currentGeneration(t, coordinator)
	assertMembers(t, again, "a", "b")
	if again.Confirmations[0].Member != "a" {
		t.Fatalf("snapshot mutation leaked into coordinator: %+v", again.Confirmations)
	}

	history := coordinator.History()
	history[0].Members[0].Rank = 99
	if got := coordinator.History()[0].Members[0].Rank; got != 0 {
		t.Fatalf("history mutation leaked into coordinator: rank %d", got)
	}
}

func TestNewRejectsInvalidConfig(t *testing.T) {
	for _, timeout := range []time.Duration{0, -time.Second} {
		if _, err := New(Config{GenerationTimeout: timeout}); !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("New(%s) error %v, want ErrInvalidConfig", timeout, err)
		}
	}
}

func TestValidateRejectsMalformedGenerations(t *testing.T) {
	valid := Generation{
		Number:   1,
		State:    GenerationCommitted,
		OpenedAt: at(0),
		Deadline: at(10),
		Members:  []Member{{ID: "a", Rank: 0}, {ID: "b", Rank: 1}},
		Confirmations: []Confirmation{
			{Member: "a", At: at(1)},
			{Member: "b", At: at(2)},
		},
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid generation rejected: %v", err)
	}

	tests := map[string]func(*Generation){
		"zero number":      func(g *Generation) { g.Number = 0 },
		"no members":       func(g *Generation) { g.Members = nil; g.Confirmations = nil },
		"duplicate member": func(g *Generation) { g.Members[1].ID = "a" },
		"rank gap":         func(g *Generation) { g.Members[1].Rank = 2 },
		"unsorted members": func(g *Generation) { g.Members[0], g.Members[1] = g.Members[1], g.Members[0] },
		"nonmember confirmation": func(g *Generation) {
			g.Confirmations[0].Member = "c"
		},
		"confirmation at deadline": func(g *Generation) { g.Confirmations[1].At = g.Deadline },
		"missing confirmation":     func(g *Generation) { g.Confirmations = g.Confirmations[:1] },
		"bad deadline":             func(g *Generation) { g.Deadline = g.OpenedAt },
		"pending with reason": func(g *Generation) {
			g.State = GenerationPending
			g.AbortReason = AbortDeadline
		},
		"aborted without reason": func(g *Generation) { g.State = GenerationAborted },
		"unknown abort reason": func(g *Generation) {
			g.State = GenerationAborted
			g.AbortReason = AbortReason(255)
		},
	}

	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			generation := valid
			generation.Members = append([]Member(nil), valid.Members...)
			generation.Confirmations = append([]Confirmation(nil), valid.Confirmations...)
			mutate(&generation)
			if err := generation.Validate(); !errors.Is(err, ErrInvalidGeneration) {
				t.Fatalf("Validate error %v, want ErrInvalidGeneration", err)
			}
		})
	}
}
