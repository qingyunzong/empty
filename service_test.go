package q147

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

// recordingSubscriber collects delivered transactions and can be told to
// fail deliveries.
type recordingSubscriber struct {
	mu       sync.Mutex
	got      []Transaction
	failNext int
	err      error
}

func (r *recordingSubscriber) Apply(txn Transaction) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failNext > 0 {
		r.failNext--
		if r.err != nil {
			return r.err
		}
		return errors.New("injected subscriber failure")
	}
	r.got = append(r.got, txn)
	return nil
}

func (r *recordingSubscriber) delivered() []Transaction {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Transaction, len(r.got))
	copy(out, r.got)
	return out
}

// flakyLog fails appends for which fail(rec) returns true.
type flakyLog struct {
	inner *MemLogStore
	fail  func(rec Record) bool
}

func (f *flakyLog) Append(rec Record) error {
	if f.fail != nil && f.fail(rec) {
		return errors.New("injected log failure")
	}
	return f.inner.Append(rec)
}

func (f *flakyLog) Replay(fn func(rec Record) error) error {
	return f.inner.Replay(fn)
}

func mustOpen(t *testing.T, log LogStore, sub Subscriber) *Service {
	t.Helper()
	s, err := Open(log, sub)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func txnIDs(txns []Transaction) []TxnID {
	ids := make([]TxnID, len(txns))
	for i, txn := range txns {
		ids[i] = txn.ID
	}
	return ids
}

// feedTxn1 feeds a complete two-shard transaction t1 and returns the
// expected delivered form.
func feedTxn1(t *testing.T, s *Service) Transaction {
	t.Helper()
	must(t, s.Begin("t1"))
	must(t, s.AddChange("t1", "s1", 1, []byte("a")))
	must(t, s.AddChange("t1", "s2", 1, []byte("b")))
	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 1, "s2": 1}))
	must(t, s.SealShard("s1", 1))
	must(t, s.SealShard("s2", 1))
	return Transaction{
		ID: "t1",
		Changes: []Change{
			{Shard: "s1", Seq: 1, Data: []byte("a")},
			{Shard: "s2", Seq: 1, Data: []byte("b")},
		},
	}
}

func TestInterleavedTransactionsDeliveredAtomicallyInCommitOrder(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	// Two interleaved transactions across two shards.
	must(t, s.Begin("t1"))
	must(t, s.Begin("t2"))
	must(t, s.AddChange("t1", "s1", 1, []byte("a")))
	must(t, s.AddChange("t2", "s1", 2, []byte("c")))
	must(t, s.AddChange("t1", "s2", 1, []byte("b")))

	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 1, "s2": 1}))
	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("delivered before seals: %v", got)
	}
	must(t, s.SealShard("s1", 1))
	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("delivered with s2 unsealed: %v", got)
	}
	must(t, s.SealShard("s2", 1))
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1"}) {
		t.Fatalf("want [t1], got %v", got)
	}

	// t2 commits but its shard is not sealed far enough yet.
	must(t, s.Commit("t2", map[ShardID]uint64{"s1": 2}))
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1"}) {
		t.Fatalf("t2 delivered before seal: %v", got)
	}
	must(t, s.SealShard("s1", 2))
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1", "t2"}) {
		t.Fatalf("want [t1 t2], got %v", got)
	}
	if got := s.Checkpoint(); got != 2 {
		t.Fatalf("checkpoint = %d, want 2", got)
	}
}

func TestCommitBeforeLastChange(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	must(t, s.Begin("t1"))
	must(t, s.AddChange("t1", "s1", 1, []byte("a")))
	// Commit and seal arrive before the final change.
	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 2}))
	must(t, s.SealShard("s1", 2))
	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("delivered before last change: %v", got)
	}
	must(t, s.AddChange("t1", "s1", 2, []byte("b")))
	got := sub.delivered()
	if len(got) != 1 {
		t.Fatalf("want 1 transaction, got %d", len(got))
	}
	want := []Change{
		{Shard: "s1", Seq: 1, Data: []byte("a")},
		{Shard: "s1", Seq: 2, Data: []byte("b")},
	}
	if !reflect.DeepEqual(got[0].Changes, want) {
		t.Fatalf("changes = %+v, want %+v", got[0].Changes, want)
	}
}

func TestSequenceGapBlocksDelivery(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	must(t, s.AddChange("t1", "s1", 1, []byte("a")))
	must(t, s.AddChange("t1", "s1", 3, []byte("c")))
	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 3}))
	must(t, s.SealShard("s1", 3))
	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("delivered with sequence gap: %v", got)
	}
	must(t, s.AddChange("t1", "s1", 2, []byte("b")))
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1"}) {
		t.Fatalf("want [t1], got %v", got)
	}
}

func TestDuplicateEventsAreIdempotent(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	want := feedTxn1(t, s)
	// Re-send everything; nothing may change or be delivered twice.
	must(t, s.Begin("t1"))
	must(t, s.AddChange("t1", "s1", 1, []byte("a")))
	must(t, s.AddChange("t1", "s2", 1, []byte("b")))
	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 1, "s2": 1}))
	must(t, s.SealShard("s1", 1))
	must(t, s.SealShard("s2", 1))

	got := sub.delivered()
	if len(got) != 1 {
		t.Fatalf("want 1 delivery, got %d", len(got))
	}
	if !reflect.DeepEqual(got[0], want) {
		t.Fatalf("got %+v, want %+v", got[0], want)
	}
	if err := s.Commit("t1", map[ShardID]uint64{"s1": 2, "s2": 1}); err == nil {
		t.Fatal("conflicting commit not rejected")
	}
	if err := s.AddChange("t1", "s1", 0, nil); err == nil {
		t.Fatal("sequence 0 not rejected")
	}
}

// Crash between writing the log and publishing: events are durable but the
// subscriber never saw them. After restart the transaction is delivered.
func TestCrashBetweenLogAndPublish(t *testing.T) {
	log := NewMemLogStore()
	sub1 := &recordingSubscriber{failNext: 1 << 30}
	s1 := mustOpen(t, log, sub1)
	want := feedTxn1(t, s1)
	if got := sub1.delivered(); len(got) != 0 {
		t.Fatalf("subscriber should have failed, got %v", got)
	}
	if got := s1.Checkpoint(); got != 0 {
		t.Fatalf("checkpoint = %d, want 0", got)
	}

	// Restart over the same log with a healthy subscriber.
	sub2 := &recordingSubscriber{}
	s2 := mustOpen(t, log, sub2)
	got := sub2.delivered()
	if len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("after restart got %+v, want %+v", got, want)
	}
	if got := s2.Checkpoint(); got != 1 {
		t.Fatalf("checkpoint = %d, want 1", got)
	}
}

// Crash between publish and confirm: the subscriber persisted the
// transaction but the acknowledgement never reached the log. After restart
// the transaction is re-delivered with the same ID (subscriber must be
// idempotent), and once the ack lands it is never delivered again.
func TestCrashBetweenPublishAndConfirm(t *testing.T) {
	inner := NewMemLogStore()
	failAck := true
	log := &flakyLog{inner: inner, fail: func(rec Record) bool {
		return failAck && rec.Kind == RecordAck
	}}

	sub1 := &recordingSubscriber{}
	s1 := mustOpen(t, log, sub1)
	want := feedTxn1(t, s1)
	if got := sub1.delivered(); len(got) != 1 {
		t.Fatalf("want 1 delivery before crash, got %d", len(got))
	}
	if got := s1.Checkpoint(); got != 0 {
		t.Fatalf("checkpoint advanced without durable ack: %d", got)
	}

	// Restart with a working log; the unacknowledged transaction must be
	// re-delivered with an unchanged ID.
	failAck = false
	sub2 := &recordingSubscriber{}
	s2 := mustOpen(t, log, sub2)
	got := sub2.delivered()
	if len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("re-delivery = %+v, want %+v", got, want)
	}
	if got[0].ID != "t1" {
		t.Fatalf("transaction ID changed across restart: %q", got[0].ID)
	}
	if got := s2.Checkpoint(); got != 1 {
		t.Fatalf("checkpoint = %d, want 1", got)
	}

	// The ack is durable now: a further restart must not re-deliver.
	sub3 := &recordingSubscriber{}
	s3 := mustOpen(t, log, sub3)
	if got := sub3.delivered(); len(got) != 0 {
		t.Fatalf("acknowledged transaction re-delivered: %v", got)
	}
	if got := s3.Checkpoint(); got != 1 {
		t.Fatalf("checkpoint = %d, want 1", got)
	}
}

// Acknowledged transactions are never re-delivered after a restart, while
// later unacknowledged ones are.
func TestRestartRedeliversOnlyUnacknowledged(t *testing.T) {
	log := NewMemLogStore()
	sub1 := &recordingSubscriber{}
	s1 := mustOpen(t, log, sub1)

	feedTxn1(t, s1) // delivered and acknowledged
	// t2 becomes complete only after the subscriber starts failing.
	sub1.failNext = 1 << 30
	must(t, s1.AddChange("t2", "s1", 2, []byte("c")))
	must(t, s1.Commit("t2", map[ShardID]uint64{"s1": 2}))
	must(t, s1.SealShard("s1", 2))
	if got := s1.Checkpoint(); got != 1 {
		t.Fatalf("checkpoint = %d, want 1", got)
	}

	sub2 := &recordingSubscriber{}
	s2 := mustOpen(t, log, sub2)
	got := sub2.delivered()
	if len(got) != 1 || got[0].ID != "t2" {
		t.Fatalf("after restart got %v, want only [t2]", txnIDs(got))
	}
	if got := s2.Checkpoint(); got != 2 {
		t.Fatalf("checkpoint = %d, want 2", got)
	}
}

// The checkpoint only advances on subscriber confirmation, and a stuck
// transaction blocks later ones (commit order is preserved).
func TestCheckpointAdvancesOnlyOnAck(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	sub.failNext = 1 << 30
	feedTxn1(t, s)
	must(t, s.AddChange("t2", "s1", 2, []byte("c")))
	must(t, s.Commit("t2", map[ShardID]uint64{"s1": 2}))
	must(t, s.SealShard("s1", 2))

	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("delivered despite failing subscriber: %v", got)
	}
	if got := s.Checkpoint(); got != 0 {
		t.Fatalf("checkpoint = %d, want 0", got)
	}

	// Subscriber recovers; Flush retries and drains both in commit order.
	sub.failNext = 0
	s.Flush()
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1", "t2"}) {
		t.Fatalf("want [t1 t2], got %v", got)
	}
	if got := s.Checkpoint(); got != 2 {
		t.Fatalf("checkpoint = %d, want 2", got)
	}
}

// A head-of-line transaction that is not yet complete must not block
// replay, but it does block delivery of later committed transactions.
func TestIncompleteHeadBlocksLaterCommits(t *testing.T) {
	sub := &recordingSubscriber{}
	s := mustOpen(t, NewMemLogStore(), sub)

	must(t, s.Commit("t1", map[ShardID]uint64{"s1": 2})) // changes never arrive
	must(t, s.AddChange("t2", "s1", 1, []byte("a")))
	must(t, s.Commit("t2", map[ShardID]uint64{"s1": 1}))
	must(t, s.SealShard("s1", 1))
	if got := sub.delivered(); len(got) != 0 {
		t.Fatalf("later transaction overtook incomplete head: %v", got)
	}
	// Complete t1; both drain in commit order.
	must(t, s.AddChange("t1", "s1", 2, []byte("b")))
	must(t, s.SealShard("s1", 2))
	if got := txnIDs(sub.delivered()); !reflect.DeepEqual(got, []TxnID{"t1", "t2"}) {
		t.Fatalf("want [t1 t2], got %v", got)
	}
}
