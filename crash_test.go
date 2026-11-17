package formal

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"
)

var errInjectedCrash = errors.New("test: injected crash")

type crashMode int

const (
	crashBefore crashMode = iota
	crashAfter
)

func (m crashMode) String() string {
	switch m {
	case crashBefore:
		return "before"
	case crashAfter:
		return "after"
	default:
		return fmt.Sprintf("crashMode(%d)", int(m))
	}
}

// crashingStore models a process that dies at a store operation boundary.
//
// crashBefore means the operation never reached durable storage. crashAfter
// means it completed durably but the caller never observed the result, which
// is the important "commit then crash" case for manifest publication and
// shard retries. Once a crash has happened every later operation also fails.
type crashingStore struct {
	inner   Store
	crashAt int
	mode    crashMode
	calls   int
	dead    bool
}

func (s *crashingStore) begin() error {
	if s.dead {
		return errInjectedCrash
	}
	s.calls++
	if s.calls == s.crashAt && s.mode == crashBefore {
		s.dead = true
		return errInjectedCrash
	}
	return nil
}

func (s *crashingStore) finish() error {
	if s.calls == s.crashAt && s.mode == crashAfter {
		s.dead = true
		return errInjectedCrash
	}
	return nil
}

func (s *crashingStore) Get(ctx context.Context, key string) (Object, error) {
	if err := s.begin(); err != nil {
		return Object{}, err
	}
	obj, err := s.inner.Get(ctx, key)
	if crashErr := s.finish(); crashErr != nil {
		return Object{}, crashErr
	}
	return obj, err
}

func (s *crashingStore) Put(ctx context.Context, key string, data []byte, cond Condition) (Object, error) {
	if err := s.begin(); err != nil {
		return Object{}, err
	}
	obj, err := s.inner.Put(ctx, key, data, cond)
	if crashErr := s.finish(); crashErr != nil {
		return Object{}, crashErr
	}
	return obj, err
}

type commitFlow struct {
	step       uint64
	generation uint64
	payloads   [][]byte
}

func (f commitFlow) run(ctx context.Context, store Store, policy RetryPolicy) (CommitResult, error) {
	for rank, payload := range f.payloads {
		uploader := &Uploader{
			Store:      store,
			Step:       f.step,
			Generation: f.generation,
			Rank:       rank,
			Retry:      policy,
		}
		if _, err := uploader.Upload(ctx, payload); err != nil {
			return CommitResult{}, err
		}
	}
	return (&Coordinator{
		Store:      store,
		Step:       f.step,
		Generation: f.generation,
		Ranks:      len(f.payloads),
		Retry:      policy,
	}).Commit(ctx)
}

func (f commitFlow) operationCount(t *testing.T, store Store, policy RetryPolicy) int {
	t.Helper()
	probe := &crashingStore{inner: store}
	if _, err := f.run(context.Background(), probe, policy); err != nil {
		t.Fatalf("probe run: %v", err)
	}
	return probe.calls
}

// inspectPublished distinguishes "no manifest was ever published" from "a
// manifest exists and must therefore pass full verification".
func inspectPublished(t *testing.T, store Store, step uint64, policy RetryPolicy) (bool, Manifest) {
	t.Helper()
	manifest, err := VerifyStep(context.Background(), store, step, VerifyOptions{Retry: policy})
	if err == nil {
		return true, manifest
	}
	if errors.Is(err, ErrNotFound) {
		return false, Manifest{}
	}
	t.Fatalf("manifest visible after crash but invalid: %v", err)
	return false, Manifest{}
}

func runCrashMatrix(t *testing.T, flow commitFlow, delay int64, policy func(*MemStore) RetryPolicy) {
	t.Helper()
	ctx := context.Background()
	probeStore := NewMemStore(delay)
	total := flow.operationCount(t, probeStore, policy(probeStore))

	var publishedRuns atomic.Int64
	for _, mode := range []crashMode{crashBefore, crashAfter} {
		for crashAt := 1; crashAt <= total; crashAt++ {
			crashAt, mode := crashAt, mode
			t.Run(fmt.Sprintf("%s-op-%02d", mode, crashAt), func(t *testing.T) {
				base := NewMemStore(delay)
				retry := policy(base)
				crashed := &crashingStore{inner: base, crashAt: crashAt, mode: mode}

				if _, err := flow.run(ctx, crashed, retry); !errors.Is(err, errInjectedCrash) {
					t.Fatalf("run with crash at operation %d: got %v, want injected crash", crashAt, err)
				}

				published, manifest := inspectPublished(t, base, flow.step, retry)
				if published {
					publishedRuns.Add(1)
					if manifest.Step != flow.step ||
						manifest.Generation != flow.generation ||
						manifest.RankCount != len(flow.payloads) {
						t.Fatalf("published manifest has wrong identity: %#v", manifest)
					}
				}

				// Restart with a healthy connection to the same durable store.
				result, err := flow.run(ctx, base, retry)
				if err != nil {
					t.Fatalf("retry after crash at operation %d: %v", crashAt, err)
				}
				if published {
					if result.Created {
						t.Fatal("retry republished an already-published step")
					}
					if !reflect.DeepEqual(result.Manifest, manifest) {
						t.Fatal("retry changed the published manifest")
					}
				} else if !result.Created {
					t.Fatal("retry adopted a manifest that was never published")
				}

				final := mustVerifyStep(t, base, flow.step, retry)
				if !reflect.DeepEqual(final, result.Manifest) {
					t.Fatal("final manifest does not match retry result")
				}
			})
		}
	}
	if publishedRuns.Load() == 0 {
		t.Fatal("crash matrix never observed a published manifest")
	}
}

func TestCrashPointEnumeration(t *testing.T) {
	flow := commitFlow{
		step:       77,
		generation: 4,
		payloads:   testPayloads(3),
	}
	runCrashMatrix(t, flow, 0, func(*MemStore) RetryPolicy { return noRetry() })
}

func TestCrashPointEnumerationWithVisibilityDelay(t *testing.T) {
	flow := commitFlow{
		step:       78,
		generation: 5,
		payloads:   testPayloads(3),
	}
	runCrashMatrix(t, flow, 3, tickRetry)
}
