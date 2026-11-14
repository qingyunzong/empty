package dataeng

import (
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
)

func TestIndividualAckLeavesOtherIndexesPending(t *testing.T) {
	tracker := NewTracker("events", "ingest")
	batch := BatchID{LedgerID: 7, EntryID: 3, Count: 4}

	if err := tracker.AckIndividual(batch.Message(1)); err != nil {
		t.Fatalf("AckIndividual: %v", err)
	}

	status := tracker.ScanBatch(batch)
	if status.Err != nil {
		t.Fatalf("ScanBatch: %v", status.Err)
	}
	if want := []int32{1}; !reflect.DeepEqual(status.Acknowledged, want) {
		t.Fatalf("acknowledged = %v, want %v", status.Acknowledged, want)
	}
	if want := []int32{0, 2, 3}; !reflect.DeepEqual(status.Unacknowledged, want) {
		t.Fatalf("unacknowledged = %v, want %v", status.Unacknowledged, want)
	}
	if want := []int32{0, 2, 3}; !reflect.DeepEqual(status.ToPublish, want) {
		t.Fatalf("to publish = %v, want %v", status.ToPublish, want)
	}
	if len(status.ToAck) != 0 {
		t.Fatalf("to ack = %v, want none", status.ToAck)
	}
}

func TestCumulativeAckCoversLedgerEntryAndBatchIndex(t *testing.T) {
	tracker := NewTracker()

	if err := tracker.AckCumulative(MessageID{LedgerID: 2, EntryID: 5, BatchIndex: 2}); err != nil {
		t.Fatalf("AckCumulative: %v", err)
	}

	for _, id := range []MessageID{
		{LedgerID: 1, EntryID: 99, BatchIndex: 100},
		{LedgerID: 2, EntryID: 4, BatchIndex: 100},
		{LedgerID: 2, EntryID: 5, BatchIndex: -1},
		{LedgerID: 2, EntryID: 5, BatchIndex: 0},
		{LedgerID: 2, EntryID: 5, BatchIndex: 2},
	} {
		if !tracker.IsAcked(id) {
			t.Errorf("%v should be acknowledged", id)
		}
	}
	for _, id := range []MessageID{
		{LedgerID: 2, EntryID: 5, BatchIndex: 3},
		{LedgerID: 2, EntryID: 6, BatchIndex: -1},
		{LedgerID: 3, EntryID: 0, BatchIndex: -1},
	} {
		if tracker.IsAcked(id) {
			t.Errorf("%v should not be acknowledged", id)
		}
	}
}

func TestOlderCumulativeAckDoesNotRegressWatermark(t *testing.T) {
	tracker := NewTracker()
	high := MessageID{LedgerID: 4, EntryID: 2, BatchIndex: 5}
	if err := tracker.AckCumulative(high); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckCumulative(MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}); err != nil {
		t.Fatal(err)
	}
	watermark, ok := tracker.CumulativeAck()
	if !ok || watermark != high {
		t.Fatalf("watermark = %v, %v; want %v, true", watermark, ok, high)
	}
}

func TestRedeliveryPublishesOnlyUncommittedIndexes(t *testing.T) {
	tracker := NewTracker("events", "ingest")
	batch := BatchID{LedgerID: 9, EntryID: 1, Count: 4}

	// Index 0 and 2 completed. Index 1 failed and index 2 was committed but
	// its ack did not reach the broker. Index 3 was never processed.
	if err := tracker.MarkPublished(batch.Message(0), batch.Message(2)); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(batch.Message(0)); err != nil {
		t.Fatal(err)
	}

	status := tracker.ScanBatch(batch)
	if want := []int32{1, 3}; !reflect.DeepEqual(status.ToPublish, want) {
		t.Fatalf("to publish = %v, want %v", status.ToPublish, want)
	}
	if want := []int32{2}; !reflect.DeepEqual(status.ToAck, want) {
		t.Fatalf("to ack = %v, want %v", status.ToAck, want)
	}
	if want := []int32{1, 2, 3}; !reflect.DeepEqual(status.Pending(), want) {
		t.Fatalf("pending = %v, want %v", status.Pending(), want)
	}
	if tracker.ShouldProcess(batch.Message(2)) {
		t.Fatal("committed index 2 must not be published again")
	}
	if got := tracker.Classify(batch.Message(2)); got != NeedsAckOnly {
		t.Fatalf("disposition = %v, want %v", got, NeedsAckOnly)
	}
	if got := tracker.Classify(batch.Message(0)); got != AlreadyComplete {
		t.Fatalf("disposition = %v, want %v", got, AlreadyComplete)
	}
}

func TestSingleFailureRetriesOnlyUnacknowledgedIndex(t *testing.T) {
	tracker := NewTracker()
	batch := BatchID{LedgerID: 3, EntryID: 8, Count: 4}

	for i := 0; i < batch.Count; i++ {
		index := int32(i)
		if index == 1 {
			continue
		}
		id := batch.Message(index)
		if err := tracker.MarkPublished(id); err != nil {
			t.Fatal(err)
		}
		if err := tracker.AckIndividual(id); err != nil {
			t.Fatal(err)
		}
	}

	// On redelivery only the failed index is published again; the ack-only
	// committed indexes are not re-published.
	status := tracker.ScanBatch(batch)
	if want := []int32{1}; !reflect.DeepEqual(status.ToPublish, want) {
		t.Fatalf("to publish = %v, want %v", status.ToPublish, want)
	}
	if want := []int32{1}; !reflect.DeepEqual(status.Unacknowledged, want) {
		t.Fatalf("unacknowledged = %v, want %v", status.Unacknowledged, want)
	}
}

func TestTopicUnloadInvalidatesAcksButKeepsCommitLedger(t *testing.T) {
	tracker := NewTracker("events", "ingest")
	first := MessageID{LedgerID: 4, EntryID: 1, BatchIndex: 0}
	second := MessageID{LedgerID: 4, EntryID: 1, BatchIndex: 1}
	oldToken := tracker.Token()

	if err := tracker.MarkPublished(first); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(first); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(second); err != nil {
		t.Fatal(err)
	}

	tracker.OnTopicUnload()

	if tracker.IsAcked(first) || tracker.IsAcked(second) {
		t.Fatal("topic unload must invalidate old acknowledgements")
	}
	if !tracker.IsPublished(first) {
		t.Fatal("committed output must survive a topic unload")
	}
	if tracker.IsPublished(second) {
		t.Fatal("uncommitted output must stay uncommitted")
	}
	if got := tracker.Classify(first); got != NeedsAckOnly {
		t.Fatalf("first disposition = %v, want %v", got, NeedsAckOnly)
	}
	if got := tracker.Classify(second); got != NeedsProcessing {
		t.Fatalf("second disposition = %v, want %v", got, NeedsProcessing)
	}

	err := tracker.AckAt(oldToken, first, AckIndividual)
	if !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack error = %v, want ErrStaleGeneration", err)
	}
	if tracker.IsAcked(first) {
		t.Fatal("stale acknowledgement was applied")
	}
}

func TestSubscriptionGenerationChangeInvalidatesAcks(t *testing.T) {
	tracker := NewTracker("events", "ingest")
	id := MessageID{LedgerID: 1, EntryID: 2, BatchIndex: 3}
	oldToken := tracker.Token()

	if err := tracker.MarkPublished(id); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(id); err != nil {
		t.Fatal(err)
	}
	newToken := tracker.AdvanceSubscriptionGeneration()
	if newToken.SubscriptionGeneration == oldToken.SubscriptionGeneration {
		t.Fatal("subscription generation did not advance")
	}
	if tracker.IsAcked(id) {
		t.Fatal("subscription generation change must invalidate old acks")
	}
	if !tracker.IsPublished(id) {
		t.Fatal("subscription generation change must retain committed output")
	}
	if err := tracker.AckIndividualAt(oldToken, id); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack error = %v, want ErrStaleGeneration", err)
	}
	if err := tracker.AckIndividualAt(newToken, id); err != nil {
		t.Fatalf("current ack failed: %v", err)
	}
	if !tracker.IsAcked(id) {
		t.Fatal("current-generation ack was not applied")
	}
}

func TestAckAcceptsOptionalGenerationToken(t *testing.T) {
	tracker := NewTracker()
	id := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}
	oldToken := tracker.Token()
	tracker.OnTopicUnload()
	if err := tracker.AckIndividual(id, oldToken); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack error = %v, want ErrStaleGeneration", err)
	}
	if err := tracker.AckIndividual(id, tracker.Token()); err != nil {
		t.Fatalf("current ack error = %v", err)
	}
}

func TestUnchangedGenerationDoesNotClearState(t *testing.T) {
	tracker := NewTrackerWithOptions(Options{Topic: "t", Subscription: "s", SubscriptionGeneration: 5})
	id := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}
	if err := tracker.AckIndividual(id); err != nil {
		t.Fatal(err)
	}

	tracker.OnSubscriptionGeneration(5)
	if !tracker.IsAcked(id) {
		t.Fatal("same generation must not clear acknowledgements")
	}
}

func TestGenerationNeverMovesBackwards(t *testing.T) {
	tracker := NewTrackerWithOptions(Options{
		TopicGeneration:        8,
		SubscriptionGeneration: 8,
	})
	id := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}
	if err := tracker.AckIndividual(id); err != nil {
		t.Fatal(err)
	}

	tracker.OnTopicGeneration(3)
	tracker.OnSubscriptionGeneration(2)
	if tok := tracker.Token(); tok.TopicGeneration != 8 || tok.SubscriptionGeneration != 8 {
		t.Fatalf("generation moved backwards: %+v", tok)
	}
	if !tracker.IsAcked(id) {
		t.Fatal("stale lower-generation event cleared current state")
	}

	tracker.OnTopicUnload(2)
	if tok := tracker.Token(); tok.TopicGeneration != 8 {
		t.Fatalf("unload moved generation backwards: %+v", tok)
	}
	if !tracker.IsAcked(id) {
		t.Fatal("stale unload notification cleared current state")
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	tracker := NewTrackerWithOptions(Options{
		Topic:                  "events",
		Subscription:           "ingest",
		TopicGeneration:        3,
		SubscriptionGeneration: 11,
	})
	batch := BatchID{LedgerID: 10, EntryID: 20, Count: 6}
	if err := tracker.AckCumulative(batch.Message(2)); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(batch.Message(5)); err != nil {
		t.Fatal(err)
	}
	if err := tracker.MarkPublished(batch.Message(0), batch.Message(1), batch.Message(2), batch.Message(4)); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(MessageID{LedgerID: 10, EntryID: 19, BatchIndex: -1}); err != nil {
		t.Fatal(err)
	}

	before := tracker.Snapshot()
	encoded, err := tracker.MarshalBinary()
	if err != nil {
		t.Fatalf("MarshalBinary: %v", err)
	}
	restored, err := Restore(encoded)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	after := restored.Snapshot()
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("snapshot mismatch:\nbefore: %#v\nafter:  %#v", before, after)
	}

	// The wire representation must also be stable after a round trip.
	encodedAgain, err := restored.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(encodedAgain) {
		t.Fatalf("serialization is not stable:\n%s\n%s", encoded, encodedAgain)
	}

	if status := restored.ScanBatch(batch); !reflect.DeepEqual(status.Acknowledged, []int32{0, 1, 2, 5}) {
		t.Fatalf("restored acknowledged = %v", status.Acknowledged)
	}
	if !restored.IsPublished(batch.Message(4)) {
		t.Fatal("published state was not restored")
	}
	if restored.Token() != tracker.Token() {
		t.Fatalf("token = %+v, want %+v", restored.Token(), tracker.Token())
	}
}

func TestJSONRoundTripAndDeepCopy(t *testing.T) {
	tracker := NewTracker("events", "ingest")
	id := MessageID{LedgerID: 1, EntryID: 2, BatchIndex: 3}
	if err := tracker.MarkPublished(id); err != nil {
		t.Fatal(err)
	}
	if err := tracker.AckIndividual(id); err != nil {
		t.Fatal(err)
	}

	data, err := json.Marshal(tracker)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var restored Tracker
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if !restored.IsAcked(id) || !restored.IsPublished(id) {
		t.Fatal("JSON round trip lost state")
	}

	other := NewTracker("events", "ingest")
	if err := other.UnmarshalBinary(data); err != nil {
		t.Fatalf("UnmarshalBinary: %v", err)
	}
	if !other.IsAcked(id) {
		t.Fatal("binary restore lost state")
	}

	// Mutating the original must not affect the restored tracker.
	if err := tracker.AckIndividual(MessageID{LedgerID: 1, EntryID: 2, BatchIndex: 4}); err != nil {
		t.Fatal(err)
	}
	if other.IsAcked(MessageID{LedgerID: 1, EntryID: 2, BatchIndex: 4}) {
		t.Fatal("restored tracker shares mutable state with the original")
	}
}

func TestRestoreScopeMismatchLeavesStateUntouched(t *testing.T) {
	source := NewTracker("topic-a", "sub-a")
	id := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}
	if err := source.AckIndividual(id); err != nil {
		t.Fatal(err)
	}

	target := NewTracker("topic-b", "sub-b")
	if err := target.Restore(source.Snapshot()); !errors.Is(err, ErrScopeMismatch) {
		t.Fatalf("Restore error = %v, want ErrScopeMismatch", err)
	}
	if target.IsAcked(id) {
		t.Fatal("failed restore modified the target")
	}
}

func TestInvalidMessageAndStateAreRejected(t *testing.T) {
	tracker := NewTracker()
	bad := []MessageID{
		{LedgerID: -1, EntryID: 0, BatchIndex: 0},
		{LedgerID: 0, EntryID: -1, BatchIndex: 0},
		{LedgerID: 0, EntryID: 0, BatchIndex: -2},
	}
	for _, id := range bad {
		if err := tracker.AckIndividual(id); !errors.Is(err, ErrInvalidMessageID) {
			t.Errorf("AckIndividual(%v) error = %v", id, err)
		}
		if err := tracker.MarkPublished(id); !errors.Is(err, ErrInvalidMessageID) {
			t.Errorf("MarkPublished(%v) error = %v", id, err)
		}
	}

	if err := tracker.Ack(MessageID{}, AckType(42)); !errors.Is(err, ErrInvalidAckType) {
		t.Fatalf("invalid ack type error = %v", err)
	}

	badState := Snapshot{
		Version:       StateVersion + 1,
		CumulativeAck: &MessageID{LedgerID: 0, EntryID: 0, BatchIndex: 0},
	}
	if _, err := NewFromSnapshot(badState); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("unsupported state error = %v", err)
	}
	negativeIndex := Snapshot{
		Version: StateVersion,
		Acked:   []EntryIndexes{{LedgerID: 0, EntryID: 0, Indexes: []int32{-2}}},
	}
	if _, err := NewFromSnapshot(negativeIndex); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("invalid index state error = %v", err)
	}
}

func TestZeroValueTrackerAndClone(t *testing.T) {
	var tracker Tracker
	id := MessageID{LedgerID: 2, EntryID: 2, BatchIndex: 2}
	if err := tracker.AckIndividual(id); err != nil {
		t.Fatal(err)
	}
	if !tracker.IsAcked(id) {
		t.Fatal("zero-value tracker did not store ack")
	}

	clone := tracker.Clone()
	if !clone.IsAcked(id) {
		t.Fatal("clone lost state")
	}
	if err := tracker.AckIndividual(MessageID{LedgerID: 2, EntryID: 2, BatchIndex: 3}); err != nil {
		t.Fatal(err)
	}
	if clone.IsAcked(MessageID{LedgerID: 2, EntryID: 2, BatchIndex: 3}) {
		t.Fatal("clone shares state with original")
	}
}

func TestAckBatchAndPendingHelpers(t *testing.T) {
	tracker := NewTracker()
	batch := BatchID{LedgerID: 5, EntryID: 5, Count: 3}
	if err := tracker.AckBatch(batch); err != nil {
		t.Fatal(err)
	}
	if got := tracker.PendingIndices(batch.LedgerID, batch.EntryID, batch.Count); len(got) != 0 {
		t.Fatalf("pending = %v, want none", got)
	}
	if !tracker.BatchStatus(batch).Complete() {
		t.Fatal("batch should be complete")
	}
	if got := tracker.PendingMessages(batch.LedgerID, batch.EntryID, batch.Count); len(got) != 0 {
		t.Fatalf("pending messages = %v, want none", got)
	}
}

func TestPrunePublishedThrough(t *testing.T) {
	tracker := NewTracker()
	first := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 0}
	second := MessageID{LedgerID: 1, EntryID: 1, BatchIndex: 1}
	third := MessageID{LedgerID: 1, EntryID: 2, BatchIndex: 0}
	for _, id := range []MessageID{first, second, third} {
		if err := tracker.MarkPublished(id); err != nil {
			t.Fatal(err)
		}
	}
	if err := tracker.PrunePublishedThrough(second); err != nil {
		t.Fatal(err)
	}
	if tracker.IsPublished(first) || tracker.IsPublished(second) {
		t.Fatal("pruned commits are still present")
	}
	if !tracker.IsPublished(third) {
		t.Fatal("commit after prune watermark was removed")
	}
}

func TestConcurrentAcksAndCommits(t *testing.T) {
	tracker := NewTracker()
	batch := BatchID{LedgerID: 8, EntryID: 8, Count: 128}
	var wg sync.WaitGroup
	for index := 0; index < batch.Count; index++ {
		index := int32(index)
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := batch.Message(index)
			if err := tracker.MarkPublished(id); err != nil {
				t.Errorf("MarkPublished: %v", err)
			}
			if err := tracker.AckIndividual(id); err != nil {
				t.Errorf("AckIndividual: %v", err)
			}
		}()
	}
	wg.Wait()
	status := tracker.ScanBatch(batch)
	if !status.Complete() {
		t.Fatalf("batch incomplete: %+v", status)
	}
	if len(status.Acknowledged) != batch.Count {
		t.Fatalf("acknowledged %d indexes, want %d", len(status.Acknowledged), batch.Count)
	}
}
