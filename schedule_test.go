package formal

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"example.org/dlks/formal/q10157/schedgen"
)

type scheduleResult struct {
	index *MemIndex
	cert  Certificate
}

func executeSchedule(t *testing.T, sch schedgen.Schedule, wrap func(ChangeLog) ChangeLog) scheduleResult {
	t.Helper()
	ctx := context.Background()
	store := NewMemStore()
	index := NewMemIndex()

	var log ChangeLog = store
	if wrap != nil {
		log = wrap(log)
	}
	c := mustNew(t, Config{
		Snapshots: store,
		Log:       log,
		Index:     index,
		BatchSize: 3,
		Audit:     SnapshotAuditor{Source: store},
	})

	txns := make(map[int]*MemTxn)
	var cert Certificate
	canceled := false

	for i, op := range sch.Ops {
		var err error
		switch op.Kind {
		case schedgen.Begin:
			txns[op.Txn] = store.Begin()
		case schedgen.Put:
			txn := txns[op.Txn]
			if txn == nil {
				t.Fatalf("op %d %v: unknown txn", i, op)
			}
			err = txn.Put(Key(op.Key), Value(op.Value))
		case schedgen.Delete:
			txn := txns[op.Txn]
			if txn == nil {
				t.Fatalf("op %d %v: unknown txn", i, op)
			}
			err = txn.Delete(Key(op.Key))
		case schedgen.Commit:
			txn := txns[op.Txn]
			if txn == nil {
				t.Fatalf("op %d %v: unknown txn", i, op)
			}
			_, err = txn.Commit(ctx)
		case schedgen.Rollback:
			txn := txns[op.Txn]
			if txn == nil {
				t.Fatalf("op %d %v: unknown txn", i, op)
			}
			err = txn.Rollback()
		case schedgen.Scan:
			err = c.Scan(ctx)
		case schedgen.CatchUp:
			_, err = c.CatchUp(ctx)
		case schedgen.Seal:
			cert, err = c.Seal(ctx)
		case schedgen.Publish:
			err = c.Publish(ctx, cert)
		case schedgen.Cancel:
			canceled = true
			err = c.Cancel(errors.New("scheduled cancellation"))
		default:
			t.Fatalf("op %d: unknown kind %v", i, op.Kind)
		}
		if err != nil {
			t.Fatalf("op %d %v: %v", i, op, err)
		}
	}

	if canceled {
		if c.State() != StateCanceled {
			t.Fatalf("state = %s, want canceled", c.State())
		}
		if err := c.Publish(ctx, Certificate{}); !errors.Is(err, ErrCanceled) {
			t.Fatalf("Publish after cancellation = %v, want ErrCanceled", err)
		}
		return scheduleResult{index: index}
	}

	if c.State() != StateVisible {
		t.Fatalf("final state = %s, want visible", c.State())
	}
	if !cert.Valid() || !cert.Verified() {
		t.Fatalf("certificate = %s, want valid and audited", cert)
	}
	if cert.Barrier() != c.Watermark().Sealed {
		t.Fatalf("certificate barrier %d != sealed watermark %d", cert.Barrier(), c.Watermark().Sealed)
	}

	snap, err := store.OpenSnapshotAt(ctx, cert.Barrier())
	if err != nil {
		t.Fatalf("OpenSnapshotAt(%d): %v", cert.Barrier(), err)
	}
	report, err := Compare(ctx, index, snap)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	if !report.OK() {
		t.Fatalf("index does not match table at barrier %d: %s missing=%v ghosts=%v mismatched=%v",
			cert.Barrier(), report, report.Missing, report.Ghosts, report.Mismatched)
	}

	current, err := store.Values(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := index.Entries(); !reflect.DeepEqual(got, current) {
		t.Fatalf("index differs from current table: index=%v table=%v", got, current)
	}

	return scheduleResult{index: index, cert: cert}
}

// duplicateLog replays old and newly read commits. It deliberately violates
// strict "seq > after" filtering: the coordinator must ignore replays without
// losing or duplicating effects.
type duplicateLog struct {
	inner   ChangeLog
	rng     *rand.Rand
	history []Commit
}

func newDuplicateLog(inner ChangeLog, seed int64) *duplicateLog {
	return &duplicateLog{inner: inner, rng: rand.New(rand.NewSource(seed))}
}

func (l *duplicateLog) HighWatermark(ctx context.Context) (Seq, error) {
	return l.inner.HighWatermark(ctx)
}

func (l *duplicateLog) Read(ctx context.Context, after, through Seq, limit int) (Batch, error) {
	batch, err := l.inner.Read(ctx, after, through, limit)
	if err != nil {
		return Batch{}, err
	}

	out := make([]Commit, 0, len(batch.Commits)*2+1)
	if len(l.history) > 0 && l.rng.Intn(2) == 0 {
		stale := l.history[l.rng.Intn(len(l.history))]
		out = append(out, stale.Clone())
	}
	for _, cm := range batch.Commits {
		cloned := cm.Clone()
		out = append(out, cloned)
		l.history = append(l.history, cloned.Clone())
		out = append(out, cloned.Clone())
	}
	return Batch{Commits: out, Done: batch.Done}, nil
}

func TestGeneratedSchedulesMatchTableScans(t *testing.T) {
	for seed := int64(0); seed < 120; seed++ {
		opts := schedgen.Options{
			Keys:     2 + int(seed%7),
			Pre:      1 + int(seed%4),
			Crossing: 1 + int(seed%3),
			Post:     1 + int(seed%4),
			Cancel:   seed%7 == 0,
		}
		sch := schedgen.Generate(seed, opts)
		t.Run(fmt.Sprintf("seed_%03d", seed), func(t *testing.T) {
			plain := executeSchedule(t, sch, nil)
			if opts.Cancel {
				return
			}

			replayed := executeSchedule(t, sch, func(log ChangeLog) ChangeLog {
				return newDuplicateLog(log, seed*31+7)
			})

			if got, want := replayed.index.Entries(), plain.index.Entries(); !reflect.DeepEqual(got, want) {
				t.Fatalf("duplicate replay changed index: got %v, want %v", got, want)
			}
			if replayed.cert.Digest() != plain.cert.Digest() {
				t.Fatalf("duplicate replay changed digest: %x != %x",
					replayed.cert.Digest(), plain.cert.Digest())
			}
			if replayed.cert.Commits() != plain.cert.Commits() ||
				replayed.cert.Mutations() != plain.cert.Mutations() {
				t.Fatalf("duplicate replay changed counters: (%d,%d) != (%d,%d)",
					replayed.cert.Commits(), replayed.cert.Mutations(),
					plain.cert.Commits(), plain.cert.Mutations())
			}
			if replayed.cert.Barrier() != plain.cert.Barrier() {
				t.Fatalf("duplicate replay changed barrier: %d != %d",
					replayed.cert.Barrier(), plain.cert.Barrier())
			}
		})
	}
}

func TestGeneratedSchedulesWithSmallPages(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		sch := schedgen.Generate(seed, schedgen.Options{
			Keys:     12,
			Pre:      6,
			Crossing: 5,
			Post:     8,
		})
		t.Run(fmt.Sprintf("seed_%03d", seed), func(t *testing.T) {
			// executeSchedule uses BatchSize 3; the duplicate wrapper also
			// injects stale records, forcing multi-page drains.
			executeSchedule(t, sch, func(log ChangeLog) ChangeLog {
				return newDuplicateLog(log, seed+1000)
			})
		})
	}
}
