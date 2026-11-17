package formal

import (
	"errors"
	"sync"
	"testing"
)

func testDigest(member MemberID, generation Generation, step Step) [32]byte {
	var digest [32]byte
	digest[0] = byte(generation)
	digest[1] = byte(step)
	for i := 0; i < len(member); i++ {
		digest[2+i%30] ^= member[i]
	}
	return digest
}

func testGradient(member MemberID, generation Generation, step Step) Gradient {
	return Gradient{
		Member:     member,
		Generation: generation,
		Step:       step,
		Digest:     testDigest(member, generation, step),
	}
}

func testHeartbeat(member MemberID, generation Generation, step Step, sequence uint64) Heartbeat {
	return Heartbeat{Member: member, Generation: generation, Step: step, Sequence: sequence}
}

func requireError(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want errors.Is(%v)", err, target)
	}
}

func mustSubmit(t *testing.T, c *Coordinator, gradient Gradient) {
	t.Helper()
	if err := c.SubmitGradient(gradient); err != nil {
		t.Fatalf("SubmitGradient(%+v): %v", gradient, err)
	}
}

func submitAll(t *testing.T, c *Coordinator, generation Generation, step Step, members []MemberID) {
	t.Helper()
	for _, member := range members {
		mustSubmit(t, c, testGradient(member, generation, step))
	}
}

func confirmAll(t *testing.T, c *Coordinator, id CheckpointID, generation Generation, members []MemberID) {
	t.Helper()
	for _, member := range members {
		if err := c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: member, Generation: generation}); err != nil {
			t.Fatalf("ConfirmCheckpoint(%d, %q): %v", id, member, err)
		}
	}
}

func wantMembers(t *testing.T, got []Member, generation Generation, ids []MemberID) {
	t.Helper()
	if len(got) != len(ids) {
		t.Fatalf("members length = %d, want %d", len(got), len(ids))
	}
	for rank, id := range ids {
		if got[rank].ID != id || got[rank].Rank != rank || got[rank].JoinedAt != generation {
			t.Fatalf("member[%d] = %+v, want id=%q rank=%d generation=%d",
				rank, got[rank], id, rank, generation)
		}
	}
}

// assertNoCrossGenerationMixing proves the central safety property: every
// completed step is owned by exactly one generation, has exactly that
// generation's rank-ordered membership, and step numbers never repeat.
func assertNoCrossGenerationMixing(t *testing.T, c *Coordinator, expected map[Generation][]MemberID) {
	t.Helper()
	records := c.StepHistory()
	seen := make(map[Step]Generation, len(records))
	for index, record := range records {
		if previous, exists := seen[record.Step]; exists {
			t.Fatalf("step %d completed in generations %d and %d", record.Step, previous, record.Generation)
		}
		seen[record.Step] = record.Generation
		if record.Step != Step(index) {
			t.Fatalf("step history[%d] has step %d; completed steps must be contiguous", index, record.Step)
		}

		want, known := expected[record.Generation]
		if !known {
			t.Fatalf("step %d completed in unexpected generation %d", record.Step, record.Generation)
		}
		if len(record.Members) != len(want) {
			t.Fatalf("step %d generation %d has %d contributors, want %d",
				record.Step, record.Generation, len(record.Members), len(want))
		}
		for rank := range want {
			if record.Members[rank] != want[rank] {
				t.Fatalf("step %d generation %d contributor[%d] = %q, want %q",
					record.Step, record.Generation, rank, record.Members[rank], want[rank])
			}
		}
	}

	status := c.Status()
	for _, contribution := range c.Contributions() {
		if contribution.Generation != status.Generation || contribution.Step != status.Step {
			t.Fatalf("active contribution %+v does not match active generation=%d step=%d",
				contribution, status.Generation, status.Step)
		}
	}
}

func TestBootstrapAssignsRanks(t *testing.T) {
	ids := []MemberID{"w2", "w0", "w1"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	wantMembers(t, c.Members(), 1, ids)

	status := c.Status()
	if !status.Initialized || status.Generation != 1 || status.Step != 0 {
		t.Fatalf("status = %+v, want initialized generation=1 step=0", status)
	}
	if status.AcceptedGradients != 0 || status.RequiredGradients != 3 {
		t.Fatalf("gradient counters = %d/%d, want 0/3",
			status.AcceptedGradients, status.RequiredGradients)
	}
	if status.LastCompleted != nil {
		t.Fatalf("LastCompleted = %+v before any step completed", status.LastCompleted)
	}
	if _, err := c.CreateCheckpoint(); !errors.Is(err, ErrNoCompletedStep) {
		t.Fatalf("CreateCheckpoint before completion = %v, want ErrNoCompletedStep", err)
	}
	if err := c.Bootstrap([]MemberID{"late"}); !errors.Is(err, ErrAlreadyInitialized) {
		t.Fatalf("second Bootstrap = %v, want ErrAlreadyInitialized", err)
	}
}

func TestBootstrapValidation(t *testing.T) {
	tests := []struct {
		name    string
		members []MemberID
		want    error
	}{
		{name: "empty", members: nil, want: ErrEmptyMembership},
		{name: "duplicate", members: []MemberID{"a", "a"}, want: ErrDuplicateMember},
		{name: "blank", members: []MemberID{"a", " "}, want: ErrInvalidMember},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var c Coordinator
			err := c.Bootstrap(test.members)
			requireError(t, err, test.want)
			if c.Status().Initialized {
				t.Fatal("failed Bootstrap initialized the coordinator")
			}
		})
	}

	var zero Coordinator
	if err := zero.Bootstrap([]MemberID{"a"}); err != nil {
		t.Fatalf("zero-value Bootstrap: %v", err)
	}
	requireError(t, zero.SubmitGradient(testGradient("", 1, 0)), ErrInvalidMember)

	var uninitialized Coordinator
	requireError(t, uninitialized.SubmitGradient(testGradient("a", 1, 0)), ErrNotInitialized)
	requireError(t, uninitialized.Heartbeat(testHeartbeat("a", 1, 0, 1)), ErrNotInitialized)
	requireError(t, uninitialized.ConfirmCheckpoint(CheckpointAck{ID: 1, Member: "a", Generation: 1}),
		ErrNotInitialized)
	if _, err := uninitialized.Reconfigure([]MemberID{"a"}); !errors.Is(err, ErrNotInitialized) {
		t.Fatalf("Reconfigure before Bootstrap = %v, want ErrNotInitialized", err)
	}
}

func TestGradientAdmissionAndStepAdvance(t *testing.T) {
	ids := []MemberID{"w0", "w1", "w2"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	mustSubmit(t, c, testGradient("w0", 1, 0))
	if status := c.Status(); status.Step != 0 || status.AcceptedGradients != 1 {
		t.Fatalf("after first gradient status = %+v, want step=0 accepted=1", status)
	}

	// A retry of the same contribution is idempotent and must not count twice.
	mustSubmit(t, c, testGradient("w0", 1, 0))
	if status := c.Status(); status.AcceptedGradients != 1 {
		t.Fatalf("idempotent retry changed accepted count to %d", status.AcceptedGradients)
	}

	conflicting := testGradient("w0", 1, 0)
	conflicting.Digest[31]++
	requireError(t, c.SubmitGradient(conflicting), ErrConflictingGradient)

	requireError(t, c.SubmitGradient(testGradient("w1", 1, 1)), ErrFutureStep)
	requireError(t, c.SubmitGradient(testGradient("w1", 0, 0)), ErrStaleGeneration)
	requireError(t, c.SubmitGradient(testGradient("w1", 2, 0)), ErrUnknownGeneration)
	requireError(t, c.SubmitGradient(testGradient("outsider", 1, 0)), ErrUnknownMember)
	requireError(t, c.SubmitGradient(Gradient{Member: " ", Generation: 1, Step: 0}), ErrInvalidMember)

	mustSubmit(t, c, testGradient("w1", 1, 0))
	mustSubmit(t, c, testGradient("w2", 1, 0))

	status := c.Status()
	if status.Step != 1 || status.AcceptedGradients != 0 {
		t.Fatalf("after full step status = %+v, want step=1 accepted=0", status)
	}
	if status.LastCompleted == nil ||
		*status.LastCompleted != (StepRef{Generation: 1, Step: 0}) {
		t.Fatalf("LastCompleted = %+v, want generation=1 step=0", status.LastCompleted)
	}
	history := c.StepHistory()
	if len(history) != 1 {
		t.Fatalf("step history length = %d, want 1", len(history))
	}
	if history[0].Generation != 1 || history[0].Step != 0 {
		t.Fatalf("step history[0] = %+v, want generation=1 step=0", history[0])
	}
	for rank, id := range ids {
		if history[0].Members[rank] != id {
			t.Fatalf("step history member[%d] = %q, want %q", rank, history[0].Members[rank], id)
		}
	}

	requireError(t, c.SubmitGradient(testGradient("w0", 1, 0)), ErrStaleStep)
	mustSubmit(t, c, testGradient("w0", 1, 1))
	if status := c.Status(); status.Step != 1 || status.AcceptedGradients != 1 {
		t.Fatalf("step 1 partial status = %+v, want step=1 accepted=1", status)
	}
}

func TestHeartbeatAdmission(t *testing.T) {
	ids := []MemberID{"a", "b"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := c.Heartbeat(testHeartbeat("a", 1, 0, 1)); err != nil {
		t.Fatalf("first heartbeat: %v", err)
	}
	if err := c.Heartbeat(testHeartbeat("a", 1, 0, 2)); err != nil {
		t.Fatalf("newer heartbeat: %v", err)
	}
	requireError(t, c.Heartbeat(testHeartbeat("a", 1, 0, 2)), ErrStaleHeartbeat)
	requireError(t, c.Heartbeat(testHeartbeat("a", 1, 0, 1)), ErrStaleHeartbeat)
	requireError(t, c.Heartbeat(testHeartbeat("b", 1, 0, 0)), ErrInvalidHeartbeat)
	requireError(t, c.Heartbeat(testHeartbeat("b", 0, 0, 1)), ErrStaleGeneration)
	requireError(t, c.Heartbeat(testHeartbeat("b", 2, 0, 1)), ErrUnknownGeneration)
	requireError(t, c.Heartbeat(testHeartbeat("b", 1, 1, 1)), ErrFutureStep)

	submitAll(t, c, 1, 0, ids)
	requireError(t, c.Heartbeat(testHeartbeat("b", 1, 0, 1)), ErrStaleStep)
	if err := c.Heartbeat(testHeartbeat("b", 1, 1, 1)); err != nil {
		t.Fatalf("heartbeat for active step: %v", err)
	}

	transition, err := c.Reconfigure([]MemberID{"a", "b"})
	if err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}
	if transition.FrozenStep != 1 || transition.StartStep != 1 {
		t.Fatalf("transition = %+v, want frozen/start step 1", transition)
	}
	requireError(t, c.Heartbeat(testHeartbeat("b", 1, 1, 2)), ErrStaleGeneration)
	if err := c.Heartbeat(testHeartbeat("b", 2, 1, 1)); err != nil {
		t.Fatalf("heartbeat after reconfiguration: %v", err)
	}
	requireError(t, c.Heartbeat(testHeartbeat("outsider", 2, 1, 1)), ErrUnknownMember)
}

func TestCheckpointVisibilityRequiresAllConfirmations(t *testing.T) {
	ids := []MemberID{"a", "b", "c"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	submitAll(t, c, 1, 0, ids)

	id, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}
	sameID, err := c.CreateCheckpoint()
	if err != nil || sameID != id {
		t.Fatalf("idempotent CreateCheckpoint = %d, %v, want %d, nil", sameID, err, id)
	}
	if _, visible := c.Checkpoint(id); visible {
		t.Fatal("checkpoint visible before confirmations")
	}
	info, ok := c.CheckpointStatus(id)
	if !ok || info.State != CheckpointPending || info.Confirmations != 0 || info.Required != 3 {
		t.Fatalf("initial checkpoint status = %+v, %v", info, ok)
	}

	ack := CheckpointAck{ID: id, Member: "a", Generation: 1}
	if err := c.ConfirmCheckpoint(ack); err != nil {
		t.Fatalf("first confirmation: %v", err)
	}
	if err := c.ConfirmCheckpoint(ack); err != nil {
		t.Fatalf("idempotent confirmation: %v", err)
	}
	info, _ = c.CheckpointStatus(id)
	if info.Confirmations != 1 {
		t.Fatalf("duplicate confirmation counted twice: %+v", info)
	}
	requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: "outsider", Generation: 1}),
		ErrUnknownMember)
	requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: "c", Generation: 2}),
		ErrUnknownGeneration)
	requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: "c", Generation: 0}),
		ErrStaleGeneration)
	requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: 999, Member: "c", Generation: 1}),
		ErrCheckpointNotFound)

	if err := c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: "b", Generation: 1}); err != nil {
		t.Fatalf("second confirmation: %v", err)
	}
	if _, visible := c.Checkpoint(id); visible {
		t.Fatal("checkpoint visible with only 2 of 3 confirmations")
	}
	if got := c.VisibleCheckpoints(); len(got) != 0 {
		t.Fatalf("VisibleCheckpoints = %d before final confirmation", len(got))
	}

	if err := c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: "c", Generation: 1}); err != nil {
		t.Fatalf("final confirmation: %v", err)
	}
	checkpoint, visible := c.Checkpoint(id)
	if !visible {
		t.Fatal("checkpoint not visible after all confirmations")
	}
	if checkpoint.Generation != 1 || checkpoint.Step != 0 {
		t.Fatalf("checkpoint = %+v, want generation=1 step=0", checkpoint)
	}
	for rank, want := range ids {
		if checkpoint.ConfirmedBy[rank] != want {
			t.Fatalf("ConfirmedBy[%d] = %q, want %q", rank, checkpoint.ConfirmedBy[rank], want)
		}
	}
	if got := c.VisibleCheckpoints(); len(got) != 1 || got[0].ID != id {
		t.Fatalf("VisibleCheckpoints = %+v, want only %d", got, id)
	}
	info, _ = c.CheckpointStatus(id)
	if info.State != CheckpointVisible || info.Confirmations != 3 {
		t.Fatalf("visible checkpoint status = %+v", info)
	}
}

func TestReconfigureAbortsPendingCheckpoint(t *testing.T) {
	ids := []MemberID{"a", "b", "c"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	submitAll(t, c, 1, 0, ids)

	id, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}
	for _, member := range []MemberID{"a", "b"} {
		if err := c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: member, Generation: 1}); err != nil {
			t.Fatalf("confirm %q: %v", member, err)
		}
	}

	transition, err := c.Reconfigure([]MemberID{"a", "b"})
	if err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}
	if transition.FrozenStep != 1 || transition.StartStep != 1 || transition.DiscardedGradients != 0 {
		t.Fatalf("transition = %+v, want frozen/start step 1 and no discarded gradients", transition)
	}
	if len(transition.AbortedCheckpoints) != 1 || transition.AbortedCheckpoints[0] != id {
		t.Fatalf("aborted checkpoints = %v, want [%d]", transition.AbortedCheckpoints, id)
	}
	if _, visible := c.Checkpoint(id); visible {
		t.Fatal("aborted checkpoint became visible")
	}
	info, _ := c.CheckpointStatus(id)
	if info.State != CheckpointAborted || info.Confirmations != 2 {
		t.Fatalf("aborted checkpoint status = %+v", info)
	}
	for _, member := range ids {
		requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: id, Member: member, Generation: 1}),
			ErrCheckpointAborted)
	}

	// A new generation cannot checkpoint a step that only an old generation
	// completed.
	if _, err := c.CreateCheckpoint(); !errors.Is(err, ErrNoCompletedStep) {
		t.Fatalf("CreateCheckpoint after reconfiguration = %v, want ErrNoCompletedStep", err)
	}

	submitAll(t, c, 2, 1, []MemberID{"a", "b"})
	newID, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint in generation 2: %v", err)
	}
	confirmAll(t, c, newID, 2, []MemberID{"a", "b"})
	if _, visible := c.Checkpoint(newID); !visible {
		t.Fatal("new checkpoint not visible after all confirmations")
	}
	if _, visible := c.Checkpoint(id); visible {
		t.Fatal("aborted checkpoint must remain invisible")
	}

	assertNoCrossGenerationMixing(t, c, map[Generation][]MemberID{
		1: ids,
		2: {"a", "b"},
	})
}

func TestReconfigureValidationLeavesStateIntact(t *testing.T) {
	c, err := New([]MemberID{"a", "b"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mustSubmit(t, c, testGradient("a", 1, 0))

	for _, test := range []struct {
		name    string
		members []MemberID
		want    error
	}{
		{name: "empty", members: nil, want: ErrEmptyMembership},
		{name: "duplicate", members: []MemberID{"a", "a"}, want: ErrDuplicateMember},
		{name: "blank", members: []MemberID{"a", "  "}, want: ErrInvalidMember},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := c.Reconfigure(test.members); !errors.Is(err, test.want) {
				t.Fatalf("Reconfigure(%v) = %v, want %v", test.members, err, test.want)
			}
			status := c.Status()
			if status.Generation != 1 || status.Step != 0 || status.AcceptedGradients != 1 {
				t.Fatalf("failed Reconfigure mutated state: %+v", status)
			}
		})
	}

	mustSubmit(t, c, testGradient("b", 1, 0))
	if c.Status().Step != 1 {
		t.Fatal("old generation could no longer complete its step after failed reconfigurations")
	}

	transition, err := c.Reconfigure([]MemberID{"x", "y", "z"})
	if err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}
	if transition.PreviousGeneration != 1 || transition.Generation != 2 ||
		transition.FrozenStep != 1 || transition.StartStep != 1 {
		t.Fatalf("transition = %+v, want 1->2 at step 1", transition)
	}
	wantMembers(t, transition.Members, 2, []MemberID{"x", "y", "z"})
}

func TestFailureAndPartitionSequenceNeverMixesGenerations(t *testing.T) {
	oldIDs := []MemberID{"a", "b", "c", "d"}
	c, err := New(oldIDs)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	expected := map[Generation][]MemberID{1: oldIDs}

	// Step 0 completes, then its checkpoint is fully confirmed and visible.
	submitAll(t, c, 1, 0, oldIDs)
	visibleID, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint step 0: %v", err)
	}
	confirmAll(t, c, visibleID, 1, oldIDs)
	if _, visible := c.Checkpoint(visibleID); !visible {
		t.Fatal("checkpoint for step 0 not visible")
	}

	// Step 1 completes, but its checkpoint is only confirmed by the surviving
	// partition.
	submitAll(t, c, 1, 1, oldIDs)
	pendingID, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint step 1: %v", err)
	}
	for _, member := range []MemberID{"a", "b"} {
		if err := c.ConfirmCheckpoint(CheckpointAck{ID: pendingID, Member: member, Generation: 1}); err != nil {
			t.Fatalf("confirm %q: %v", member, err)
		}
	}

	// Step 2 is partially accepted when the network splits. The coordinator
	// still sees b and c, but only the a/b side will survive reconfiguration.
	mustSubmit(t, c, testGradient("b", 1, 2))
	mustSubmit(t, c, testGradient("c", 1, 2))

	transition, err := c.Reconfigure([]MemberID{"a", "b"})
	if err != nil {
		t.Fatalf("Reconfigure after partition: %v", err)
	}
	if transition.FrozenStep != 2 || transition.StartStep != 2 || transition.DiscardedGradients != 2 {
		t.Fatalf("transition = %+v, want freeze at step 2 with 2 discarded gradients", transition)
	}
	if len(transition.AbortedCheckpoints) != 1 || transition.AbortedCheckpoints[0] != pendingID {
		t.Fatalf("aborted checkpoints = %v, want [%d]", transition.AbortedCheckpoints, pendingID)
	}
	if contributions := c.Contributions(); len(contributions) != 0 {
		t.Fatalf("discarded generation-1 contributions remain active: %+v", contributions)
	}
	expected[2] = []MemberID{"a", "b"}

	// Delayed confirmations from the isolated side cannot make the old
	// checkpoint visible after the generation changed.
	for _, member := range []MemberID{"c", "d"} {
		requireError(t, c.ConfirmCheckpoint(CheckpointAck{ID: pendingID, Member: member, Generation: 1}),
			ErrCheckpointAborted)
	}
	if _, visible := c.Checkpoint(pendingID); visible {
		t.Fatal("pending checkpoint became visible after partition")
	}
	if _, visible := c.Checkpoint(visibleID); !visible {
		t.Fatal("previously visible checkpoint disappeared after reconfiguration")
	}

	// Every queued gradient and heartbeat from the isolated old generation is
	// rejected: no stale work enters generation 2.
	for _, member := range []MemberID{"c", "d"} {
		requireError(t, c.SubmitGradient(testGradient(member, 1, 2)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 1, 2, 1)), ErrStaleGeneration)

		// The isolated side did not receive generation 2 either, but even a
		// current-generation envelope from a non-member is rejected.
		requireError(t, c.SubmitGradient(testGradient(member, 2, 2)), ErrUnknownMember)
		requireError(t, c.Heartbeat(testHeartbeat(member, 2, 2, 1)), ErrUnknownMember)
	}
	// Members retained by the new generation are still rejected when they
	// present the old generation envelope.
	for _, member := range []MemberID{"a", "b"} {
		requireError(t, c.SubmitGradient(testGradient(member, 1, 2)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 1, 2, 1)), ErrStaleGeneration)
	}

	// Generation 2 completes step 2 without any generation-1 contribution.
	submitAll(t, c, 2, 2, []MemberID{"a", "b"})
	if c.Status().Step != 3 {
		t.Fatalf("after generation 2 step 2, active step = %d, want 3", c.Status().Step)
	}

	// Heal the partition: the old side is readmitted as generation 3. Before
	// the reconfiguration it still presents stale generation-1 envelopes.
	for _, member := range []MemberID{"c", "d"} {
		requireError(t, c.SubmitGradient(testGradient(member, 1, 3)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 1, 3, 1)), ErrStaleGeneration)
	}
	transition, err = c.Reconfigure([]MemberID{"a", "b", "c", "d"})
	if err != nil {
		t.Fatalf("Reconfigure after heal: %v", err)
	}
	if transition.FrozenStep != 3 || transition.StartStep != 3 || transition.DiscardedGradients != 0 {
		t.Fatalf("heal transition = %+v, want step 3 with no discarded gradients", transition)
	}
	expected[3] = []MemberID{"a", "b", "c", "d"}

	for _, member := range []MemberID{"c", "d"} {
		requireError(t, c.SubmitGradient(testGradient(member, 1, 3)), ErrStaleGeneration)
		requireError(t, c.SubmitGradient(testGradient(member, 2, 3)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 1, 3, 1)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 2, 3, 1)), ErrStaleGeneration)
	}
	for _, member := range []MemberID{"a", "b"} {
		requireError(t, c.SubmitGradient(testGradient(member, 2, 3)), ErrStaleGeneration)
		requireError(t, c.Heartbeat(testHeartbeat(member, 2, 3, 1)), ErrStaleGeneration)
	}

	submitAll(t, c, 3, 3, []MemberID{"a", "b", "c", "d"})
	assertNoCrossGenerationMixing(t, c, expected)

	generations := c.GenerationHistory()
	if len(generations) != 2 {
		t.Fatalf("retired generations = %d, want 2", len(generations))
	}
	if !generations[0].Frozen || generations[0].DiscardedGradients != 2 ||
		len(generations[0].AbortedCheckpoints) != 1 ||
		generations[0].AbortedCheckpoints[0] != pendingID {
		t.Fatalf("generation 1 record = %+v", generations[0])
	}
	if generations[0].StartStep != 0 || generations[0].EndStep != 2 {
		t.Fatalf("generation 1 steps = %d..%d, want 0..2",
			generations[0].StartStep, generations[0].EndStep)
	}
	if generations[1].Frozen || generations[1].DiscardedGradients != 0 {
		t.Fatalf("generation 2 record = %+v, want clean retirement", generations[1])
	}

	if _, visible := c.Checkpoint(pendingID); visible {
		t.Fatal("aborted checkpoint became visible after healing")
	}
	if visible := c.VisibleCheckpoints(); len(visible) != 1 || visible[0].ID != visibleID {
		t.Fatalf("visible checkpoints = %+v, want only immutable %d", visible, visibleID)
	}
}

func TestConcurrentCompletionProducesOneStepRecord(t *testing.T) {
	ids := make([]MemberID, 8)
	for i := range ids {
		ids[i] = MemberID("w" + string(rune('0'+i)))
	}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	var wg sync.WaitGroup
	errorsCh := make(chan error, len(ids))
	for _, member := range ids {
		wg.Add(1)
		go func(member MemberID) {
			defer wg.Done()
			for sequence := uint64(1); sequence <= 50; sequence++ {
				if err := c.Heartbeat(testHeartbeat(member, 1, 0, sequence)); err != nil {
					errorsCh <- err
					return
				}
			}
		}(member)
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent heartbeat: %v", err)
	}

	errorsCh = make(chan error, len(ids))
	for _, member := range ids {
		wg.Add(1)
		go func(member MemberID) {
			defer wg.Done()
			if err := c.SubmitGradient(testGradient(member, 1, 0)); err != nil {
				errorsCh <- err
			}
		}(member)
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent gradient: %v", err)
	}

	if status := c.Status(); status.Step != 1 || status.AcceptedGradients != 0 {
		t.Fatalf("status after concurrent completion = %+v, want step=1 accepted=0", status)
	}
	history := c.StepHistory()
	if len(history) != 1 {
		t.Fatalf("step history length = %d, want exactly 1", len(history))
	}
	if len(history[0].Members) != len(ids) {
		t.Fatalf("step record has %d members, want %d", len(history[0].Members), len(ids))
	}
}

func TestReturnedSnapshotsDoNotAliasInternalState(t *testing.T) {
	ids := []MemberID{"a", "b"}
	c, err := New(ids)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	submitAll(t, c, 1, 0, ids)
	id, err := c.CreateCheckpoint()
	if err != nil {
		t.Fatalf("CreateCheckpoint: %v", err)
	}
	confirmAll(t, c, id, 1, ids)

	members := c.Members()
	members[0].ID = "mutated"
	records := c.StepHistory()
	records[0].Members[0] = "mutated"
	checkpoint, _ := c.Checkpoint(id)
	checkpoint.ConfirmedBy[0] = "mutated"

	if got := c.Members(); got[0].ID != "a" {
		t.Fatalf("Members aliased internal state: %+v", got)
	}
	if got := c.StepHistory(); got[0].Members[0] != "a" {
		t.Fatalf("StepHistory aliased internal state: %+v", got)
	}
	got, _ := c.Checkpoint(id)
	if got.ConfirmedBy[0] != "a" {
		t.Fatalf("Checkpoint aliased internal state: %+v", got)
	}
}
