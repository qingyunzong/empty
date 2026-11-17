package formal

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

func mustNew(t *testing.T, cfg Config) *Coordinator {
	t.Helper()
	c, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func auditConfig(store *MemStore, index Index, log ChangeLog) Config {
	return Config{
		Snapshots: store,
		Log:       log,
		Index:     index,
		BatchSize: 2,
		Audit:     SnapshotAuditor{Source: store},
	}
}

func mustCommit(t *testing.T, txn *MemTxn, changes func(*MemTxn)) Seq {
	t.Helper()
	if changes != nil {
		changes(txn)
	}
	seq, err := txn.Commit(context.Background())
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	return seq
}

func mustPublish(t *testing.T, c *Coordinator, cert Certificate) {
	t.Helper()
	if err := c.Publish(context.Background(), cert); err != nil {
		t.Fatalf("Publish: %v", err)
	}
}

func TestCrossingTransactionCommittedAfterSnapshot(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()

	base := store.Begin()
	mustCommit(t, base, func(txn *MemTxn) {
		if err := txn.Put("base", "v1"); err != nil {
			t.Fatal(err)
		}
	})

	crossing := store.Begin()
	if err := crossing.Put("late", "v2"); err != nil {
		t.Fatal(err)
	}

	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatalf("Scan: %v", err)
	}

	commitSeq := mustCommit(t, crossing, nil)
	if commitSeq <= c.Watermark().Snapshot {
		t.Fatalf("crossing commit %d did not cross snapshot %d", commitSeq, c.Watermark().Snapshot)
	}
	if _, ok := index.Get("late"); ok {
		t.Fatal("uncommitted crossing transaction leaked into the snapshot")
	}

	if _, err := c.CatchUp(ctx); err != nil {
		t.Fatalf("CatchUp: %v", err)
	}
	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	mustPublish(t, c, cert)

	if got, ok := index.Get("late"); !ok || got != "v2" {
		t.Fatalf("late key missing after replay: got %q, %t", got, ok)
	}
	if c.State() != StateVisible {
		t.Fatalf("state = %s, want visible", c.State())
	}
	if cert.Snapshot() != 1 || cert.Barrier() != commitSeq {
		t.Fatalf("certificate = %s, want snapshot 1 barrier %d", cert, commitSeq)
	}
	if !cert.Verified() {
		t.Fatal("certificate should record a successful audit")
	}

	snap, err := store.OpenSnapshotAt(ctx, cert.Barrier())
	if err != nil {
		t.Fatal(err)
	}
	report, err := Compare(ctx, index, snap)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() {
		t.Fatalf("index mismatch: %s", report)
	}
}

type hookSnapshotSource struct {
	store *MemStore
	hook  func()
}

func (s *hookSnapshotSource) OpenSnapshot(ctx context.Context) (Snapshot, error) {
	snap, err := s.store.OpenSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return &hookSnapshot{Snapshot: snap, hook: s.hook}, nil
}

type hookSnapshot struct {
	Snapshot
	hook func()
	seen int
	once sync.Once
}

func (s *hookSnapshot) Scan(ctx context.Context, visit func(Key, Value) error) error {
	return s.Snapshot.Scan(ctx, func(k Key, v Value) error {
		s.seen++
		if s.seen == 2 {
			s.once.Do(s.hook)
		}
		return visit(k, v)
	})
}

func TestTransactionCommitsDuringScan(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		for _, k := range []Key{"a", "b", "c"} {
			if err := txn.Put(k, "snapshot"); err != nil {
				t.Fatal(err)
			}
		}
	})

	crossing := store.Begin()
	if err := crossing.Put("mid-scan", "committed"); err != nil {
		t.Fatal(err)
	}
	if err := crossing.Delete("a"); err != nil {
		t.Fatal(err)
	}

	var commitSeq Seq
	source := &hookSnapshotSource{
		store: store,
		hook: func() {
			var err error
			commitSeq, err = crossing.Commit(ctx)
			if err != nil {
				t.Errorf("commit during scan: %v", err)
			}
		},
	}

	index := NewMemIndex()
	c := mustNew(t, Config{
		Snapshots: source,
		Log:       store,
		Index:     index,
		BatchSize: 1,
		Audit:     SnapshotAuditor{Source: store},
	})
	if err := c.Scan(ctx); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if commitSeq == 0 {
		t.Fatal("scan hook did not commit during scan")
	}
	if _, ok := index.Get("mid-scan"); ok {
		t.Fatal("snapshot unexpectedly contains a transaction that committed during the scan")
	}

	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	mustPublish(t, c, cert)

	if got, ok := index.Get("mid-scan"); !ok || got != "committed" {
		t.Fatalf("mid-scan commit missing: got %q, %t", got, ok)
	}
	if _, ok := index.Get("a"); ok {
		t.Fatal("mid-scan delete was not replayed")
	}
	if c.Watermark().Snapshot >= c.Watermark().Applied {
		t.Fatalf("watermark did not advance: %+v", c.Watermark())
	}
}

func TestStaleCertificateRequiresReseal(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("a", "1"); err != nil {
			t.Fatal(err)
		}
	})

	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatal(err)
	}

	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("b", "2"); err != nil {
			t.Fatal(err)
		}
	})

	if err := c.Publish(ctx, cert); !errors.Is(err, ErrStaleCertificate) {
		t.Fatalf("Publish error = %v, want ErrStaleCertificate", err)
	}
	if c.State() != StateSealed {
		t.Fatalf("state = %s, want sealed after stale publication", c.State())
	}

	fresh, err := c.Seal(ctx)
	if err != nil {
		t.Fatalf("re-Seal: %v", err)
	}
	if fresh.Barrier() <= cert.Barrier() {
		t.Fatalf("re-seal did not advance barrier: %d <= %d", fresh.Barrier(), cert.Barrier())
	}
	mustPublish(t, c, fresh)
	if _, ok := index.Get("b"); !ok {
		t.Fatal("re-sealed index does not contain the post-seal commit")
	}
}

func TestAudioRejectsGhostKey(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("real", "1"); err != nil {
			t.Fatal(err)
		}
	})

	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	index.Put("ghost", "bogus")

	_, err := c.Seal(ctx)
	if !errors.Is(err, ErrVerification) {
		t.Fatalf("Seal error = %v, want ErrVerification", err)
	}
	var verr *VerificationError
	if !errors.As(err, &verr) {
		t.Fatalf("Seal error = %T, want *VerificationError", err)
	}
	if len(verr.Report.Ghosts) != 1 || verr.Report.Ghosts[0] != "ghost" {
		t.Fatalf("ghost report = %+v", verr.Report)
	}
	if c.State() != StateFailed {
		t.Fatalf("state = %s, want failed", c.State())
	}
	if err := c.Publish(ctx, Certificate{}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Publish after failed audit = %v, want ErrInvalidState", err)
	}
}

func TestAuditRejectsMissingKey(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("missing", "1"); err != nil {
			t.Fatal(err)
		}
	})

	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	index.Delete("missing")

	if _, err := c.Seal(ctx); !errors.Is(err, ErrVerification) {
		t.Fatalf("Seal error = %v, want ErrVerification", err)
	}
}

func TestCancelDuringScan(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	source := &blockingSnapshotSource{
		started: started,
		once:    &once,
	}
	store := NewMemStore()
	audit := SnapshotAuditor{Source: store}
	c := mustNew(t, Config{
		Snapshots: source,
		Log:       store,
		Index:     NewMemIndex(),
		Audit:     audit,
	})

	errCh := make(chan error, 1)
	go func() {
		errCh <- c.Scan(context.Background())
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("Scan did not start")
	}
	if err := c.Cancel(errors.New("operator canceled")); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrCanceled) {
			t.Fatalf("Scan error = %v, want ErrCanceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Scan did not stop after Cancel")
	}
	if c.State() != StateCanceled {
		t.Fatalf("state = %s, want canceled", c.State())
	}
	if err := c.Publish(context.Background(), Certificate{}); !errors.Is(err, ErrCanceled) {
		t.Fatalf("Publish after cancel = %v, want ErrCanceled", err)
	}
}

func TestCallerContextCancelsBuild(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	source := &blockingSnapshotSource{started: started, once: &once}
	store := NewMemStore()
	c := mustNew(t, Config{
		Snapshots: source,
		Log:       store,
		Index:     NewMemIndex(),
		Audit:     SnapshotAuditor{Source: store},
	})

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- c.Scan(ctx) }()
	<-started
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrCanceled) || !errors.Is(err, context.Canceled) {
			t.Fatalf("Scan error = %v, want canceled errors", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Scan did not observe caller cancellation")
	}
	if c.State() != StateCanceled {
		t.Fatalf("state = %s, want canceled", c.State())
	}
}

type blockingLog struct {
	hw      Seq
	started chan struct{}
	once    sync.Once
}

func (l *blockingLog) HighWatermark(context.Context) (Seq, error) { return l.hw, nil }

func (l *blockingLog) Read(ctx context.Context, _, _ Seq, _ int) (Batch, error) {
	l.once.Do(func() { close(l.started) })
	<-ctx.Done()
	return Batch{}, ctx.Err()
}

func TestCancelDuringReplay(t *testing.T) {
	store := NewMemStore()
	log := &blockingLog{hw: 10, started: make(chan struct{})}
	c := mustNew(t, Config{
		Snapshots: store,
		Log:       log,
		Index:     NewMemIndex(),
		Audit:     SnapshotAuditor{Source: store},
	})
	if err := c.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}

	errCh := make(chan error, 1)
	go func() { _, err := c.Seal(context.Background()); errCh <- err }()
	select {
	case <-log.started:
	case <-time.After(2 * time.Second):
		t.Fatal("Seal did not begin replay")
	}
	if err := c.Cancel(errors.New("cancel during replay")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errCh:
		if !errors.Is(err, ErrCanceled) {
			t.Fatalf("Seal error = %v, want ErrCanceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Seal did not stop after cancellation")
	}
	if c.State() != StateCanceled {
		t.Fatalf("state = %s, want canceled", c.State())
	}
}

type blockingSnapshotSource struct {
	started chan struct{}
	once    *sync.Once
}

func (s *blockingSnapshotSource) OpenSnapshot(context.Context) (Snapshot, error) {
	return &blockingSnapshot{started: s.started, once: s.once}, nil
}

type blockingSnapshot struct {
	started chan struct{}
	once    *sync.Once
}

func (s *blockingSnapshot) Watermark() Seq { return 1 }

func (s *blockingSnapshot) Scan(ctx context.Context, _ func(Key, Value) error) error {
	s.once.Do(func() { close(s.started) })
	<-ctx.Done()
	return ctx.Err()
}

func TestCancelAfterSealPreventsPublish(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("a", "1"); err != nil {
			t.Fatal(err)
		}
	})
	c := mustNew(t, auditConfig(store, NewMemIndex(), store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Cancel(nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Publish(ctx, cert); !errors.Is(err, ErrCanceled) {
		t.Fatalf("Publish after cancel = %v, want ErrCanceled", err)
	}
}

func TestScanRejectsNonEmptyIndex(t *testing.T) {
	index := NewMemIndex()
	index.Put("existing", "v")
	store := NewMemStore()
	c := mustNew(t, Config{
		Snapshots: store,
		Log:       store,
		Index:     index,
		Audit:     SnapshotAuditor{Source: store},
	})
	if err := c.Scan(context.Background()); !errors.Is(err, ErrIndexNotEmpty) {
		t.Fatalf("Scan error = %v, want ErrIndexNotEmpty", err)
	}
	if c.State() != StateNew {
		t.Fatalf("state = %s, want new", c.State())
	}
}

func TestAuditorIsRequired(t *testing.T) {
	store := NewMemStore()
	_, err := New(Config{
		Snapshots: store,
		Log:       store,
		Index:     NewMemIndex(),
	})
	if !errors.Is(err, ErrNoAuditor) {
		t.Fatalf("New without auditor = %v, want ErrNoAuditor", err)
	}
}

type scriptedLog struct {
	hw    Seq
	batch Batch
}

func (l *scriptedLog) HighWatermark(context.Context) (Seq, error) { return l.hw, nil }

func (l *scriptedLog) Read(context.Context, Seq, Seq, int) (Batch, error) {
	return l.batch, nil
}

type auditFunc func(context.Context, Seq, Index) error

func (f auditFunc) Audit(ctx context.Context, at Seq, index Index) error {
	return f(ctx, at, index)
}

func TestLogContractViolationsFailBuild(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		batch Batch
		want  error
	}{
		{
			name: "beyond barrier",
			batch: Batch{Commits: []Commit{{
				Seq: 11, Txn: 1, Changes: []Change{{Op: OpPut, Key: "a", Value: "1"}},
			}}, Done: true},
			want: ErrLogBeyondBarrier,
		},
		{
			name: "out of order",
			batch: Batch{Commits: []Commit{
				{Seq: 5, Txn: 1, Changes: []Change{{Op: OpPut, Key: "a", Value: "1"}}},
				{Seq: 4, Txn: 2, Changes: []Change{{Op: OpPut, Key: "b", Value: "2"}}},
			}, Done: true},
			want: ErrLogOrder,
		},
		{
			name:  "stalled",
			batch: Batch{Commits: nil, Done: false},
			want:  ErrLogStalled,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemStore()
			log := &scriptedLog{hw: 10, batch: tc.batch}
			c := mustNew(t, Config{
				Snapshots: store,
				Log:       log,
				Index:     NewMemIndex(),
				Audit:     SnapshotAuditor{Source: store},
			})
			if err := c.Scan(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := c.Seal(ctx); !errors.Is(err, tc.want) {
				t.Fatalf("Seal error = %v, want %v", err, tc.want)
			}
			if c.State() != StateFailed {
				t.Fatalf("state = %s, want failed", c.State())
			}
		})
	}
}

func TestNonAdjacentDuplicateCommitIsSkipped(t *testing.T) {
	ctx := context.Background()
	log := &scriptedLog{
		hw: 10,
		batch: Batch{Commits: []Commit{
			{Seq: 5, Txn: 1, Changes: []Change{{Op: OpPut, Key: "a", Value: "1"}}},
			{Seq: 6, Txn: 2, Changes: []Change{{Op: OpPut, Key: "b", Value: "2"}}},
			{Seq: 5, Txn: 1, Changes: []Change{{Op: OpPut, Key: "a", Value: "1"}}},
		}, Done: true},
	}
	index := NewMemIndex()
	c := mustNew(t, Config{
		Snapshots: NewMemStore(),
		Log:       log,
		Index:     index,
		Audit:     auditFunc(func(context.Context, Seq, Index) error { return nil }),
	})
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if got := index.Entries(); !reflect.DeepEqual(got, map[Key]Value{"a": "1", "b": "2"}) {
		t.Fatalf("entries = %v", got)
	}
	if cert.Commits() != 2 || cert.Mutations() != 2 {
		t.Fatalf("duplicate replay was counted: %d commits, %d mutations",
			cert.Commits(), cert.Mutations())
	}
}

func TestForeignCertificateRejected(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("a", "1"); err != nil {
			t.Fatal(err)
		}
	})

	c1 := mustNew(t, auditConfig(store, NewMemIndex(), store))
	c2 := mustNew(t, auditConfig(store, NewMemIndex(), store))
	for _, c := range []*Coordinator{c1, c2} {
		if err := c.Scan(ctx); err != nil {
			t.Fatal(err)
		}
	}
	cert1, err := c1.Seal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cert2, err := c2.Seal(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if err := c2.Publish(ctx, cert1); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("Publish foreign certificate = %v, want ErrInvalidCertificate", err)
	}
	if err := c2.Publish(ctx, Certificate{}); !errors.Is(err, ErrInvalidCertificate) {
		t.Fatalf("Publish zero certificate = %v, want ErrInvalidCertificate", err)
	}
	mustPublish(t, c2, cert2)
}

func TestCompareClassifiesAllDifferences(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("a", "1"); err != nil {
			t.Fatal(err)
		}
		if err := txn.Put("b", "2"); err != nil {
			t.Fatal(err)
		}
	})
	snap, err := store.OpenSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}

	index := NewMemIndex()
	index.Put("b", "different")
	index.Put("ghost", "x")

	report, err := Compare(ctx, index, snap)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(report.Missing, []Key{"a"}) {
		t.Fatalf("Missing = %v", report.Missing)
	}
	if !reflect.DeepEqual(report.Ghosts, []Key{"ghost"}) {
		t.Fatalf("Ghosts = %v", report.Ghosts)
	}
	if !reflect.DeepEqual(report.Mismatched, []Key{"b"}) {
		t.Fatalf("Mismatched = %v", report.Mismatched)
	}
	if report.OK() {
		t.Fatal("report with differences must not be OK")
	}
}

func TestDeletionAndUpdateReplay(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("keep", "old"); err != nil {
			t.Fatal(err)
		}
		if err := txn.Put("drop", "old"); err != nil {
			t.Fatal(err)
		}
	})

	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}

	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("keep", "new"); err != nil {
			t.Fatal(err)
		}
		if err := txn.Delete("drop"); err != nil {
			t.Fatal(err)
		}
	})

	cert, err := c.Seal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	mustPublish(t, c, cert)

	if got, ok := index.Get("keep"); !ok || got != "new" {
		t.Fatalf("keep = %q, %t", got, ok)
	}
	if _, ok := index.Get("drop"); ok {
		t.Fatal("deleted key remains in index")
	}
	if cert.Commits() != 1 || cert.Mutations() != 2 {
		t.Fatalf("certificate counters = %d commits, %d mutations", cert.Commits(), cert.Mutations())
	}
	if err := c.Cancel(nil); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Cancel after visible = %v, want ErrInvalidState", err)
	}
	if c.State() != StateVisible {
		t.Fatalf("cancel changed visible state to %s", c.State())
	}
}

func TestDuplicateCommitApplicationIsIdempotent(t *testing.T) {
	index := NewMemIndex()
	index.Put("a", "1")
	index.Put("a", "1")
	index.Put("b", "2")
	index.Delete("b")
	index.Delete("b")

	want := map[Key]Value{"a": "1"}
	if got := index.Entries(); !reflect.DeepEqual(got, want) {
		t.Fatalf("entries = %v, want %v", got, want)
	}
}

func TestInvalidStates(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	c := mustNew(t, auditConfig(store, NewMemIndex(), store))

	if _, err := c.CatchUp(ctx); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("CatchUp before Scan = %v", err)
	}
	if _, err := c.Seal(ctx); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Seal before Scan = %v", err)
	}
	if err := c.Publish(ctx, Certificate{}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Publish before Scan = %v", err)
	}
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Scan(ctx); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("second Scan = %v", err)
	}
	if _, err := c.CatchUp(ctx); err != nil {
		t.Fatalf("CatchUp: %v", err)
	}
	if _, err := c.Seal(ctx); err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := c.CatchUp(ctx); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("CatchUp after Seal = %v", err)
	}
}

func TestScannedValuesAreCopied(t *testing.T) {
	ctx := context.Background()
	store := NewMemStore()
	mustCommit(t, store.Begin(), func(txn *MemTxn) {
		if err := txn.Put("a", "1"); err != nil {
			t.Fatal(err)
		}
	})
	index := NewMemIndex()
	c := mustNew(t, auditConfig(store, index, store))
	if err := c.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	snap, err := store.OpenSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Watermark() != 1 {
		t.Fatalf("watermark = %d, want 1", snap.Watermark())
	}
	entries := index.Entries()
	entries["a"] = "mutated copy"
	if got, _ := index.Get("a"); got != "1" {
		t.Fatalf("Entries exposed internal map: %q", got)
	}
}
