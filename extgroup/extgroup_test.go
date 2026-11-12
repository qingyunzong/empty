package extgroup

import (
	"context"
	"errors"
	"io"
	"math/big"
	"math/rand"
	"slices"
	"testing"
)

// recordingSink consumes groups via the streaming sequence callback and stores
// the fully read result. failAfterEmit forces an error once that many groups
// have been emitted.
type recordingSink struct {
	groups         []recordedGroup
	failAfterEmit  int
	streamingStops bool
}

type recordedGroup struct {
	key  string
	sum  *big.Int
	seqs []uint64
}

func (s *recordingSink) EmitGroup(ctx context.Context, key string, sum *big.Int, emit EmitSeq) error {
	if s.failAfterEmit >= 0 && len(s.groups) >= s.failAfterEmit {
		return errors.New("fake: injected sink failure")
	}
	group := recordedGroup{key: key, sum: new(big.Int).Set(sum)}
	for i := 0; ; i++ {
		seq, err := emit(i)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		group.seqs = append(group.seqs, seq)
	}
	if _, err := emit(len(group.seqs)); !errors.Is(err, io.EOF) {
		s.streamingStops = true
		return errors.New("emit callback did not return io.EOF at end")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.groups = append(s.groups, group)
	return nil
}

func mustAggregator(t *testing.T, factory SegmentFactory, sink GroupSink, b int) *Aggregator {
	t.Helper()
	agg, err := NewAggregator(Config{B: b, Segments: factory, Sink: sink})
	if err != nil {
		t.Fatalf("NewAggregator: %v", err)
	}
	return agg
}

func bigInt(v int64) *big.Int { return big.NewInt(v) }

// TestCrossSegmentSameGroup drives a B=2 cache so every key spans multiple
// segments and verifies byte-ordered sums and streaming sequence lists.
func TestCrossSegmentSameGroup(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	rows := []Row{
		{Key: "b", Value: bigInt(1), Seq: 0},
		{Key: "a", Value: bigInt(10), Seq: 1},
		{Key: "b", Value: bigInt(2), Seq: 2},
		{Key: "a", Value: bigInt(20), Seq: 3},
		{Key: "a", Value: bigInt(30), Seq: 4},
		{Key: "c", Value: bigInt(100), Seq: 5},
		{Key: "b", Value: bigInt(4), Seq: 6},
	}
	for _, row := range rows {
		if err := agg.Add(context.Background(), row); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if err := agg.Finish(context.Background()); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	want := []recordedGroup{
		{key: "a", sum: bigInt(60), seqs: []uint64{1, 3, 4}},
		{key: "b", sum: bigInt(7), seqs: []uint64{0, 2, 6}},
		{key: "c", sum: bigInt(100), seqs: []uint64{5}},
	}
	if len(sink.groups) != len(want) {
		t.Fatalf("got %d groups, want %d", len(sink.groups), len(want))
	}
	for i, got := range sink.groups {
		exp := want[i]
		if got.key != exp.key || got.sum.Cmp(exp.sum) != 0 || !slices.Equal(got.seqs, exp.seqs) {
			t.Errorf("group %d = %+v, want %+v", i, got, exp)
		}
	}
	if sink.streamingStops {
		t.Error("sequence callback did not terminate correctly")
	}

	if len(factory.segs) != 4 {
		t.Fatalf("spilled %d segments, want 4", len(factory.segs))
	}
	for _, seg := range factory.snapshot() {
		seg.mu.Lock()
		writes := seg.writerWrites
		seg.mu.Unlock()
		if writes > 2 {
			t.Errorf("segment %d wrote %d rows, exceeds B=2", seg.id, writes)
		}
	}
	factory.assertAllReleased(t)

	if err := agg.Finish(context.Background()); !errors.Is(err, ErrFinished) {
		t.Errorf("second Finish err = %v, want ErrFinished", err)
	}
	if err := agg.Add(context.Background(), rows[0]); !errors.Is(err, ErrFinished) {
		t.Errorf("Add after Finish err = %v, want ErrFinished", err)
	}
}

// TestWriteFailureReleasesSegments injects a failure while creating the second
// segment: the already spilled segment must still be closed and released and no
// group may be published.
func TestWriteFailureReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	factory.newErrAt = 1
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 5; i++ {
		err := agg.Add(context.Background(), Row{Key: "k", Value: bigInt(i), Seq: uint64(i)})
		// Rows 0-1 spill segment 0; rows 2-3 fill the cache and the fourth
		// Add triggers the failing NewSegment for segment 1.
		if i < 3 {
			if err != nil {
				t.Fatalf("Add %d: %v", i, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("Add %d succeeded, want injection error", i)
		}
	}
	if len(sink.groups) != 0 {
		t.Fatalf("published %d groups before complete readback, want 0", len(sink.groups))
	}
	if len(factory.segs) != 1 {
		t.Fatalf("created %d segments, want 1", len(factory.segs))
	}
	factory.assertAllReleased(t)

	if err := agg.Finish(context.Background()); !errors.Is(err, ErrFinished) {
		t.Errorf("Finish after abort err = %v, want ErrFinished", err)
	}
}

// TestWriteRowFailureReleasesSegments injects a failure mid-write.
func TestWriteRowFailureReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	factory.writeErrAt = 1
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	if err := agg.Add(context.Background(), Row{Key: "k", Value: bigInt(1), Seq: 0}); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	if err := agg.Add(context.Background(), Row{Key: "k", Value: bigInt(2), Seq: 1}); err == nil {
		t.Fatal("second Add succeeded, want write failure")
	}
	if len(sink.groups) != 0 {
		t.Fatalf("published %d groups, want 0", len(sink.groups))
	}
	if len(factory.segs) != 1 {
		t.Fatalf("created %d segments, want 1", len(factory.segs))
	}
	factory.assertAllReleased(t)
}

// TestReadFailureReleasesSegments injects a reader failure during merge and
// checks the error propagates, readers close and all segments release.
func TestReadFailureReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	// Two segments, each holding two rows; fail readers after one row.
	factory.readErrAt = 1
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 4; i++ {
		if err := agg.Add(context.Background(), Row{
			Key: "k", Value: bigInt(i + 1), Seq: uint64(i),
		}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if err := agg.Finish(context.Background()); err == nil {
		t.Fatal("Finish succeeded, want read failure")
	}
	if len(sink.groups) != 0 {
		t.Fatalf("published %d groups despite failed readback, want 0", len(sink.groups))
	}
	for _, seg := range factory.snapshot() {
		seg.mu.Lock()
		readerClosed := seg.readerClosed
		seg.mu.Unlock()
		if !readerClosed {
			t.Errorf("segment %d reader not closed after error", seg.id)
		}
	}
	factory.assertAllReleased(t)
}

// TestReaderOpenFailureReleasesSegments covers failure when opening a reader.
func TestReaderOpenFailureReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	factory.readerOpenFailOn = map[int]bool{1: true}
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 4; i++ {
		if err := agg.Add(context.Background(), Row{
			Key: "k", Value: bigInt(i + 1), Seq: uint64(i),
		}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if err := agg.Finish(context.Background()); err == nil {
		t.Fatal("Finish succeeded, want reader open failure")
	}
	if len(sink.groups) != 0 {
		t.Fatalf("published %d groups, want 0", len(sink.groups))
	}
	factory.assertAllReleased(t)
}

// TestCancelDuringAdd checks cancellation aborts and releases prior segments.
func TestCancelDuringAdd(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	ctx, cancel := context.WithCancel(context.Background())
	if err := agg.Add(ctx, Row{Key: "k", Value: bigInt(1), Seq: 0}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := agg.Add(ctx, Row{Key: "k", Value: bigInt(2), Seq: 1}); err != nil {
		t.Fatalf("spill Add: %v", err)
	}
	if len(factory.segs) != 1 {
		t.Fatalf("created %d segments, want 1", len(factory.segs))
	}

	cancel()
	err := agg.Add(ctx, Row{Key: "k", Value: bigInt(3), Seq: 2})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Add err = %v, want context.Canceled", err)
	}
	factory.assertAllReleased(t)
	if err := agg.Finish(context.Background()); !errors.Is(err, ErrFinished) {
		t.Errorf("Finish after cancel err = %v, want ErrFinished", err)
	}
}

// TestCancelDuringFinish cancels before Finish so the final spill fails; no
// group is published and every segment is reclaimed.
func TestCancelDuringFinish(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 3; i++ {
		if err := agg.Add(context.Background(), Row{
			Key: "k", Value: bigInt(i + 1), Seq: uint64(i),
		}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := agg.Finish(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Finish err = %v, want context.Canceled", err)
	}
	if len(sink.groups) != 0 {
		t.Fatalf("published %d groups after cancellation, want 0", len(sink.groups))
	}
	factory.assertAllReleased(t)
}

// TestSinkFailureReleasesSegments checks a sink error aborts publication cleanly.
func TestSinkFailureReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: 0}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 4; i++ {
		if err := agg.Add(context.Background(), Row{
			Key: "k", Value: bigInt(1), Seq: uint64(i),
		}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if err := agg.Finish(context.Background()); err == nil {
		t.Fatal("Finish succeeded, want sink failure")
	}
	factory.assertAllReleased(t)
}

// TestDiscardReleasesSegments verifies explicit discard frees everything.
func TestDiscardReleasesSegments(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)

	for i := int64(0); i < 3; i++ {
		if err := agg.Add(context.Background(), Row{
			Key: "k", Value: bigInt(1), Seq: uint64(i),
		}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	agg.Discard()
	factory.assertAllReleased(t)
	if err := agg.Add(context.Background(), Row{Key: "k", Value: bigInt(1), Seq: 9}); !errors.Is(err, ErrFinished) {
		t.Errorf("Add after Discard err = %v, want ErrFinished", err)
	}
}

// TestEmptyFinish exercises the no-segment path.
func TestEmptyFinish(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)
	if err := agg.Finish(context.Background()); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(sink.groups) != 0 {
		t.Fatalf("got %d groups, want 0", len(sink.groups))
	}
	factory.assertAllReleased(t)
}

// TestInvalidConfig rejects non-positive B and missing dependencies.
func TestInvalidConfig(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	if _, err := NewAggregator(Config{B: 0, Segments: factory, Sink: sink}); err == nil {
		t.Error("B=0: want error")
	}
	if _, err := NewAggregator(Config{B: -1, Segments: factory, Sink: sink}); err == nil {
		t.Error("B=-1: want error")
	}
	if _, err := NewAggregator(Config{B: 2, Segments: nil, Sink: sink}); err == nil {
		t.Error("nil factory: want error")
	}
	if _, err := NewAggregator(Config{B: 2, Segments: factory, Sink: nil}); err == nil {
		t.Error("nil sink: want error")
	}
}

// TestNilValueRejected ensures rows without a value are rejected without
// spilling or creating segments.
func TestNilValueRejected(t *testing.T) {
	factory := newFakeFactory()
	sink := &recordingSink{failAfterEmit: -1}
	agg := mustAggregator(t, factory, sink, 2)
	if err := agg.Add(context.Background(), Row{Key: "k", Seq: 0}); err == nil {
		t.Fatal("nil Value: want error")
	}
	if len(factory.segs) != 0 {
		t.Fatalf("created %d segments, want 0", len(factory.segs))
	}
	if err := agg.Finish(context.Background()); err != nil {
		t.Fatalf("Finish after rejected Add: %v", err)
	}
}

// randomBigInt produces values spanning multiple big.Int limbs, including
// negatives and values larger than 64 bits.
func randomBigInt(rng *rand.Rand) *big.Int {
	n := new(big.Int).SetUint64(rng.Uint64())
	n.Lsh(n, uint(rng.Intn(128)))
	n.Or(n, new(big.Int).SetUint64(rng.Uint64()))
	if rng.Intn(2) == 0 {
		n.Neg(n)
	}
	return n
}

// referenceResult is the in-memory full-sort oracle.
type referenceGroup struct {
	key  string
	sum  *big.Int
	seqs []uint64
}

func reference(rows []Row) []referenceGroup {
	type part struct {
		value *big.Int
		seq   uint64
	}
	groups := map[string][]part{}
	for _, row := range rows {
		groups[row.Key] = append(groups[row.Key], part{
			value: new(big.Int).Set(row.Value),
			seq:   row.Seq,
		})
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	out := make([]referenceGroup, 0, len(keys))
	for _, key := range keys {
		parts := groups[key]
		slices.SortFunc(parts, func(a, b part) int {
			if a.seq < b.seq {
				return -1
			}
			if a.seq > b.seq {
				return 1
			}
			return 0
		})
		group := referenceGroup{key: key, sum: new(big.Int), seqs: make([]uint64, 0, len(parts))}
		for _, part := range parts {
			group.sum.Add(group.sum, part.value)
			group.seqs = append(group.seqs, part.seq)
		}
		out = append(out, group)
	}
	return out
}

// TestReferenceAgainstFullSort is a property-style cross-check against an
// in-memory full-sort oracle. The fixture caps the cache at two rows, forcing
// many segments with keys repeated across them, and uses arbitrary-precision
// values and byte-ordered keys.
func TestReferenceAgainstFullSort(t *testing.T) {
	const iterations = 40
	for seed := int64(0); seed < iterations; seed++ {
		rng := rand.New(rand.NewSource(seed))
		n := 1 + rng.Intn(60)

		keys := make([]string, 0, 6)
		for i := 0; i < 1+rng.Intn(6); i++ {
			keys = append(keys, string(rune('A'+i)))
		}
		// Include a key whose byte ordering differs from simple runs.
		keys = append(keys, "a\xffz", "a\x00b")

		rows := make([]Row, n)
		for i := range rows {
			rows[i] = Row{
				Key:   keys[rng.Intn(len(keys))],
				Value: randomBigInt(rng),
				Seq:   uint64(i),
			}
		}

		// Keep private copies of input values; the aggregator must not alias
		// caller big.Ints. Mutating after Add must not change results.
		snapshots := make([]*big.Int, n)
		for i := range rows {
			snapshots[i] = new(big.Int).Set(rows[i].Value)
		}

		factory := newFakeFactory()
		sink := &recordingSink{failAfterEmit: -1}
		agg := mustAggregator(t, factory, sink, 2)
		for i, row := range rows {
			if err := agg.Add(context.Background(), row); err != nil {
				t.Fatalf("seed %d Add %d: %v", seed, i, err)
			}
			rows[i].Value.SetInt64(int64(-i - 1))
		}
		if err := agg.Finish(context.Background()); err != nil {
			t.Fatalf("seed %d Finish: %v", seed, err)
		}

		// Restore values before running the oracle.
		for i := range rows {
			rows[i].Value = snapshots[i]
		}
		want := reference(rows)
		if len(sink.groups) != len(want) {
			t.Fatalf("seed %d: got %d groups, want %d", seed, len(sink.groups), len(want))
		}
		for i, got := range sink.groups {
			exp := want[i]
			if got.key != exp.key {
				t.Errorf("seed %d group %d key = %q, want %q", seed, i, got.key, exp.key)
			}
			if got.sum.Cmp(exp.sum) != 0 {
				t.Errorf("seed %d group %q sum = %s, want %s", seed, got.key, got.sum, exp.sum)
			}
			if !slices.Equal(got.seqs, exp.seqs) {
				t.Errorf("seed %d group %q seqs = %v, want %v", seed, got.key, got.seqs, exp.seqs)
			}
		}

		// Every spill is bounded by B=2 and all segments are released.
		for _, seg := range factory.snapshot() {
			seg.mu.Lock()
			writes := seg.writerWrites
			seg.mu.Unlock()
			if writes > 2 {
				t.Errorf("seed %d segment %d wrote %d rows, exceeds B=2", seed, seg.id, writes)
			}
		}
		factory.assertAllReleased(t)
	}
}
