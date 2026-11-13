package dataeng

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"
)

var testNow = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

func mustOpen(t *testing.T, tracker *Tracker, mailbox string, validity UIDValidity, uidNext UID, highest ModSeq) OpenResult {
	t.Helper()
	result, err := tracker.Open(context.Background(), OpenRequest{
		Mailbox:       mailbox,
		UIDValidity:   validity,
		UIDNext:       uidNext,
		HighestModSeq: highest,
	})
	if err != nil {
		t.Fatalf("Open(%q): %v", mailbox, err)
	}
	return result
}

func mustSnapshot(t *testing.T, tracker *Tracker, mailbox string) Snapshot {
	t.Helper()
	snapshot, err := tracker.Snapshot(context.Background(), mailbox)
	if err != nil {
		t.Fatalf("Snapshot(%q): %v", mailbox, err)
	}
	return snapshot
}

func mustState(t *testing.T, tracker *Tracker, mailbox string) MailboxState {
	t.Helper()
	state, err := tracker.State(context.Background(), mailbox)
	if err != nil {
		t.Fatalf("State(%q): %v", mailbox, err)
	}
	return state
}

func simpleMessage(uid UID, modseq ModSeq, messageID string) Message {
	return Message{
		UID:          uid,
		ModSeq:       modseq,
		MessageID:    messageID,
		Flags:        []string{`\Seen`},
		InternalDate: testNow,
		Size:         42,
	}
}

func TestOpenKeepsCursorForSameUIDValidity(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()

	first := mustOpen(t, tracker, "INBOX", 100, 10, 50)
	if first.ResyncRequired == false || first.UIDValidityChanged {
		t.Fatalf("first open result = %+v", first)
	}
	if first.RecoveryPoint.Generation != 1 ||
		first.RecoveryPoint.UIDValidity != 100 ||
		first.RecoveryPoint.UIDNext != 10 ||
		first.RecoveryPoint.HighestModSeq != 50 ||
		first.RecoveryPoint.Revision != 1 {
		t.Fatalf("first recovery point = %+v", first.RecoveryPoint)
	}

	second, err := tracker.Open(ctx, OpenRequest{
		Mailbox:       "INBOX",
		UIDValidity:   100,
		UIDNext:       20,
		HighestModSeq: 70,
	})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if second.UIDValidityChanged || second.ResyncRequired {
		t.Fatalf("reopen result = %+v", second)
	}
	if second.ServerUIDNext != 20 || second.ServerHighestModSeq != 70 {
		t.Fatalf("server values not reported: %+v", second)
	}
	// The durable window must stay at the last committed values so QRESYNC
	// replays 50 -> 70 rather than silently skipping it.
	if second.RecoveryPoint.UIDNext != 10 || second.RecoveryPoint.HighestModSeq != 50 {
		t.Fatalf("durable cursor advanced on reopen: %+v", second.RecoveryPoint)
	}
	if second.RecoveryPoint.Revision != 1 {
		t.Fatalf("reopen changed revision: %d", second.RecoveryPoint.Revision)
	}

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}
	if request.Since != 50 || request.UIDNext != 10 || request.Revision != 1 {
		t.Fatalf("QRESYNC request = %+v", request)
	}
}

func TestOpenRejectsCursorRegression(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 10, 50)

	if _, err := tracker.Open(ctx, OpenRequest{
		Mailbox: "INBOX", UIDValidity: 100, UIDNext: 9, HighestModSeq: 50,
	}); !errors.Is(err, ErrCursorRegression) {
		t.Fatalf("lower UIDNEXT error = %v", err)
	}
	if _, err := tracker.Open(ctx, OpenRequest{
		Mailbox: "INBOX", UIDValidity: 100, UIDNext: 10, HighestModSeq: 49,
	}); !errors.Is(err, ErrCursorRegression) {
		t.Fatalf("lower HIGHESTMODSEQ error = %v", err)
	}
}

func TestUIDValidityChangeStartsNewGeneration(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()

	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	oldSnapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, oldSnapshot, []Message{
		simpleMessage(1, 10, "old-1"),
		simpleMessage(2, 11, "old-2"),
	}); err != nil {
		t.Fatalf("ApplyFetch: %v", err)
	}
	oldRequest, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}

	result, err := tracker.Open(ctx, OpenRequest{
		Mailbox:       "INBOX",
		UIDValidity:   200,
		UIDNext:       5,
		HighestModSeq: 7,
	})
	if err != nil {
		t.Fatalf("generation switch: %v", err)
	}
	if !result.UIDValidityChanged || !result.ResyncRequired {
		t.Fatalf("generation switch result = %+v", result)
	}
	if result.PreviousGeneration != 1 || result.PreviousUIDValidity != 100 {
		t.Fatalf("previous generation = %+v", result)
	}
	if result.RecoveryPoint.Generation != 2 || result.RecoveryPoint.UIDValidity != 200 {
		t.Fatalf("new recovery point = %+v", result.RecoveryPoint)
	}

	state := mustState(t, tracker, "INBOX")
	if len(state.Messages) != 0 {
		t.Fatalf("old generation messages leaked: %+v", state.Messages)
	}
	if state.UIDNext != 5 || state.HighestModSeq != 7 {
		t.Fatalf("new generation cursors = %+v", state)
	}

	if err := tracker.ApplyFetch(ctx, oldSnapshot, []Message{simpleMessage(3, 20, "late")}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old snapshot error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, oldRequest, QResyncResponse{Vanished: []UID{1}}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("old QRESYNC error = %v", err)
	}
	if got := mustState(t, tracker, "INBOX"); len(got.Messages) != 0 {
		t.Fatalf("stale responses changed new generation: %+v", got.Messages)
	}
}

func TestFetchUsesUIDAsIdentityNotMessageID(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)

	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(5, 10, "same@example.org"),
		simpleMessage(6, 11, "same@example.org"),
	}); err != nil {
		t.Fatalf("ApplyFetch: %v", err)
	}

	snapshot = mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(7, 12, "same@example.org"),
	}); err != nil {
		t.Fatalf("ApplyFetch duplicate Message-ID: %v", err)
	}

	state := mustState(t, tracker, "INBOX")
	if len(state.Messages) != 3 {
		t.Fatalf("messages with equal Message-ID were merged: %+v", state.Messages)
	}
	for _, uid := range []UID{5, 6, 7} {
		if state.Messages[uid].MessageID != "same@example.org" {
			t.Fatalf("UID %d message ID = %q", uid, state.Messages[uid].MessageID)
		}
	}
	if state.UIDNext != 8 || state.HighestModSeq != 12 {
		t.Fatalf("cursors = UIDNEXT %d HIGHESTMODSEQ %d", state.UIDNext, state.HighestModSeq)
	}
}

func TestFetchMergeAndSnapshotBinding(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)

	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(1, 5, "m1")}); err != nil {
		t.Fatalf("first fetch: %v", err)
	}

	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(2, 6, "m2")}); !errors.Is(err, ErrStaleSnapshot) {
		t.Fatalf("stale fetch error = %v", err)
	}
	if state := mustState(t, tracker, "INBOX"); len(state.Messages) != 1 {
		t.Fatalf("stale fetch applied: %+v", state.Messages)
	}

	// A byte-equivalent repetition on a fresh snapshot is a no-op and does not
	// consume another revision.
	snapshot = mustSnapshot(t, tracker, "INBOX")
	revision := snapshot.Revision
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(1, 5, "m1")}); err != nil {
		t.Fatalf("no-op fetch: %v", err)
	}
	if got := mustState(t, tracker, "INBOX").Revision; got != revision {
		t.Fatalf("no-op fetch bumped revision from %d to %d", revision, got)
	}

	snapshot = mustSnapshot(t, tracker, "INBOX")
	update := Message{
		UID:    1,
		ModSeq: 9,
		Flags:  []string{`\Seen`, `\Flagged`},
	}
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{update}); err != nil {
		t.Fatalf("update: %v", err)
	}
	state := mustState(t, tracker, "INBOX")
	if !reflect.DeepEqual(state.Messages[1].Flags, update.Flags) {
		t.Fatalf("flags = %v", state.Messages[1].Flags)
	}
	if state.Messages[1].MessageID != "m1" || state.Messages[1].Size != 42 {
		t.Fatalf("metadata was not preserved: %+v", state.Messages[1])
	}

	// An empty non-nil flag slice clears flags, while nil inherits.
	snapshot = mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{{
		UID: 1, ModSeq: 10, Flags: []string{},
	}}); err != nil {
		t.Fatalf("clear flags: %v", err)
	}
	if flags := mustState(t, tracker, "INBOX").Messages[1].Flags; len(flags) != 0 || flags == nil {
		t.Fatalf("flags after clear = %#v", flags)
	}

	snapshot = mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{{
		UID: 1, ModSeq: 10, InternalDate: testNow.Add(time.Hour),
	}}); err != nil {
		t.Fatalf("same modseq metadata update: %v", err)
	}

	snapshot = mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{{UID: 1, ModSeq: 8}}); !errors.Is(err, ErrStaleMessage) {
		t.Fatalf("modseq regression error = %v", err)
	}
}

func TestVanishedRemovesOnlyKnownUIDs(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(1, 10, "m1"),
		simpleMessage(2, 11, "m2"),
		simpleMessage(3, 12, "m3"),
	}); err != nil {
		t.Fatalf("ApplyFetch: %v", err)
	}

	snapshot = mustSnapshot(t, tracker, "INBOX")
	revision := snapshot.Revision
	if err := tracker.ApplyVanished(ctx, snapshot, []UID{2, 99}, true); err != nil {
		t.Fatalf("ApplyVanished: %v", err)
	}
	state := mustState(t, tracker, "INBOX")
	if _, ok := state.Messages[2]; ok {
		t.Fatalf("UID 2 was not expunged: %+v", state.Messages)
	}
	if _, ok := state.Messages[1]; !ok {
		t.Fatalf("UID 1 was removed")
	}
	if _, ok := state.Messages[3]; !ok {
		t.Fatalf("UID 3 was removed")
	}
	if state.Revision != revision+1 {
		t.Fatalf("revision = %d, want %d", state.Revision, revision+1)
	}

	// Replaying a fully known-expunge is a no-op.
	snapshot = mustSnapshot(t, tracker, "INBOX")
	revision = snapshot.Revision
	if err := tracker.ApplyVanished(ctx, snapshot, []UID{2, 99}, false); err != nil {
		t.Fatalf("replay VANISHED: %v", err)
	}
	if got := mustState(t, tracker, "INBOX").Revision; got != revision {
		t.Fatalf("VANISHED replay bumped revision from %d to %d", revision, got)
	}

	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(4, 20, "m4")}); err != nil {
		t.Fatalf("advance after VANISHED: %v", err)
	}
	if err := tracker.ApplyVanished(ctx, snapshot, []UID{1}, false); !errors.Is(err, ErrStaleSnapshot) {
		t.Fatalf("stale VANISHED error = %v", err)
	}
	if _, ok := mustState(t, tracker, "INBOX").Messages[1]; !ok {
		t.Fatalf("stale VANISHED removed UID 1")
	}
}

func TestQResyncAppliesVanishAndFetch(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 100)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(1, 101, "m1"),
		simpleMessage(2, 102, "m2"),
	}); err != nil {
		t.Fatalf("ApplyFetch: %v", err)
	}

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}
	if request.Since != 102 || !reflect.DeepEqual(request.KnownUIDs, []UID{1, 2}) {
		t.Fatalf("request = %+v", request)
	}

	response := QResyncResponse{
		Vanished: []UID{1},
		Messages: []Message{
			{UID: 2, ModSeq: 110, Flags: []string{`\Deleted`}},
			{UID: 3, ModSeq: 111, MessageID: "m3"},
		},
		UIDNext:       7,
		HighestModSeq: 111,
	}
	if err := tracker.ApplyQResync(ctx, request, response); err != nil {
		t.Fatalf("ApplyQResync: %v", err)
	}

	state := mustState(t, tracker, "INBOX")
	if _, ok := state.Messages[1]; ok {
		t.Fatalf("UID 1 not VANISHED: %+v", state.Messages)
	}
	if got := state.Messages[2]; got.ModSeq != 110 || !reflect.DeepEqual(got.Flags, []string{`\Deleted`}) {
		t.Fatalf("UID 2 update = %+v", got)
	}
	if _, ok := state.Messages[3]; !ok {
		t.Fatalf("UID 3 missing: %+v", state.Messages)
	}
	if state.UIDNext != 7 || state.HighestModSeq != 111 {
		t.Fatalf("cursors = %d/%d", state.UIDNext, state.HighestModSeq)
	}

	// The same request is now stale, even though the response would be a
	// plausible replay.
	if err := tracker.ApplyQResync(ctx, request, response); !errors.Is(err, ErrStaleSnapshot) {
		t.Fatalf("replayed QRESYNC error = %v", err)
	}
}

func TestQResyncOnlyTouchesRequestSnapshot(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(1, 10, "m1"),
		simpleMessage(2, 11, "m2"),
	}); err != nil {
		t.Fatalf("ApplyFetch: %v", err)
	}

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}

	// A later commit advances the mailbox after the request snapshot.
	snapshot = mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(3, 20, "m3")}); err != nil {
		t.Fatalf("later fetch: %v", err)
	}

	before := mustState(t, tracker, "INBOX")
	err = tracker.ApplyQResync(ctx, request, QResyncResponse{Vanished: []UID{2}})
	if !errors.Is(err, ErrStaleSnapshot) {
		t.Fatalf("QRESYNC after later commit error = %v", err)
	}
	after := mustState(t, tracker, "INBOX")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("stale QRESYNC changed state\nbefore: %+v\nafter:  %+v", before, after)
	}
	if _, ok := after.Messages[2]; !ok {
		t.Fatalf("stale QRESYNC removed UID 2")
	}
}

func TestQResyncRejectsConflictsAndRegressions(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 50)

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		Vanished: []UID{4},
		Messages: []Message{{UID: 4, ModSeq: 60}},
	}); !errors.Is(err, ErrConflictingResponse) {
		t.Fatalf("VANISHED+FETCH error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		Messages: []Message{{UID: 4, ModSeq: 60}, {UID: 4, ModSeq: 61}},
	}); !errors.Is(err, ErrConflictingResponse) {
		t.Fatalf("duplicate FETCH error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		UIDNext: 4, HighestModSeq: 60,
	}); !errors.Is(err, ErrCursorRegression) {
		t.Fatalf("UIDNEXT regression error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		UIDValidity: 200, UIDNext: 5, HighestModSeq: 60,
	}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("UIDVALIDITY change error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		UIDNext: 5, HighestModSeq: 49,
	}); !errors.Is(err, ErrCursorRegression) {
		t.Fatalf("HIGHESTMODSEQ regression error = %v", err)
	}
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{
		UIDNext: 5, HighestModSeq: 60,
		Messages: []Message{{UID: 1, ModSeq: 60}},
	}); err != nil {
		t.Fatalf("valid response after rejected ones: %v", err)
	}
}

func TestQResyncEmptyResponseIsNoOp(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 50)

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}
	revision := request.Revision
	if err := tracker.ApplyQResync(ctx, request, QResyncResponse{UIDNext: 5, HighestModSeq: 50}); err != nil {
		t.Fatalf("empty QRESYNC: %v", err)
	}
	if got := mustState(t, tracker, "INBOX").Revision; got != revision {
		t.Fatalf("empty QRESYNC bumped revision from %d to %d", revision, got)
	}
}

func TestMoveCreatesDistinctRecord(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()

	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(1, 10, "shared@example.org"),
		simpleMessage(2, 11, "other@example.org"),
	}); err != nil {
		t.Fatalf("source fetch: %v", err)
	}

	mustOpen(t, tracker, "Archive", 200, 1, 0)
	snapshot = mustSnapshot(t, tracker, "Archive")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(50, 20, "shared@example.org"),
	}); err != nil {
		t.Fatalf("destination fetch: %v", err)
	}

	source := mustSnapshot(t, tracker, "INBOX")
	destination := mustSnapshot(t, tracker, "Archive")
	err := tracker.ApplyMove(ctx, source, destination, MoveRequest{
		DestinationMailbox:       "Archive",
		SourceUIDs:               []UID{1},
		DestinationUIDs:          []UID{60},
		DestinationModSeq:        30,
		DestinationHighestModSeq: 30,
	})
	if err != nil {
		t.Fatalf("ApplyMove: %v", err)
	}

	sourceState := mustState(t, tracker, "INBOX")
	if _, ok := sourceState.Messages[1]; ok {
		t.Fatalf("source UID 1 still present: %+v", sourceState.Messages)
	}
	if _, ok := sourceState.Messages[2]; !ok {
		t.Fatalf("source UID 2 disappeared")
	}

	destinationState := mustState(t, tracker, "Archive")
	if len(destinationState.Messages) != 2 {
		t.Fatalf("destination messages = %+v", destinationState.Messages)
	}
	if _, ok := destinationState.Messages[50]; !ok {
		t.Fatalf("pre-existing destination record was merged away")
	}
	moved, ok := destinationState.Messages[60]
	if !ok {
		t.Fatalf("new destination UID missing: %+v", destinationState.Messages)
	}
	if moved.MessageID != "shared@example.org" {
		t.Fatalf("move did not preserve Message-ID: %+v", moved)
	}
	if moved.MovedFrom == nil || *moved.MovedFrom != (MessageKey{
		Mailbox: "INBOX", Generation: 1, UIDValidity: 100, UID: 1,
	}) {
		t.Fatalf("MovedFrom = %+v", moved.MovedFrom)
	}
	if moved.ModSeq != 30 || destinationState.HighestModSeq != 30 ||
		destinationState.UIDNext != 61 {
		t.Fatalf("destination cursors = %+v", destinationState)
	}
	if destinationState.Messages[50].MessageID != moved.MessageID {
		t.Fatalf("test invariant broken")
	}
}

func TestMoveIsAtomicAcrossMailboxes(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()

	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(1, 10, "m1")}); err != nil {
		t.Fatalf("source fetch: %v", err)
	}
	mustOpen(t, tracker, "Archive", 200, 1, 0)
	mustSnapshot(t, tracker, "Archive")

	source := mustSnapshot(t, tracker, "INBOX")
	destination := mustSnapshot(t, tracker, "Archive")

	// Advance the destination after its snapshot was taken.
	if err := tracker.ApplyFetch(ctx, destination, []Message{simpleMessage(9, 20, "m9")}); err != nil {
		t.Fatalf("destination advance: %v", err)
	}
	beforeSource := mustState(t, tracker, "INBOX")
	beforeDestination := mustState(t, tracker, "Archive")

	err := tracker.ApplyMove(ctx, source, destination, MoveRequest{
		DestinationMailbox: "Archive",
		SourceUIDs:         []UID{1},
		DestinationUIDs:    []UID{60},
	})
	if !errors.Is(err, ErrStaleSnapshot) {
		t.Fatalf("move with stale destination error = %v", err)
	}
	if got := mustState(t, tracker, "INBOX"); !reflect.DeepEqual(beforeSource, got) {
		t.Fatalf("source changed after failed move\nbefore: %+v\nafter:  %+v", beforeSource, got)
	}
	if got := mustState(t, tracker, "Archive"); !reflect.DeepEqual(beforeDestination, got) {
		t.Fatalf("destination changed after failed move\nbefore: %+v\nafter:  %+v", beforeDestination, got)
	}
}

func TestMoveValidation(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 10, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{simpleMessage(1, 10, "m1")}); err != nil {
		t.Fatalf("source fetch: %v", err)
	}
	mustOpen(t, tracker, "Archive", 200, 10, 0)
	destination := mustSnapshot(t, tracker, "Archive")
	if err := tracker.ApplyFetch(ctx, destination, []Message{simpleMessage(40, 20, "m40")}); err != nil {
		t.Fatalf("destination fetch: %v", err)
	}

	source := mustSnapshot(t, tracker, "INBOX")
	destination = mustSnapshot(t, tracker, "Archive")

	if err := tracker.ApplyMove(ctx, source, destination, MoveRequest{
		DestinationMailbox: "Archive",
		SourceUIDs:         []UID{1, 2},
		DestinationUIDs:    []UID{60},
	}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("parallel mismatch error = %v", err)
	}
	if err := tracker.ApplyMove(ctx, source, destination, MoveRequest{
		DestinationMailbox: "Archive",
		SourceUIDs:         []UID{2},
		DestinationUIDs:    []UID{60},
	}); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("missing source error = %v", err)
	}
	if err := tracker.ApplyMove(ctx, source, destination, MoveRequest{
		DestinationMailbox: "Archive",
		SourceUIDs:         []UID{1},
		DestinationUIDs:    []UID{40},
	}); !errors.Is(err, ErrUIDConflict) {
		t.Fatalf("occupied destination UID error = %v", err)
	}
	if err := tracker.ApplyMove(ctx, source, source, MoveRequest{
		DestinationMailbox: "INBOX",
		SourceUIDs:         []UID{1},
		DestinationUIDs:    []UID{1},
	}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("same-mailbox move error = %v", err)
	}

	if _, ok := mustState(t, tracker, "INBOX").Messages[1]; !ok {
		t.Fatalf("failed validation changed source")
	}
	if _, ok := mustState(t, tracker, "Archive").Messages[40]; !ok {
		t.Fatalf("failed validation changed destination")
	}
}

func TestRecoveryPointSurvivesNewTracker(t *testing.T) {
	store := NewMemoryStore()
	first := NewTracker(store)
	ctx := context.Background()

	mustOpen(t, first, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, first, "INBOX")
	if err := first.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(1, 10, "m1"),
		simpleMessage(2, 11, "m2"),
	}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	point, err := first.RecoveryPoint(ctx, "INBOX")
	if err != nil {
		t.Fatalf("RecoveryPoint: %v", err)
	}

	second := NewTracker(store)
	opened := mustOpen(t, second, "INBOX", 100, 10, 20)
	if !reflect.DeepEqual(opened.RecoveryPoint, point) {
		t.Fatalf("recovery point after restart\ngot:  %+v\nwant: %+v", opened.RecoveryPoint, point)
	}
	request, err := second.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("restart BeginQResync: %v", err)
	}
	if request.Since != 11 || request.Revision != point.Revision {
		t.Fatalf("restart QRESYNC request = %+v", request)
	}

	if err := second.ApplyQResync(ctx, request, QResyncResponse{
		Vanished:      []UID{2},
		UIDNext:       10,
		HighestModSeq: 30,
	}); err != nil {
		t.Fatalf("restart QRESYNC apply: %v", err)
	}
	state := mustState(t, second, "INBOX")
	if _, ok := state.Messages[2]; ok {
		t.Fatalf("restart QRESYNC did not expunge UID 2")
	}
	if state.HighestModSeq != 30 || state.UIDNext != 10 {
		t.Fatalf("restart cursors = %+v", state)
	}
}

func TestConcurrentFetchesFromSameSnapshot(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")

	errs := make(chan error, 2)
	for _, message := range []Message{
		simpleMessage(1, 10, "m1"),
		simpleMessage(2, 11, "m2"),
	} {
		go func(message Message) {
			errs <- tracker.ApplyFetch(ctx, snapshot, []Message{message})
		}(message)
	}

	var succeeded, stale int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrStaleSnapshot):
			stale++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if succeeded != 1 || stale != 1 {
		t.Fatalf("succeeded=%d stale=%d", succeeded, stale)
	}
	if state := mustState(t, tracker, "INBOX"); len(state.Messages) != 1 {
		t.Fatalf("messages = %+v", state.Messages)
	}
}

func TestKnownUIDsAreSorted(t *testing.T) {
	tracker := NewTracker(NewMemoryStore())
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 1, 0)
	snapshot := mustSnapshot(t, tracker, "INBOX")
	if err := tracker.ApplyFetch(ctx, snapshot, []Message{
		simpleMessage(3, 10, "m3"),
		simpleMessage(1, 11, "m1"),
		simpleMessage(2, 12, "m2"),
	}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		t.Fatalf("BeginQResync: %v", err)
	}
	if !slices.IsSorted(request.KnownUIDs) {
		t.Fatalf("KnownUIDs not sorted: %v", request.KnownUIDs)
	}
}
