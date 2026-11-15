package dataeng

import (
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
)

func ts(seconds, increment uint32) Timestamp {
	return Timestamp{T: seconds, I: increment}
}

func event(shard, token string, at Timestamp, key, operation string) Event {
	return Event{
		ShardID:       shard,
		ResumeToken:   token,
		ClusterTime:   at,
		DocumentKey:   key,
		OperationType: operation,
	}
}

func tokens(events []Event) []string {
	out := make([]string, len(events))
	for i, event := range events {
		out[i] = event.ResumeToken
	}
	return out
}

func TestMergeOrdersByClusterTimeShardAndTransaction(t *testing.T) {
	merger := NewMerger("s1", "s2")
	txn := &Transaction{LSID: "session-a", Number: 7, OpIndex: 2}
	events := []Event{
		event("s2", "s2-t3", ts(10, 1), "doc-c", "update"),
		event("s1", "s1-t3", ts(10, 1), "doc-b", "update"),
		{ShardID: "s2", ResumeToken: "s2-txn", ClusterTime: ts(10, 0), DocumentKey: "doc-a", OperationType: "insert", Transaction: txn},
		event("s1", "s1-t1", ts(9, 2), "doc-a", "update"),
		event("s2", "s2-t2", ts(10, 0), "doc-z", "update"),
	}

	result, err := merger.PushBatch(events)
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	want := []string{"s1-t1", "s2-t2", "s2-txn", "s1-t3", "s2-t3"}
	if got := tokens(result.Events); !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	for i, emitted := range result.Events {
		if emitted.Sequence != uint64(i+1) {
			t.Fatalf("event %d sequence = %d, want %d", i, emitted.Sequence, i+1)
		}
		if emitted.Generation != 0 {
			t.Fatalf("event %d generation = %d, want 0", i, emitted.Generation)
		}
	}
	if got := merger.Watermark(); got != ts(10, 1) {
		t.Fatalf("watermark = %v, want 10:1", got)
	}
	if got := merger.Sequence(); got != 5 {
		t.Fatalf("sequence = %d, want 5", got)
	}
}

func TestWatermarkStopsAtSlowestActiveShard(t *testing.T) {
	merger := NewMerger("fast", "slow")
	result, err := merger.PushBatch([]Event{
		event("fast", "fast-5", ts(5, 0), "doc-a", "update"),
		event("slow", "slow-2", ts(2, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if got := tokens(result.Events); !reflect.DeepEqual(got, []string{"slow-2"}) {
		t.Fatalf("safe events = %v, want only slow-2", got)
	}
	if got := merger.Watermark(); got != ts(2, 0) {
		t.Fatalf("watermark = %v, want 2:0", got)
	}

	flushed := merger.Flush()
	if got := tokens(flushed.Events); !reflect.DeepEqual(got, []string{"fast-5"}) {
		t.Fatalf("flushed events = %v, want fast-5", got)
	}
	if got := merger.Watermark(); got != ts(2, 0) {
		t.Fatalf("flush advanced watermark past slow shard: %v", got)
	}

	merger.RemoveShard("slow")
	if got := merger.Watermark(); got != ts(5, 0) {
		t.Fatalf("watermark after removing slow shard = %v, want 5:0", got)
	}
}

func TestCheckpointRecordsFlushedEventsAheadOfWatermark(t *testing.T) {
	merger := NewMerger("fast", "slow")
	if _, err := merger.PushBatch([]Event{
		event("fast", "fast-5", ts(5, 0), "doc-a", "update"),
		event("slow", "slow-2", ts(2, 0), "doc-b", "update"),
	}); err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if flushed := merger.Flush(); len(flushed.Events) != 1 {
		t.Fatalf("flushed events = %v", tokens(flushed.Events))
	}

	checkpoint := merger.Checkpoint()
	if checkpoint.Watermark != ts(2, 0) {
		t.Fatalf("watermark = %v, want 2:0", checkpoint.Watermark)
	}
	if got := checkpoint.Shards["fast"]; got.Token != "fast-5" || got.ClusterTime != ts(5, 0) {
		t.Fatalf("fast checkpoint = %+v", got)
	}
}

func TestCheckpointDoesNotPersistUndealtTiePrefix(t *testing.T) {
	merger := NewMergerWithOptions(MergerOptions{Shards: []string{"s1", "s2"}, HoldTies: true})
	result, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if len(result.Events) != 0 {
		t.Fatalf("tie events emitted early: %v", tokens(result.Events))
	}
	if got := merger.Watermark(); got != ts(1, 0) {
		t.Fatalf("in-memory watermark = %v, want 1:0", got)
	}

	checkpoint := merger.Checkpoint()
	if !checkpoint.Watermark.IsZero() {
		t.Fatalf("durable watermark = %v, want zero while ties are pending", checkpoint.Watermark)
	}
	resumed := ResumeMerger(checkpoint, MergerOptions{HoldTies: true})
	replayed, err := resumed.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("resumed PushBatch: %v", err)
	}
	if replayed.Late != 0 {
		t.Fatalf("replayed tie events classified as late: %+v", replayed)
	}
}

func TestMigrationDuplicatesUseDocumentKeyAndTransactionEvidence(t *testing.T) {
	merger := NewMerger("source", "destination")
	result, err := merger.PushBatch([]Event{
		event("source", "source-1", ts(1, 0), "doc-1", "update"),
		event("destination", "destination-1", ts(1, 0), "doc-1", "update"),
		event("source", "source-2", ts(2, 0), "doc-1", "delete"),
		event("destination", "destination-2", ts(2, 0), "doc-1", "update"),
		{
			ShardID: "source", ResumeToken: "source-3", ClusterTime: ts(3, 0),
			DocumentKey: "doc-2", OperationType: "update",
			Transaction: &Transaction{LSID: "lsid", Number: 4, OpIndex: 1},
		},
		{
			ShardID: "destination", ResumeToken: "destination-3", ClusterTime: ts(3, 0),
			DocumentKey: "doc-2", OperationType: "update",
			Transaction: &Transaction{LSID: "lsid", Number: 4, OpIndex: 1},
		},
		{
			ShardID: "source", ResumeToken: "source-4", ClusterTime: ts(3, 0),
			DocumentKey: "doc-2", OperationType: "update",
			Transaction: &Transaction{LSID: "lsid", Number: 4, OpIndex: 2},
		},
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	want := []string{"source-1", "destination-2", "source-2", "source-3", "source-4"}
	if got := tokens(result.Events); !reflect.DeepEqual(got, want) {
		t.Fatalf("deduplicated events = %v, want %v", got, want)
	}
	if result.Duplicates != 2 {
		t.Fatalf("duplicates = %d, want 2", result.Duplicates)
	}
}

func TestTransactionEvidenceOutweighsClusterTime(t *testing.T) {
	merger := NewMerger("s1", "s2")
	txn := &Transaction{LSID: "session", Number: 9, OpIndex: 3}
	result, err := merger.PushBatch([]Event{
		{
			ShardID: "s1", ResumeToken: "token-a", ClusterTime: ts(4, 0),
			DocumentKey: "doc", OperationType: "update", Transaction: txn,
		},
		{
			ShardID: "s2", ResumeToken: "token-b", ClusterTime: ts(4, 1),
			DocumentKey: "doc", OperationType: "update", Transaction: txn,
		},
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if len(result.Events) != 1 || result.Duplicates != 1 {
		t.Fatalf("transaction replay result = %+v", result)
	}
}

func TestReplayedTokenIsAcknowledgedWithoutReemission(t *testing.T) {
	merger := NewMerger("s1")
	original := event("s1", "token-1", ts(1, 0), "doc-1", "insert")
	first, err := merger.Push(original)
	if err != nil || len(first) != 1 {
		t.Fatalf("first push = %v, %v", first, err)
	}

	result, err := merger.Accept(original)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(result.Events) != 0 || result.Duplicates != 1 {
		t.Fatalf("replay result = %+v", result)
	}
	if got := merger.Watermark(); got != ts(1, 0) {
		t.Fatalf("watermark = %v, want 1:0", got)
	}
}

func TestInvalidateClosesGeneration(t *testing.T) {
	merger := NewMerger("s1", "s2")
	result, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	})
	if err != nil || len(result.Events) != 2 {
		t.Fatalf("initial batch = %+v, %v", result, err)
	}

	closed, err := merger.Accept(Event{
		ShardID: "s1", ResumeToken: "s1-invalidate", ClusterTime: ts(2, 0),
		Database: "db", Collection: "coll", Invalidate: true,
	})
	if err != nil {
		t.Fatalf("invalidate: %v", err)
	}
	if !closed.Invalidated || closed.ClosedGeneration != 0 {
		t.Fatalf("invalidate result = %+v", closed)
	}
	if len(closed.Events) != 1 || !closed.Events[0].Invalidate {
		t.Fatalf("invalidate events = %+v", closed.Events)
	}
	if got := merger.Generation(); got != 1 {
		t.Fatalf("generation = %d, want 1", got)
	}
	if got := merger.Watermark(); got != ts(1, 0) {
		t.Fatalf("watermark after invalidate = %v, want 1:0", got)
	}

	duplicate, err := merger.Accept(Event{
		ShardID: "s2", ResumeToken: "s2-invalidate", ClusterTime: ts(2, 0),
		Database: "db", Collection: "coll", Invalidate: true,
	})
	if err != nil || duplicate.Stale != 1 || len(duplicate.Events) != 0 {
		t.Fatalf("duplicate invalidate = %+v, %v", duplicate, err)
	}
	duplicate, err = merger.Accept(Event{
		ShardID: "s1", ResumeToken: "s1-invalidate-late", ClusterTime: ts(2, 5),
		Database: "db", Collection: "coll", Invalidate: true,
	})
	if err != nil || duplicate.Stale != 1 || len(duplicate.Events) != 0 {
		t.Fatalf("late duplicate invalidate = %+v, %v", duplicate, err)
	}

	old, err := merger.Accept(event("s1", "old-generation", ts(1, 5), "doc-a", "update"))
	if err != nil || old.Stale != 1 || len(old.Events) != 0 {
		t.Fatalf("old generation event = %+v, %v", old, err)
	}

	newEvent := event("s1", "s1-new", ts(3, 0), "doc-a", "insert")
	newEvent.Database = "db"
	newEvent.Collection = "coll"
	accepted, err := merger.Accept(newEvent)
	if err != nil || accepted.Stale != 0 {
		t.Fatalf("new generation event = %+v, %v", accepted, err)
	}
	if got := merger.Generation(); got != 1 {
		t.Fatalf("generation after new event = %d, want 1", got)
	}
	if got := merger.Sequence(); got != 3 {
		t.Fatalf("sequence before new generation is safe = %d, want 3", got)
	}
	flushed := merger.Flush()
	if len(flushed.Events) != 1 || flushed.Events[0].Sequence != 4 {
		t.Fatalf("new generation flush = %+v", flushed.Events)
	}
}

func TestIncompleteGenerationDrainsBeforeInvalidate(t *testing.T) {
	merger := NewMerger("s1", "s2")
	result, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		{ShardID: "s2", ResumeToken: "s2-invalidate", ClusterTime: ts(2, 0), Invalidate: true},
		event("s1", "s1-after", ts(3, 0), "doc-a", "update"),
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	want := []string{"s1-1", "s2-invalidate"}
	if got := tokens(result.Events); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if got := merger.Pending(); got != 1 {
		t.Fatalf("pending = %d, want new-generation event buffered", got)
	}
}

func TestCheckpointPreservesInvalidateBoundary(t *testing.T) {
	merger := NewMerger("s1", "s2")
	if _, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	}); err != nil {
		t.Fatalf("initial PushBatch: %v", err)
	}
	if _, err := merger.Accept(Event{
		ShardID: "s1", ResumeToken: "invalidate", ClusterTime: ts(2, 0),
		Database: "db", Collection: "coll", Invalidate: true,
	}); err != nil {
		t.Fatalf("invalidate: %v", err)
	}

	checkpoint := merger.Checkpoint()
	if checkpoint.Invalidate == nil || checkpoint.Invalidate.ClusterTime != ts(2, 0) {
		t.Fatalf("checkpoint boundary = %+v", checkpoint.Invalidate)
	}
	resumed := ResumeMerger(checkpoint, MergerOptions{})
	old := event("s2", "old-after-restart", ts(1, 5), "doc-b", "update")
	old.Database = "db"
	old.Collection = "coll"
	result, err := resumed.Accept(old)
	if err != nil || result.Stale != 1 || len(result.Events) != 0 {
		t.Fatalf("old event after restart = %+v, %v", result, err)
	}

	newEvent := event("s1", "new-generation-data", ts(3, 0), "doc-a", "insert")
	newEvent.Database = "db"
	newEvent.Collection = "coll"
	if _, err := resumed.Accept(newEvent); err != nil {
		t.Fatalf("new generation event: %v", err)
	}
	nextInvalidate, err := resumed.Accept(Event{
		ShardID: "s1", ResumeToken: "invalidate-2", ClusterTime: ts(4, 0),
		Database: "db", Collection: "coll", Invalidate: true,
	})
	if err != nil || !nextInvalidate.Invalidated || nextInvalidate.ClosedGeneration != 1 {
		t.Fatalf("second invalidate = %+v, %v", nextInvalidate, err)
	}
}

func TestInvalidateOperationTypeIsRecognized(t *testing.T) {
	merger := NewMerger("s1")
	result, err := merger.Accept(Event{
		ShardID:       "s1",
		ResumeToken:   "invalidate-token",
		ClusterTime:   ts(4, 0),
		OperationType: "invalidate",
	})
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if !result.Invalidated || result.Generation != 1 || len(result.Events) != 1 {
		t.Fatalf("invalidate result = %+v", result)
	}
}

func TestCheckpointAndResumeContinueSequence(t *testing.T) {
	merger := NewMerger("s1", "s2")
	if _, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	}); err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	checkpoint := merger.Checkpoint()
	if checkpoint.Watermark != ts(1, 0) || checkpoint.Sequence != 2 {
		t.Fatalf("checkpoint = %+v", checkpoint)
	}
	if checkpoint.Shards["s1"].Token != "s1-1" || checkpoint.Shards["s2"].Token != "s2-1" {
		t.Fatalf("shard checkpoint = %+v", checkpoint.Shards)
	}

	resumed := ResumeMerger(checkpoint, MergerOptions{})
	if got := resumed.Generation(); got != checkpoint.Generation {
		t.Fatalf("generation = %d, want %d", got, checkpoint.Generation)
	}
	replayed, err := resumed.Accept(event("s1", "s1-1", ts(1, 0), "doc-a", "update"))
	if err != nil || replayed.Duplicates != 1 || len(replayed.Events) != 0 {
		t.Fatalf("checkpoint token replay = %+v, %v", replayed, err)
	}

	result, err := resumed.PushBatch([]Event{
		event("s1", "s1-2", ts(2, 0), "doc-a", "update"),
		event("s2", "s2-2", ts(2, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("resumed PushBatch: %v", err)
	}
	if got := result.Events[0].Sequence; got != 3 {
		t.Fatalf("first resumed sequence = %d, want 3", got)
	}
}

func TestHoldTiesWaitsForStrictlyLaterFrontier(t *testing.T) {
	merger := NewMergerWithOptions(MergerOptions{Shards: []string{"s1", "s2"}, HoldTies: true})
	result, err := merger.PushBatch([]Event{
		event("s1", "s1-1", ts(1, 0), "doc-a", "update"),
		event("s2", "s2-1", ts(1, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if len(result.Events) != 0 {
		t.Fatalf("tie group emitted early: %v", tokens(result.Events))
	}
	if got := merger.Watermark(); got != ts(1, 0) {
		t.Fatalf("watermark = %v, want 1:0", got)
	}

	result, err = merger.PushBatch([]Event{
		event("s1", "s1-2", ts(2, 0), "doc-a", "update"),
	})
	if err != nil || len(result.Events) != 0 {
		t.Fatalf("one shard advanced: %+v, %v", result, err)
	}
	result, err = merger.PushBatch([]Event{
		event("s2", "s2-2", ts(2, 0), "doc-b", "update"),
	})
	if err != nil {
		t.Fatalf("PushBatch: %v", err)
	}
	if got := tokens(result.Events); !reflect.DeepEqual(got, []string{"s1-1", "s2-1"}) {
		t.Fatalf("released tie group = %v", got)
	}
}

func TestMergeBatchConvenienceFunction(t *testing.T) {
	merged, err := Merge([]Event{
		event("s2", "b", ts(2, 0), "doc-b", "update"),
		event("s1", "a", ts(1, 0), "doc-a", "update"),
	}, "s1", "s2")
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if got := tokens(merged); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("merged = %v", got)
	}
}

func TestConcurrentPushes(t *testing.T) {
	merger := NewMerger("s1", "s2")
	var wg sync.WaitGroup
	var mu sync.Mutex
	var emitted []Event
	errs := make(chan error, 2)

	for _, shard := range []string{"s1", "s2"} {
		wg.Add(1)
		go func(shard string) {
			defer wg.Done()
			for i := uint32(1); i <= 50; i++ {
				events, err := merger.Push(event(shard, shard+"-"+string(rune('A'+i%26))+"-"+string(rune('0'+i%10)), ts(i/2+1, i), "doc-"+shard+"-"+string(rune('0'+i%10)), "update"))
				if err != nil {
					errs <- err
					return
				}
				mu.Lock()
				emitted = append(emitted, events...)
				mu.Unlock()
			}
		}(shard)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Push: %v", err)
	}

	flushed := merger.Flush()
	emitted = append(emitted, flushed.Events...)
	if len(emitted) != 100 {
		t.Fatalf("emitted = %d, want 100", len(emitted))
	}
	seen := make([]bool, len(emitted)+1)
	for _, event := range emitted {
		if event.Sequence == 0 || event.Sequence > uint64(len(emitted)) || seen[event.Sequence] {
			t.Fatalf("invalid or duplicate sequence %d", event.Sequence)
		}
		seen[event.Sequence] = true
	}
}

func TestUnknownShardAndShardManagement(t *testing.T) {
	merger := NewMerger("s1")
	if _, err := merger.Push(event("s2", "s2-1", ts(1, 0), "doc", "update")); !errors.Is(err, ErrUnknownShard) {
		t.Fatalf("unknown shard error = %v", err)
	}
	if err := merger.AddShardAt("s2", ts(1, 0)); err != nil {
		t.Fatalf("AddShardAt: %v", err)
	}
	if _, err := merger.Push(event("s1", "s1-1", ts(1, 0), "doc", "update")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := merger.AddShardAt("s3", ts(0, 5)); !errors.Is(err, ErrBehindWatermark) {
		t.Fatalf("behind watermark error = %v", err)
	}
	if got := merger.ActiveShards(); !reflect.DeepEqual(got, []string{"s1", "s2"}) {
		t.Fatalf("active shards = %v", got)
	}
}

func TestTimestampJSONForms(t *testing.T) {
	cases := []struct {
		input string
		want  Timestamp
	}{
		{`{"t":7,"i":9}`, ts(7, 9)},
		{`{"$timestamp":{"t":8,"i":1}}`, ts(8, 1)},
		{`30064771073`, ts(7, 1)},
	}
	for _, test := range cases {
		var got Timestamp
		if err := json.Unmarshal([]byte(test.input), &got); err != nil {
			t.Fatalf("unmarshal %s: %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("unmarshal %s = %v, want %v", test.input, got, test.want)
		}
	}
}
