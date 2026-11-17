package formal

import (
	"errors"
	"testing"
	"time"
)

func newTestCoordinator(t *testing.T, count int) *Coordinator {
	t.Helper()
	coordinator, err := NewCoordinator(Partitions("orders", 0, 1, 2, 3, 4, 5)[:count])
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	return coordinator
}

func mustJoin(t *testing.T, coordinator *Coordinator, memberID string, opts JoinOptions, now time.Time) JoinResult {
	t.Helper()
	result, err := coordinator.Join(memberID, opts, now)
	if err != nil {
		t.Fatalf("Join(%s): %v", memberID, err)
	}
	return result
}

func settle(t *testing.T, coordinator *Coordinator) Snapshot {
	t.Helper()
	for {
		snapshot := coordinator.Snapshot()
		if !snapshot.Rebalancing {
			return snapshot
		}
		acked := false
		for _, member := range snapshot.Members {
			if !member.AwaitingRevocation {
				continue
			}
			result, err := coordinator.AckRevocation(member.ID, snapshot.PendingGeneration)
			if err != nil {
				t.Fatalf("AckRevocation(%s, %d): %v", member.ID, snapshot.PendingGeneration, err)
			}
			if result.Complete && result.Generation != snapshot.PendingGeneration {
				t.Fatalf("completed generation %d, want %d", result.Generation, snapshot.PendingGeneration)
			}
			acked = true
			break
		}
		if !acked {
			t.Fatalf("rebalance pending generation %d with no revocation waiters", snapshot.PendingGeneration)
		}
	}
}

func ownerMap(t *testing.T, snapshot Snapshot) map[Partition]string {
	t.Helper()
	owners := make(map[Partition]string, len(snapshot.Assignments))
	for _, assignment := range snapshot.Assignments {
		if previous, ok := owners[assignment.Partition]; ok {
			t.Fatalf("partition %s has owners %q and %q in generation %d",
				assignment.Partition, previous, assignment.MemberID, snapshot.Generation)
		}
		owners[assignment.Partition] = assignment.MemberID
	}
	return owners
}

func pendingOwnerMap(t *testing.T, snapshot Snapshot) map[Partition]string {
	t.Helper()
	owners := make(map[Partition]string, len(snapshot.PendingAssignments))
	for _, assignment := range snapshot.PendingAssignments {
		if previous, ok := owners[assignment.Partition]; ok {
			t.Fatalf("pending partition %s has owners %q and %q",
				assignment.Partition, previous, assignment.MemberID)
		}
		owners[assignment.Partition] = assignment.MemberID
	}
	return owners
}

func assertOwnership(t *testing.T, coordinator *Coordinator) Snapshot {
	t.Helper()
	if err := coordinator.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	snapshot := coordinator.Snapshot()
	owners := ownerMap(t, snapshot)
	if !snapshot.Rebalancing && len(snapshot.Members) > 0 {
		if len(owners) != len(snapshot.Partitions) {
			t.Fatalf("generation %d owns %d/%d partitions: %v",
				snapshot.Generation, len(owners), len(snapshot.Partitions), owners)
		}
	}
	if snapshot.Rebalancing && len(snapshot.Members) > 0 {
		pending := pendingOwnerMap(t, snapshot)
		if len(pending) != len(snapshot.Partitions) {
			t.Fatalf("pending generation %d covers %d/%d partitions: %v",
				snapshot.PendingGeneration, len(pending), len(snapshot.Partitions), pending)
		}
	}

	consumable := make(map[Partition]string, len(snapshot.Partitions))
	for _, member := range snapshot.Members {
		assigned := make(map[Partition]struct{}, len(member.Assignment))
		for _, partition := range member.Assignment {
			assigned[partition] = struct{}{}
			if owner := owners[partition]; owner != member.ID {
				t.Fatalf("member %s lists partition %s but active owner is %q", member.ID, partition, owner)
			}
		}
		for _, partition := range member.Consumable {
			if _, ok := assigned[partition]; !ok {
				t.Fatalf("member %s can consume unassigned partition %s", member.ID, partition)
			}
			if previous, ok := consumable[partition]; ok {
				t.Fatalf("partition %s consumable by both %q and %q", partition, previous, member.ID)
			}
			consumable[partition] = member.ID
		}
	}
	if !snapshot.Rebalancing && len(snapshot.Members) > 0 && len(consumable) != len(snapshot.Partitions) {
		t.Fatalf("generation %d has %d/%d consumable partitions: %v",
			snapshot.Generation, len(consumable), len(snapshot.Partitions), consumable)
	}

	return snapshot
}

func recordGeneration(t *testing.T, snapshot Snapshot, generations map[int64]map[Partition]string) {
	t.Helper()
	if snapshot.Rebalancing {
		return
	}
	current := ownerMap(t, snapshot)
	if previous, ok := generations[snapshot.Generation]; ok {
		if len(previous) != len(current) {
			t.Fatalf("generation %d changed ownership size", snapshot.Generation)
		}
		for partition, owner := range current {
			if previous[partition] != owner {
				t.Fatalf("generation %d partition %s moved from %q to %q without a new generation",
					snapshot.Generation, partition, previous[partition], owner)
			}
		}
		return
	}
	generations[snapshot.Generation] = current
}

func TestJoinWaitsForRevocationBeforeTransfer(t *testing.T) {
	coordinator := newTestCoordinator(t, 4)
	start := time.Unix(1_000, 0)

	a := mustJoin(t, coordinator, "A", JoinOptions{}, start)
	if a.Generation != 1 || len(a.Assignment) != 4 || a.Rebalancing {
		t.Fatalf("A join = %+v, want generation 1 with four partitions", a)
	}
	assertOwnership(t, coordinator)

	for i, partition := range coordinator.partitions {
		if err := coordinator.Commit("A", 1, partition, int64(100+i)); err != nil {
			t.Fatalf("seed commit %s: %v", partition, err)
		}
	}

	b := mustJoin(t, coordinator, "B", JoinOptions{}, start.Add(time.Second))
	if b.Generation != 1 || !b.Rebalancing || len(b.Assignment) != 0 {
		t.Fatalf("B join = %+v, want a pending rebalance with no consumable partitions", b)
	}
	snapshot := assertOwnership(t, coordinator)
	if snapshot.PendingGeneration != 2 || snapshot.Generation != 1 {
		t.Fatalf("generation state = active %d pending %d, want 1/2",
			snapshot.Generation, snapshot.PendingGeneration)
	}

	var targetForB []Partition
	for _, assignment := range snapshot.PendingAssignments {
		if assignment.MemberID == "B" {
			targetForB = append(targetForB, assignment.Partition)
		}
	}
	if len(targetForB) == 0 {
		t.Fatal("B has no target partitions")
	}

	// The new generation is not active yet, even for partitions B will own.
	if err := coordinator.Commit("B", snapshot.PendingGeneration, targetForB[0], 0); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("B pending-generation commit error = %v, want ErrStaleGeneration", err)
	}
	if err := coordinator.Commit("B", snapshot.Generation, targetForB[0], 0); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("B active-generation commit error = %v, want ErrNotOwner", err)
	}

	var revokedByA []Partition
	for _, member := range snapshot.Members {
		if member.ID == "A" {
			revokedByA = member.Revoking
		}
	}
	if len(revokedByA) == 0 {
		t.Fatal("A has no partitions to revoke")
	}
	if err := coordinator.Commit("A", snapshot.Generation, revokedByA[0], 10_000); !errors.Is(err, ErrRevoked) {
		t.Fatalf("commit after revocation request error = %v, want ErrRevoked", err)
	}

	if _, err := coordinator.AckRevocation("A", snapshot.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("ack with active generation error = %v, want ErrStaleGeneration", err)
	}
	ack, err := coordinator.AckRevocation("A", snapshot.PendingGeneration)
	if err != nil {
		t.Fatalf("AckRevocation: %v", err)
	}
	if !ack.Complete || ack.Generation != 2 {
		t.Fatalf("ack result = %+v, want completed generation 2", ack)
	}

	snapshot = assertOwnership(t, coordinator)
	if snapshot.Rebalancing || snapshot.Generation != 2 {
		t.Fatalf("after ack state = %+v, want active generation 2", snapshot)
	}

	// New owners can continue from the committed offsets, including an equal
	// offset, but a lower offset is rejected.
	for _, assignment := range snapshot.Assignments {
		previous, ok := coordinator.CommittedOffset(assignment.Partition)
		if !ok {
			t.Fatalf("missing committed offset for %s", assignment.Partition)
		}
		if err := coordinator.Commit(assignment.MemberID, 2, assignment.Partition, previous); err != nil {
			t.Fatalf("equal-offset commit by %s for %s: %v", assignment.MemberID, assignment.Partition, err)
		}
		if err := coordinator.Commit(assignment.MemberID, 2, assignment.Partition, previous-1); !errors.Is(err, ErrOffsetRegression) {
			t.Fatalf("regressing commit error = %v, want ErrOffsetRegression", err)
		}
		if err := coordinator.Commit(assignment.MemberID, 2, assignment.Partition, previous+1); err != nil {
			t.Fatalf("advancing commit by %s for %s: %v", assignment.MemberID, assignment.Partition, err)
		}
	}

	if err := coordinator.Commit("A", 1, snapshot.Assignments[0].Partition, 20_000); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old-generation commit error = %v, want ErrStaleGeneration", err)
	}
}

func TestHeartbeatTimeoutRebalancesAndFencesOldGeneration(t *testing.T) {
	coordinator := newTestCoordinator(t, 4)
	start := time.Unix(2_000, 0)
	opts := JoinOptions{SessionTimeout: 10 * time.Second}

	mustJoin(t, coordinator, "A", opts, start)
	mustJoin(t, coordinator, "B", opts, start.Add(time.Second))
	settle(t, coordinator)
	snapshot := assertOwnership(t, coordinator)
	if snapshot.Generation != 2 {
		t.Fatalf("generation after join = %d, want 2", snapshot.Generation)
	}

	if _, err := coordinator.Heartbeat("A", start.Add(8*time.Second)); err != nil {
		t.Fatalf("A heartbeat: %v", err)
	}
	if expired := coordinator.ExpireHeartbeats(start.Add(10 * time.Second)); len(expired) != 0 {
		t.Fatalf("expired before deadline: %v", expired)
	}

	expired := coordinator.ExpireHeartbeats(start.Add(11 * time.Second))
	if len(expired) != 1 || expired[0] != "B" {
		t.Fatalf("expired members = %v, want [B]", expired)
	}

	snapshot = assertOwnership(t, coordinator)
	if snapshot.Rebalancing || snapshot.Generation != 3 {
		t.Fatalf("post-timeout state = %+v, want active generation 3", snapshot)
	}
	if len(snapshot.Members) != 1 || snapshot.Members[0].ID != "A" {
		t.Fatalf("members after timeout = %+v, want only A", snapshot.Members)
	}
	if len(snapshot.Assignments) != 4 {
		t.Fatalf("A owns %d partitions, want 4", len(snapshot.Assignments))
	}

	if _, err := coordinator.Heartbeat("B", start.Add(12*time.Second)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("heartbeat from timed-out member error = %v, want ErrUnknownMember", err)
	}
	if err := coordinator.Commit("B", 2, coordinator.partitions[0], 1); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("commit from timed-out member error = %v, want ErrUnknownMember", err)
	}
	if err := coordinator.Commit("A", 3, coordinator.partitions[0], 50); err != nil {
		t.Fatalf("A commit in generation 3: %v", err)
	}
}

func TestStaticMemberBriefReconnectKeepsOwnership(t *testing.T) {
	coordinator := newTestCoordinator(t, 3)
	start := time.Unix(3_000, 0)
	opts := JoinOptions{InstanceID: "instance-a", SessionTimeout: 10 * time.Second}

	first := mustJoin(t, coordinator, "A", opts, start)
	if first.Generation != 1 || len(first.Assignment) != 3 {
		t.Fatalf("first join = %+v", first)
	}
	if err := coordinator.Commit("A", 1, coordinator.partitions[0], 7); err != nil {
		t.Fatalf("commit before reconnect: %v", err)
	}

	if _, err := coordinator.Heartbeat("A", start.Add(9*time.Second)); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	reconnect := mustJoin(t, coordinator, "A-restarted", opts, start.Add(9*time.Second))
	if !reconnect.Reconnected || reconnect.Rebalancing || reconnect.Generation != 1 {
		t.Fatalf("reconnect = %+v, want generation 1 without rebalance", reconnect)
	}
	if reconnect.MemberID != "A-restarted" {
		t.Fatalf("reconnect member ID = %q, want A-restarted", reconnect.MemberID)
	}
	if len(reconnect.Assignment) != 3 {
		t.Fatalf("reconnect assignment = %v, want all 3 partitions", reconnect.Assignment)
	}
	if _, err := coordinator.Heartbeat("A", start.Add(9*time.Second)); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("old member ID after rebind error = %v, want ErrUnknownMember", err)
	}
	if _, err := coordinator.Heartbeat("A-restarted", start.Add(9*time.Second)); err != nil {
		t.Fatalf("heartbeat after rebind: %v", err)
	}
	assertOwnership(t, coordinator)

	if expired := coordinator.ExpireHeartbeats(start.Add(18 * time.Second)); len(expired) != 0 {
		t.Fatalf("static member expired before session deadline: %v", expired)
	}
	if expired := coordinator.ExpireHeartbeats(start.Add(19 * time.Second)); len(expired) != 1 || expired[0] != "A-restarted" {
		t.Fatalf("expired static member = %v, want [A-restarted]", expired)
	}
	snapshot := assertOwnership(t, coordinator)
	if snapshot.Generation != 2 || len(snapshot.Assignments) != 0 {
		t.Fatalf("after static timeout = generation %d with %d assignments", snapshot.Generation, len(snapshot.Assignments))
	}

	late := mustJoin(t, coordinator, "A-late", opts, start.Add(20*time.Second))
	if late.Reconnected {
		t.Fatal("join after session timeout was treated as a reconnect")
	}
	if late.Generation != 3 || len(late.Assignment) != 3 {
		t.Fatalf("late join = %+v, want new generation with all partitions", late)
	}
	if err := coordinator.Commit("A-late", 1, coordinator.partitions[0], 8); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("commit with generation 1 error = %v, want ErrStaleGeneration", err)
	}
}

func TestNewMembershipSupersedesPendingRevocation(t *testing.T) {
	coordinator := newTestCoordinator(t, 2)
	start := time.Unix(4_000, 0)

	mustJoin(t, coordinator, "A", JoinOptions{}, start)
	mustJoin(t, coordinator, "B", JoinOptions{}, start.Add(time.Second))
	pendingTwo := assertOwnership(t, coordinator)
	if !pendingTwo.Rebalancing || pendingTwo.PendingGeneration != 2 {
		t.Fatalf("first pending rebalance = %+v", pendingTwo)
	}

	mustJoin(t, coordinator, "C", JoinOptions{}, start.Add(2*time.Second))
	pendingThree := assertOwnership(t, coordinator)
	if !pendingThree.Rebalancing || pendingThree.PendingGeneration != 3 || pendingThree.Generation != 1 {
		t.Fatalf("superseding rebalance = active %d pending %d, want 1/3",
			pendingThree.Generation, pendingThree.PendingGeneration)
	}

	var aRevoking bool
	for _, member := range pendingThree.Members {
		if member.ID == "A" && member.AwaitingRevocation {
			aRevoking = true
		}
	}
	if !aRevoking {
		t.Fatal("A should be waiting for revocation in the superseding generation")
	}
	if _, err := coordinator.AckRevocation("A", 2); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("ack for superseded generation error = %v, want ErrStaleGeneration", err)
	}
	if coordinator.Generation() != 1 {
		t.Fatalf("superseded ack activated generation %d", coordinator.Generation())
	}

	result, err := coordinator.AckRevocation("A", 3)
	if err != nil {
		t.Fatalf("ack generation 3: %v", err)
	}
	if !result.Complete || result.Generation != 3 {
		t.Fatalf("superseding ack result = %+v", result)
	}
	snapshot := assertOwnership(t, coordinator)
	if snapshot.Generation != 3 || snapshot.Rebalancing {
		t.Fatalf("final state = active %d rebalancing %v", snapshot.Generation, snapshot.Rebalancing)
	}
}

func TestControlledEventSequenceHasUniqueOwnersAndMonotonicProgress(t *testing.T) {
	coordinator := newTestCoordinator(t, 6)
	start := time.Unix(5_000, 0)
	opts := JoinOptions{SessionTimeout: 5 * time.Second}
	staticOpts := JoinOptions{InstanceID: "instance-b", SessionTimeout: 5 * time.Second}

	generations := make(map[int64]map[Partition]string)
	progress := make(map[Partition]int64)
	lastGeneration := int64(0)

	commitProgress := func(label string) Snapshot {
		t.Helper()
		snapshot := settle(t, coordinator)
		snapshot = assertOwnership(t, coordinator)
		recordGeneration(t, snapshot, generations)

		if lastGeneration != 0 && lastGeneration < snapshot.Generation {
			assignment := snapshot.Assignments[0]
			if err := coordinator.Commit(assignment.MemberID, lastGeneration, assignment.Partition, progress[assignment.Partition]); !errors.Is(err, ErrStaleGeneration) {
				t.Fatalf("%s: stale-generation commit error = %v, want ErrStaleGeneration", label, err)
			}
		}

		for _, assignment := range snapshot.Assignments {
			next := progress[assignment.Partition] + 1
			if err := coordinator.Commit(assignment.MemberID, snapshot.Generation, assignment.Partition, next); err != nil {
				t.Fatalf("%s: commit %s at %d by %s: %v", label, assignment.Partition, next, assignment.MemberID, err)
			}
			if next > 1 {
				if err := coordinator.Commit(assignment.MemberID, snapshot.Generation, assignment.Partition, next-1); !errors.Is(err, ErrOffsetRegression) {
					t.Fatalf("%s: regression commit error = %v, want ErrOffsetRegression", label, err)
				}
			}
			if err := coordinator.Commit(assignment.MemberID, snapshot.Generation, assignment.Partition, next); err != nil {
				t.Fatalf("%s: idempotent equal commit: %v", label, err)
			}
			progress[assignment.Partition] = next
			if got, ok := coordinator.CommittedOffset(assignment.Partition); !ok || got != next {
				t.Fatalf("%s: committed offset %s = %d/%v, want %d", label, assignment.Partition, got, ok, next)
			}
		}
		lastGeneration = snapshot.Generation
		return snapshot
	}

	first := mustJoin(t, coordinator, "A", opts, start)
	if first.Generation != 1 {
		t.Fatalf("A joined generation %d, want 1", first.Generation)
	}
	commitProgress("A joins")

	mustJoin(t, coordinator, "B", staticOpts, start.Add(time.Second))
	if generation := coordinator.Generation(); generation != 1 {
		t.Fatalf("B join activated generation %d before revocation ack", generation)
	}
	second := commitProgress("B joins")
	if second.Generation != 2 {
		t.Fatalf("B join settled at generation %d, want 2", second.Generation)
	}

	mustJoin(t, coordinator, "C", opts, start.Add(2*time.Second))
	third := commitProgress("C joins")
	if third.Generation != 3 {
		t.Fatalf("C join settled at generation %d, want 3", third.Generation)
	}

	for _, memberID := range []string{"A", "B", "C"} {
		if _, err := coordinator.Heartbeat(memberID, start.Add(3*time.Second)); err != nil {
			t.Fatalf("heartbeat %s: %v", memberID, err)
		}
	}
	reconnect := mustJoin(t, coordinator, "B", staticOpts, start.Add(4*time.Second))
	if !reconnect.Reconnected || reconnect.Generation != 3 || reconnect.Rebalancing {
		t.Fatalf("static reconnect = %+v, want unchanged generation 3", reconnect)
	}
	reconnected := assertOwnership(t, coordinator)
	recordGeneration(t, reconnected, generations)
	for _, assignment := range reconnected.Assignments {
		if err := coordinator.Commit(assignment.MemberID, reconnected.Generation, assignment.Partition, progress[assignment.Partition]); err != nil {
			t.Fatalf("commit after static reconnect for %s: %v", assignment.Partition, err)
		}
	}

	if err := coordinator.Leave("C"); err != nil {
		t.Fatalf("C leaves: %v", err)
	}
	fourth := commitProgress("C leaves")
	if fourth.Generation != 4 {
		t.Fatalf("C leave settled at generation %d, want 4", fourth.Generation)
	}

	expired := coordinator.ExpireHeartbeats(start.Add(8 * time.Second))
	if len(expired) != 1 || expired[0] != "A" {
		t.Fatalf("expired members = %v, want [A]", expired)
	}
	fifth := commitProgress("A times out")
	if fifth.Generation != 5 {
		t.Fatalf("A timeout settled at generation %d, want 5", fifth.Generation)
	}
	if len(fifth.Members) != 1 || fifth.Members[0].ID != "B" {
		t.Fatalf("final members = %+v, want B", fifth.Members)
	}
	if len(fifth.Assignments) != 6 {
		t.Fatalf("B owns %d partitions, want 6", len(fifth.Assignments))
	}

	wantGenerations := []int64{1, 2, 3, 4, 5}
	for _, generation := range wantGenerations {
		if _, ok := generations[generation]; !ok {
			t.Errorf("generation %d was never active", generation)
		}
	}
	for partition, offset := range progress {
		if offset != 5 {
			t.Errorf("partition %s progressed to %d, want 5 (one commit per generation)", partition, offset)
		}
	}
}

func TestCoordinatorRejectsDuplicatePartitions(t *testing.T) {
	_, err := NewCoordinator([]Partition{
		{Topic: "orders", ID: 1},
		{Topic: "orders", ID: 1},
	})
	if err == nil {
		t.Fatal("NewCoordinator accepted duplicate partitions")
	}
}

func TestAssignmentAndCommitErrorPaths(t *testing.T) {
	coordinator := newTestCoordinator(t, 2)
	start := time.Unix(6_000, 0)

	if _, err := coordinator.Join("", JoinOptions{}, start); !errors.Is(err, ErrInvalidMember) {
		t.Fatalf("empty member join error = %v, want ErrInvalidMember", err)
	}
	if _, err := coordinator.Join("A", JoinOptions{SessionTimeout: -time.Second}, start); !errors.Is(err, ErrInvalidTimeout) {
		t.Fatalf("negative timeout error = %v, want ErrInvalidTimeout", err)
	}

	mustJoin(t, coordinator, "A", JoinOptions{}, start)
	assignment, err := coordinator.Assignment("A")
	if err != nil {
		t.Fatalf("Assignment(A): %v", err)
	}
	if len(assignment) != 2 {
		t.Fatalf("Assignment(A) = %v, want 2 partitions", assignment)
	}
	if _, err := coordinator.Assignment("missing"); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("unknown Assignment error = %v, want ErrUnknownMember", err)
	}
	if err := coordinator.Commit("A", 1, Partition{Topic: "orders", ID: 99}, 1); !errors.Is(err, ErrUnknownPartition) {
		t.Fatalf("unknown partition commit error = %v, want ErrUnknownPartition", err)
	}
	if err := coordinator.Commit("A", 1, assignment[0], -1); !errors.Is(err, ErrInvalidOffset) {
		t.Fatalf("negative offset commit error = %v, want ErrInvalidOffset", err)
	}
	if err := coordinator.Commit("A", 1, assignment[0], 0); err != nil {
		t.Fatalf("valid commit: %v", err)
	}
	if _, err := coordinator.Heartbeat("missing", start); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("unknown heartbeat error = %v, want ErrUnknownMember", err)
	}
	if err := coordinator.Leave("missing"); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("unknown leave error = %v, want ErrUnknownMember", err)
	}
}

func TestLateHeartbeatEvictsMember(t *testing.T) {
	coordinator := newTestCoordinator(t, 2)
	start := time.Unix(7_000, 0)

	mustJoin(t, coordinator, "A", JoinOptions{SessionTimeout: 5 * time.Second}, start)
	if _, err := coordinator.Heartbeat("A", start.Add(5*time.Second)); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("late heartbeat error = %v, want ErrSessionExpired", err)
	}
	if generation := coordinator.Generation(); generation != 2 {
		t.Fatalf("generation after late heartbeat = %d, want 2", generation)
	}
	snapshot := assertOwnership(t, coordinator)
	if len(snapshot.Members) != 0 || len(snapshot.Assignments) != 0 {
		t.Fatalf("state after eviction = %+v, want empty group", snapshot)
	}
}

func TestRevokingMemberTimeoutUnblocksRebalance(t *testing.T) {
	coordinator := newTestCoordinator(t, 3)
	start := time.Unix(8_000, 0)
	opts := JoinOptions{SessionTimeout: 5 * time.Second}

	mustJoin(t, coordinator, "A", opts, start)
	mustJoin(t, coordinator, "B", opts, start.Add(time.Second))
	pending := assertOwnership(t, coordinator)
	if !pending.Rebalancing || pending.PendingGeneration != 2 {
		t.Fatalf("expected pending generation 2, got %+v", pending)
	}

	expired := coordinator.ExpireHeartbeats(start.Add(5 * time.Second))
	if len(expired) != 1 || expired[0] != "A" {
		t.Fatalf("expired members = %v, want [A]", expired)
	}
	snapshot := assertOwnership(t, coordinator)
	if snapshot.Rebalancing || snapshot.Generation != 3 {
		t.Fatalf("state after revoker timeout = %+v, want active generation 3", snapshot)
	}
	if len(snapshot.Members) != 1 || snapshot.Members[0].ID != "B" || len(snapshot.Assignments) != 3 {
		t.Fatalf("B should own all partitions after A times out: %+v", snapshot)
	}
}
