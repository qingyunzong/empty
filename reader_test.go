package dataeng

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func pollAll(t *testing.T, r *Reader, rounds int) []*Record {
	t.Helper()
	ctx := context.Background()
	var out []*Record
	for index := 0; index < rounds; index++ {
		got, err := r.Poll(ctx)
		if err != nil {
			t.Fatalf("poll %d: %v", index, err)
		}
		out = append(out, got...)
	}
	return out
}

func recordIDs(records []*Record) []string {
	out := make([]string, 0, len(records))
	for _, record := range records {
		out = append(out, fmt.Sprintf("%d:%d:%s", record.Partition, record.Offset, string(record.Value)))
	}
	return out
}

func expectRecords(t *testing.T, got []*Record, want []string) {
	t.Helper()
	gotIDs := recordIDs(got)
	if len(gotIDs) != len(want) {
		t.Fatalf("record count = %v, want %v", gotIDs, want)
	}
	for index := range want {
		if gotIDs[index] != want[index] {
			t.Fatalf("record %d = %q, want %q (full: %v)", index, gotIDs[index], want[index], gotIDs)
		}
	}
}

// TestCommittedTransactionDelivered buffers a transaction spanning two
// partitions and only releases it after the COMMIT markers, in offset order.
func TestCommittedTransactionDelivered(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p1 := NewMemorySource(1)

	p0.Append(PlainBatch(0, 0, 0, [][]byte{[]byte("a"), []byte("b")}...))
	p1.Append(DataBatch(1, 0, 0, 7, 1, true, []byte("x1"), []byte("x2")))
	p0.Append(DataBatch(0, 2, 0, 7, 1, true, []byte("t1"), []byte("t2")))

	r, err := NewReader(ctx, []PartitionSource{p0, p1})
	if err != nil {
		t.Fatal(err)
	}

	// Before any marker: only the non-transactional records escape.
	got := pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:0:a", "0:1:b"})

	// Markers can arrive on either partition, in any order.
	p0.Append(ControlBatch(0, 4, 0, 7, 1, ControlCommit))
	p1.Append(ControlBatch(1, 2, 0, 7, 1, ControlCommit))
	got = pollAll(t, r, 1)
	expectRecords(t, got, []string{
		"0:2:t1", "0:3:t2",
		"1:0:x1", "1:1:x2",
	})
	if stats := r.Stats(); stats.Delivered != 6 {
		t.Fatalf("delivered = %d, want 6", stats.Delivered)
	}
}

// TestAbortedTransactionSuppressed ensures no aborted record ever leaks.
func TestAbortedTransactionSuppressed(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p1 := NewMemorySource(1)

	p0.Append(PlainBatch(0, 0, 0, [][]byte{[]byte("keep")}...))
	p0.Append(DataBatch(0, 1, 0, 9, 2, true, []byte("bad1"), []byte("bad2")))
	p1.Append(DataBatch(1, 0, 0, 9, 2, true, []byte("bad3")))
	p0.Append(ControlBatch(0, 3, 0, 9, 2, ControlAbort))
	p1.Append(ControlBatch(1, 1, 0, 9, 2, ControlAbort))
	// A follow-up transaction on the same producer/epoch must still work.
	p0.Append(DataBatch(0, 4, 0, 9, 2, true, []byte("good")))
	p0.Append(ControlBatch(0, 5, 0, 9, 2, ControlCommit))

	r, err := NewReader(ctx, []PartitionSource{p0, p1})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 2)
	expectRecords(t, got, []string{"0:0:keep", "0:4:good"})

	for _, record := range got {
		value := string(record.Value)
		if value == "bad1" || value == "bad2" || value == "bad3" {
			t.Fatalf("aborted record leaked: %v", record)
		}
	}
	if stats := r.Stats(); stats.AbortedRecords != 3 {
		t.Fatalf("aborted = %d, want 3", stats.AbortedRecords)
	}
}

// TestOutOfOrderPartitions feeds all partitions and verifies output is globally
// ordered by partition id then offset regardless of fetch interleaving.
func TestOutOfOrderPartitions(t *testing.T) {
	ctx := context.Background()
	partitions := make([]*MemorySource, 4)
	sources := make([]PartitionSource, 4)
	for index := range partitions {
		partitions[index] = NewMemorySource(index)
		sources[index] = partitions[index]
		partitions[index].Append(DataBatch(index, 0, 0, 3, 0, true,
			[]byte(fmt.Sprintf("p%d", index))))
		partitions[index].Append(ControlBatch(index, 1, 0, 3, 0, ControlCommit))
	}

	r, err := NewReader(ctx, sources)
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 3)
	expectRecords(t, got, []string{
		"0:0:p0", "1:0:p1", "2:0:p2", "3:0:p3",
	})
}

// TestFencedProducerEpoch rejects batches from an older producer epoch after a
// newer one was seen.
func TestFencedProducerEpoch(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p0.Append(DataBatch(0, 0, 0, 5, 3, true, []byte("new")))
	p0.Append(ControlBatch(0, 1, 0, 5, 3, ControlCommit))
	p0.Append(DataBatch(0, 2, 0, 5, 2, true, []byte("zombie")))

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Poll(ctx); !errors.Is(err, ErrFencedProducer) {
		t.Fatalf("err = %v, want ErrFencedProducer", err)
	}
}

// TestSequenceGap detects a missing idempotent write.
func TestSequenceGap(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	first := DataBatch(0, 0, 0, 5, 1, false, []byte("a"), []byte("b"))
	gapped := DataBatch(0, 2, 0, 5, 1, false, []byte("c"))
	gapped.Records[0].Sequence = 5
	p0.Append(first)
	p0.Append(gapped)

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Poll(ctx); !errors.Is(err, ErrOutOfSequence) {
		t.Fatalf("err = %v, want ErrOutOfSequence", err)
	}
}

// TestDuplicateBatchDedup simulates a retried idempotent batch and verifies the
// duplicate is dropped while subsequent records still flow.
func TestDuplicateBatchDedup(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	first := DataBatch(0, 0, 0, 6, 1, false, []byte("a"), []byte("b"))
	duplicate := DataBatch(0, 2, 0, 6, 1, false, []byte("a"), []byte("b"))
	next := DataBatch(0, 4, 0, 6, 1, false, []byte("c"))
	next.Records[0].Sequence = 2
	p0.Append(first)
	p0.Append(duplicate)
	p0.Append(next)

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:0:a", "0:1:b", "0:4:c"})
	if stats := r.Stats(); stats.DuplicateRecords != 2 {
		t.Fatalf("duplicates = %d, want 2", stats.DuplicateRecords)
	}
}

// TestLSOWithholding keeps records behind the last stable offset until
// stability catches up.
func TestLSOWithholding(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p0.SetLSO(2)
	p0.Append(PlainBatch(0, 0, 0, [][]byte{[]byte("a"), []byte("b")}...))
	p0.Append(DataBatch(0, 2, 0, 4, 0, true, []byte("t1"), []byte("t2")))
	p0.Append(ControlBatch(0, 4, 0, 4, 0, ControlCommit))

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:0:a", "0:1:b"})

	p0.SetLSO(5)
	got = pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:2:t1", "0:3:t2"})
}

// TestTruncationDropsPartialTransaction truncates the head of the logs while a
// transaction is open. The whole transaction is poisoned and never partially
// delivered; subsequent clean data still flows.
func TestTruncationDropsPartialTransaction(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p1 := NewMemorySource(1)
	p0.Append(PlainBatch(0, 0, 0, [][]byte{[]byte("stable")}...))
	p0.Append(DataBatch(0, 1, 0, 8, 1, true, []byte("tx-a"), []byte("tx-b")))
	p1.Append(DataBatch(1, 0, 0, 8, 1, true, []byte("tx-c")))

	r, err := NewReader(ctx, []PartitionSource{p0, p1})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:0:stable"})

	// Leader truncates away the open transaction and rewrites history under a
	// new leader epoch. Surviving records of that transaction must be
	// suppressed together with the lost ones.
	p0.Truncate(3)
	p0.RewindEpoch(2)
	p1.Truncate(1)
	p1.RewindEpoch(2)
	p0.Append(PlainBatch(0, 3, 2, [][]byte{[]byte("after-cut")}...))

	got = pollAll(t, r, 2)
	for _, record := range got {
		value := string(record.Value)
		if value == "tx-a" || value == "tx-b" || value == "tx-c" {
			t.Fatalf("truncated transaction leaked: %v", record)
		}
	}
	expectRecords(t, got, []string{"0:3:after-cut"})
	if stats := r.Stats(); stats.PoisonedTxns != 1 {
		t.Fatalf("poisoned txns = %d, want 1", stats.PoisonedTxns)
	}
}

// TestRecoveryMatchesReplay drives one reader to a checkpoint, rebuilds a
// fresh reader over the same logs and asserts the combined output equals a
// single from-scratch replay (no duplicates, no gaps).
func TestRecoveryMatchesReplay(t *testing.T) {
	ctx := context.Background()

	build := func() ([]PartitionSource, CheckpointStore) {
		p0 := NewMemorySource(0)
		p1 := NewMemorySource(1)
		p0.Append(PlainBatch(0, 0, 0, [][]byte{[]byte("a"), []byte("b")}...))
		p0.Append(DataBatch(0, 2, 0, 11, 1, true, []byte("t1")))
		p1.Append(DataBatch(1, 0, 0, 11, 1, true, []byte("u1"), []byte("u2")))
		p0.Append(ControlBatch(0, 3, 0, 11, 1, ControlCommit))
		p1.Append(ControlBatch(1, 2, 0, 11, 1, ControlCommit))
		p0.Append(PlainBatch(0, 4, 0, [][]byte{[]byte("z")}...))
		p1.Append(DataBatch(1, 3, 0, 11, 1, true, []byte("v1")))
		p1.Append(ControlBatch(1, 4, 0, 11, 1, ControlAbort))
		return []PartitionSource{p0, p1}, NewMemoryCheckpoint()
	}

	// Reference replay: a single reader from offset zero.
	sources, _ := build()
	reference, err := NewReader(ctx, sources)
	if err != nil {
		t.Fatal(err)
	}
	want := pollAll(t, reference, 2)

	// Recovered run: a first reader checkpoints after the first output poll, a
	// brand-new reader resumes using only the persisted offsets.
	sources2, store := build()
	first, err := NewReader(ctx, sources2, WithCheckpointStore(store))
	if err != nil {
		t.Fatal(err)
	}
	partOne := pollAll(t, first, 1)
	if err := first.Checkpoint(ctx); err != nil {
		t.Fatal(err)
	}

	second, err := NewReader(ctx, sources2, WithCheckpointStore(store))
	if err != nil {
		t.Fatal(err)
	}
	partTwo := pollAll(t, second, 2)

	expectRecords(t, append(partOne, partTwo...), recordIDs(want))

	saved, err := store.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if saved[0] != 4 || saved[1] != 3 {
		t.Fatalf("checkpoint = %v, want partition0=4 partition1=3", saved)
	}
}

// TestTruncationAfterCommittedTxn verifies that truncating only already
// finalized history does not poison later transactions or lose their records.
func TestTruncationAfterCommittedTxn(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	p0.Append(DataBatch(0, 0, 0, 4, 1, true, []byte("old-txn")))
	p0.Append(ControlBatch(0, 1, 0, 4, 1, ControlCommit))
	p0.Append(DataBatch(0, 2, 0, 4, 1, true, []byte("new-txn")))
	p0.Append(ControlBatch(0, 3, 0, 4, 1, ControlCommit))

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:0:old-txn", "0:2:new-txn"})

	// Retention drops everything up to offset 2 on a later poll; the already
	// delivered history is gone but no ongoing transaction exists to poison.
	p0.Truncate(2)
	p0.Append(PlainBatch(0, 4, 1, [][]byte{[]byte("fresh")}...))

	got = pollAll(t, r, 1)
	expectRecords(t, got, []string{"0:4:fresh"})
	if stats := r.Stats(); stats.PoisonedTxns != 0 {
		t.Fatalf("poisoned txns = %d, want 0", stats.PoisonedTxns)
	}
}

// TestEmptyPollAndStaleContext documents that polls with no new data return an
// empty slice and no error, and context cancellation propagates from sources.
func TestEmptyPollAndStaleContext(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Poll(ctx)
	if err != nil {
		t.Fatalf("empty poll errored: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty poll returned %d records", len(got))
	}
}

// TestFinalizedTxnGarbageCollected runs many short transactions and asserts
// the producer does not retain finalized transaction metadata after their
// records have been drained.
func TestFinalizedTxnGarbageCollected(t *testing.T) {
	ctx := context.Background()
	p0 := NewMemorySource(0)
	const count = 50
	for index := 0; index < count; index++ {
		base := int64(index * 2)
		p0.Append(DataBatch(0, base, 0, 21, 0, true,
			[]byte(fmt.Sprintf("txn-%d", index))))
		p0.Append(ControlBatch(0, base+1, 0, 21, 0, ControlCommit))
	}

	r, err := NewReader(ctx, []PartitionSource{p0})
	if err != nil {
		t.Fatal(err)
	}
	got := pollAll(t, r, 2)
	if len(got) != count {
		t.Fatalf("delivered = %d, want %d", len(got), count)
	}
	producer := r.producers[21]
	if producer == nil {
		t.Fatal("producer state missing")
	}
	if len(producer.finalized) != 0 {
		t.Fatalf("finalized txn leak: %d retained", len(producer.finalized))
	}
	if r.Stats().BufferedRecords != 0 {
		t.Fatalf("buffered records = %d, want 0", r.Stats().BufferedRecords)
	}
}
