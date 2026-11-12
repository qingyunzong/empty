package mergejoin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

type fixture struct {
	leftRows  []Row[int]
	rightRows []Row[int]
}

// newFixture builds two sorted, paginated input sets with one-sided-only
// keys, unique matches and repeated groups on both sides:
//
//	left-only key 1, shared 2 (3x2), shared 4 (1x4),
//	right-only key 5, shared 7 (2x2).
func newFixture() fixture {
	var leftRows []Row[int]
	var rightRows []Row[int]
	var leftID uint64 = 1
	var rightID uint64 = 1_000_000

	addLeft := func(keys ...int64) {
		for _, key := range keys {
			leftRows = append(leftRows, Row[int]{Key: key, ID: leftID, Payload: int(key) * 10})
			leftID++
		}
	}
	addRight := func(keys ...int64) {
		for _, key := range keys {
			rightRows = append(rightRows, Row[int]{Key: key, ID: rightID, Payload: int(key) * 100})
			rightID++
		}
	}

	addLeft(1, 2, 2, 2, 4, 7, 7)
	addRight(2, 2, 4, 4, 4, 4, 5, 7, 7)

	return fixture{leftRows: leftRows, rightRows: rightRows}
}

// expectedJoin is the full-memory reference join: a Cartesian product per
// matching key in left-row, then right-row order.
func expectedJoin(leftRows, rightRows []Row[int]) []Pair[int, int] {
	rightByKey := map[int64][]Row[int]{}
	for _, row := range rightRows {
		rightByKey[row.Key] = append(rightByKey[row.Key], row)
	}

	var pairs []Pair[int, int]
	for _, left := range leftRows {
		for _, right := range rightByKey[left.Key] {
			pairs = append(pairs, Pair[int, int]{Key: left.Key, Left: left, Right: right})
		}
	}
	return pairs
}

func collectEmitter() (*sync.Mutex, *[]Pair[int, int], EmitFunc[int, int]) {
	var mu sync.Mutex
	var got []Pair[int, int]
	emit := func(_ context.Context, pair Pair[int, int]) (Decision, error) {
		mu.Lock()
		got = append(got, pair)
		mu.Unlock()
		return Proceed, nil
	}
	return &mu, &got, emit
}

func runJoin(t *testing.T, f fixture, cfg Config[int, int], gate *Gate, emit EmitFunc[int, int], pageSize int) (Result, error) {
	t.Helper()
	left := NewSliceStream(append([]Row[int](nil), f.leftRows...), pageSize)
	right := NewSliceStream(append([]Row[int](nil), f.rightRows...), pageSize)

	joiner, err := New(left, right, cfg, emit, func() (Staging[int, int], error) {
		return NewMemStaging[int, int](), nil
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if gate != nil {
		joiner.WithGate(gate)
	}
	return joiner.Run(context.Background())
}

// TestJoinMatchesReference compares the streaming join with the full
// in-memory join across budgets and page sizes, including one-row pages and
// one-row budgets that force every repeated group through staging.
func TestJoinMatchesReference(t *testing.T) {
	f := newFixture()
	want := expectedJoin(f.leftRows, f.rightRows)

	sizer := func(row Row[int]) int { return 8 + len(fmt.Sprint(row.Payload)) }

	cases := []struct {
		name string
		cfg  Config[int, int]
	}{
		{name: "unlimited", cfg: Config[int, int]{}},
		{name: "rows_budget_large", cfg: Config[int, int]{MaxGroupRows: 64}},
		{name: "rows_budget_one", cfg: Config[int, int]{MaxGroupRows: 1}},
		{name: "rows_budget_two", cfg: Config[int, int]{MaxGroupRows: 2}},
		{name: "rows_budget_three", cfg: Config[int, int]{MaxGroupRows: 3}},
		{name: "byte_budget_tiny", cfg: Config[int, int]{
			MaxGroupBytes: 1, LeftSizer: sizer, RightSizer: sizer,
		}},
		{name: "byte_budget_medium", cfg: Config[int, int]{
			MaxGroupBytes: 20, LeftSizer: sizer, RightSizer: sizer,
		}},
	}

	for _, pageSize := range []int{1, 2, 3, 16} {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%s/page%d", tc.name, pageSize), func(t *testing.T) {
				_, got, emit := collectEmitter()
				result, err := runJoin(t, f, tc.cfg, nil, emit, pageSize)
				if err != nil {
					t.Fatalf("Run: %v", err)
				}
				if result.Pairs != len(want) || result.MatchedGroups != 3 {
					t.Fatalf("result=%+v, want pairs=%d groups=3", result, len(want))
				}
				if len(*got) != len(want) {
					t.Fatalf("got %d pairs, want %d", len(*got), len(want))
				}
				for i := range want {
					if (*got)[i] != want[i] {
						t.Fatalf("pair %d mismatch:\n got=%+v\nwant=%+v", i, (*got)[i], want[i])
					}
				}
			})
		}
	}
}

// TestEmptySide checks that a missing side emits nothing and one-sided-only
// keys are skipped without producing pairs.
func TestEmptySide(t *testing.T) {
	f := newFixture()

	t.Run("empty_right", func(t *testing.T) {
		left := NewSliceStream(append([]Row[int](nil), f.leftRows...), 2)
		right := NewSliceStream([]Row[int]{}, 2)
		_, got, emit := collectEmitter()

		joiner, err := New(left, right, Config[int, int]{MaxGroupRows: 1}, emit,
			func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil })
		if err != nil {
			t.Fatal(err)
		}
		result, err := joiner.Run(context.Background())
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if result.Pairs != 0 || result.MatchedGroups != 0 || len(*got) != 0 {
			t.Fatalf("unexpected output: %+v pairs=%d", result, len(*got))
		}
	})

	t.Run("empty_left", func(t *testing.T) {
		left := NewSliceStream([]Row[int]{}, 2)
		right := NewSliceStream(append([]Row[int](nil), f.rightRows...), 2)
		_, got, emit := collectEmitter()

		joiner, err := New(left, right, Config[int, int]{MaxGroupRows: 1}, emit,
			func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil })
		if err != nil {
			t.Fatal(err)
		}
		result, err := joiner.Run(context.Background())
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if result.Pairs != 0 || result.MatchedGroups != 0 || len(*got) != 0 {
			t.Fatalf("unexpected output: %+v pairs=%d", result, len(*got))
		}
	})
}

// waitForPairs polls until the emitter holds at least n pairs.
func waitForPairs(t *testing.T, mu *sync.Mutex, got *[]Pair[int, int], n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		current := len(*got)
		mu.Unlock()
		if current >= n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d pairs", n)
}

// assertStable verifies the output slice does not change for a short window.
func assertStable(t *testing.T, mu *sync.Mutex, got *[]Pair[int, int], n int) {
	t.Helper()
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(*got) != n {
		t.Fatalf("expected output to stay at %d pairs, got %d", n, len(*got))
	}
}

func startJoiner(t *testing.T, f fixture, cfg Config[int, int], gate *Gate, emit EmitFunc[int, int]) (*SliceStream[int], *SliceStream[int], func() (Result, error)) {
	t.Helper()
	left := NewSliceStream(append([]Row[int](nil), f.leftRows...), 1)
	right := NewSliceStream(append([]Row[int](nil), f.rightRows...), 1)

	type runResult struct {
		result Result
		err    error
	}
	done := make(chan runResult, 1)
	go func() {
		joiner, err := New(left, right, cfg, emit,
			func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil })
		if err != nil {
			done <- runResult{err: err}
			return
		}
		if gate != nil {
			joiner.WithGate(gate)
		}
		result, err := joiner.Run(context.Background())
		done <- runResult{result: result, err: err}
	}()

	wait := func() (Result, error) {
		rr := <-done
		return rr.result, rr.err
	}
	return left, right, wait
}

// TestPausePositions pauses at the first, a middle and the final pair, with
// a one-row memory budget so replay crosses staging while paused. Resuming
// must never resend an acknowledged pair.
func TestPausePositions(t *testing.T) {
	f := newFixture()
	want := expectedJoin(f.leftRows, f.rightRows)

	for _, pauseAt := range []int{0, len(want) / 2, len(want) - 1} {
		t.Run(fmt.Sprintf("pause_%d", pauseAt), func(t *testing.T) {
			gate := NewGate()
			var mu sync.Mutex
			var got []Pair[int, int]
			paused := false
			emit := func(_ context.Context, pair Pair[int, int]) (Decision, error) {
				mu.Lock()
				idx := len(got)
				got = append(got, pair)
				shouldPause := idx == pauseAt
				mu.Unlock()

				if shouldPause {
					if paused {
						return Proceed, fmt.Errorf("pause pair %d emitted twice", pauseAt)
					}
					paused = true
					return Pause, nil
				}
				return Proceed, nil
			}

			_, _, wait := startJoiner(t, f, Config[int, int]{MaxGroupRows: 1}, gate, emit)
			waitForPairs(t, &mu, &got, pauseAt+1)
			assertStable(t, &mu, &got, pauseAt+1)
			gate.Resume()

			result, err := wait()
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if result.Pairs != len(want) {
				t.Fatalf("pairs=%d want=%d", result.Pairs, len(want))
			}
			if len(got) != len(want) {
				t.Fatalf("emitted %d pairs, want %d", len(got), len(want))
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("pair %d mismatch after resume:\n got=%+v\nwant=%+v", i, got[i], want[i])
				}
			}
		})
	}
}

// TestPrePausedBlocksThenResumes arms the gate before starting and proves
// the run blocks on the externally paused gate, then resumes without
// dropping or re-emitting any pair.
func TestPrePausedBlocksThenResumes(t *testing.T) {
	f := newFixture()
	want := expectedJoin(f.leftRows, f.rightRows)
	gate := NewGate()
	gate.Pause()

	mu, got, emit := collectEmitter()
	_, _, wait := startJoiner(t, f, Config[int, int]{MaxGroupRows: 2}, gate, emit)

	assertStable(t, mu, got, 0)
	gate.Resume()

	result, err := wait()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Pairs != len(want) || len(*got) != len(want) {
		t.Fatalf("pairs result=%d emitted=%d want=%d", result.Pairs, len(*got), len(want))
	}
	for i := range want {
		if (*got)[i] != want[i] {
			t.Fatalf("pair %d mismatch: got=%+v want=%+v", i, (*got)[i], want[i])
		}
	}
}

// closeTrackingStream wraps SliceStream to observe Close calls.
type closeTrackingStream[P any] struct {
	*SliceStream[P]
	closed chan struct{}
	once   sync.Once
}

func newCloseTrackingStream[P any](rows []Row[P], pageSize int) *closeTrackingStream[P] {
	return &closeTrackingStream[P]{
		SliceStream: NewSliceStream(rows, pageSize),
		closed:      make(chan struct{}),
	}
}

func (s *closeTrackingStream[P]) Close() error {
	err := s.SliceStream.Close()
	s.once.Do(func() { close(s.closed) })
	return err
}

// trackingStaging wraps MemStaging and observes Close.
type trackingStaging struct {
	*MemStaging[int, int]
	closed chan struct{}
	once   sync.Once
}

func (s *trackingStaging) Close() error {
	err := s.MemStaging.Close()
	s.once.Do(func() { close(s.closed) })
	return err
}

// TestCancelClosesInputsAndStaging verifies cancellation aborts the run and
// closes both input streams and the staging handle.
func TestCancelClosesInputsAndStaging(t *testing.T) {
	f := newFixture()
	gate := NewGate()

	left := newCloseTrackingStream(append([]Row[int](nil), f.leftRows...), 1)
	right := newCloseTrackingStream(append([]Row[int](nil), f.rightRows...), 1)
	staging := &trackingStaging{
		MemStaging: NewMemStaging[int, int](),
		closed:     make(chan struct{}),
	}

	emit := func(context.Context, Pair[int, int]) (Decision, error) {
		return Pause, nil
	}

	joiner, err := New(left, right, Config[int, int]{MaxGroupRows: 1}, emit,
		func() (Staging[int, int], error) { return staging, nil })
	if err != nil {
		t.Fatal(err)
	}
	joiner.WithGate(gate)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, runErr := joiner.Run(ctx)
		done <- runErr
	}()

	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("join did not stop after cancellation")
	}

	for _, ch := range []chan struct{}{left.closed, right.closed, staging.closed} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("resource was not closed after cancellation")
		}
	}
}

// truncatingReader drops the last staged row so the replay is incomplete.
type truncatingReader[P any] struct {
	rows []Row[P]
	pos  int
}

func (r *truncatingReader[P]) Next(_ context.Context) (Row[P], error) {
	limit := len(r.rows) - 1
	if r.pos >= limit {
		return Row[P]{}, io.EOF
	}
	row := r.rows[r.pos]
	r.pos++
	return row, nil
}

func (r *truncatingReader[P]) Rewind() error                 { r.pos = 0; return nil }
func (r *truncatingReader[P]) Discard(context.Context) error { r.rows = nil; return nil }
func (r *truncatingReader[P]) Close() error                  { return nil }

type truncatingStaging struct {
	left  map[int64][]Row[int]
	right map[int64][]Row[int]
}

func newTruncatingStaging() *truncatingStaging {
	return &truncatingStaging{
		left:  map[int64][]Row[int]{},
		right: map[int64][]Row[int]{},
	}
}

type mapAppendWriter[P any] struct {
	group map[int64][]Row[P]
	key   int64
}

func (w *mapAppendWriter[P]) Append(_ context.Context, row Row[P]) error {
	w.group[w.key] = append(w.group[w.key], row)
	return nil
}
func (w *mapAppendWriter[P]) Close() error { return nil }

func (s *truncatingStaging) NewLeftWriter(_ context.Context, key int64) (StagingWriter[int], error) {
	return &mapAppendWriter[int]{group: s.left, key: key}, nil
}
func (s *truncatingStaging) NewRightWriter(_ context.Context, key int64) (StagingWriter[int], error) {
	return &mapAppendWriter[int]{group: s.right, key: key}, nil
}
func (s *truncatingStaging) NewLeftReader(_ context.Context, key int64) (StagingReader[int], error) {
	return &truncatingReader[int]{rows: s.left[key]}, nil
}
func (s *truncatingStaging) NewRightReader(_ context.Context, key int64) (StagingReader[int], error) {
	return &truncatingReader[int]{rows: s.right[key]}, nil
}
func (s *truncatingStaging) Close() error { return nil }

// TestTruncationDetected forces a spill with a replay store that loses data;
// the package must return ErrTruncated instead of a silently smaller result.
func TestTruncationDetected(t *testing.T) {
	f := newFixture()
	left := NewSliceStream(append([]Row[int](nil), f.leftRows...), 1)
	right := NewSliceStream(append([]Row[int](nil), f.rightRows...), 1)

	_, got, emit := collectEmitter()
	joiner, err := New(left, right, Config[int, int]{MaxGroupRows: 1}, emit,
		func() (Staging[int, int], error) { return newTruncatingStaging(), nil })
	if err != nil {
		t.Fatal(err)
	}

	_, err = joiner.Run(context.Background())
	if !errors.Is(err, ErrTruncated) {
		t.Fatalf("err=%v, want ErrTruncated", err)
	}
	if len(*got) == 0 {
		t.Fatal("expected some pairs before truncation was detected")
	}
}

// TestUnsortedStream rejects an input breaking the non-decreasing order.
func TestUnsortedStream(t *testing.T) {
	// Pages are individually sorted but keys decrease across the page
	// boundary, on a key that exists on both sides.
	leftRows := []Row[int]{{Key: 7, ID: 1}, {Key: 2, ID: 2}}
	rightRows := []Row[int]{{Key: 2, ID: 9}, {Key: 7, ID: 10}}

	_, _, emit := collectEmitter()
	joiner, err := New(
		NewSliceStream(leftRows, 1),
		NewSliceStream(rightRows, 1),
		Config[int, int]{},
		emit,
		func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := joiner.Run(context.Background()); !errors.Is(err, ErrUnsorted) {
		t.Fatalf("err=%v, want ErrUnsorted", err)
	}
}

// TestUnsortedWithinPage verifies ordering inside a single page as well.
func TestUnsortedWithinPage(t *testing.T) {
	leftRows := []Row[int]{{Key: 7, ID: 1}, {Key: 2, ID: 2}}
	rightRows := []Row[int]{{Key: 2, ID: 9}, {Key: 7, ID: 10}}

	_, _, emit := collectEmitter()
	joiner, err := New(
		NewSliceStream(leftRows, 10),
		NewSliceStream(rightRows, 10),
		Config[int, int]{},
		emit,
		func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := joiner.Run(context.Background()); !errors.Is(err, ErrUnsorted) {
		t.Fatalf("err=%v, want ErrUnsorted", err)
	}
}

// TestEmitError propagates a callback failure.
func TestEmitError(t *testing.T) {
	f := newFixture()
	wantErr := errors.New("consumer failed")
	emitted := 0
	emit := func(context.Context, Pair[int, int]) (Decision, error) {
		emitted++
		return Proceed, wantErr
	}

	_, err := runJoin(t, f, Config[int, int]{}, nil, emit, 2)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err=%v, want %v", err, wantErr)
	}
	if emitted != 1 {
		t.Fatalf("emitter calls=%d, want 1", emitted)
	}
}

// TestInvalidConfig covers constructor validation.
func TestInvalidConfig(t *testing.T) {
	stream := NewSliceStream([]Row[int]{}, 1)
	okEmitter := func(context.Context, Pair[int, int]) (Decision, error) { return Proceed, nil }
	okFactory := func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil }

	if _, err := New(nil, stream, Config[int, int]{}, okEmitter, okFactory); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil left: %v", err)
	}
	if _, err := New(stream, nil, Config[int, int]{}, okEmitter, okFactory); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil right: %v", err)
	}
	if _, err := New(stream, stream, Config[int, int]{}, nil, okFactory); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil emit: %v", err)
	}
	if _, err := New(stream, stream, Config[int, int]{}, okEmitter, nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil staging: %v", err)
	}
	if _, err := New(stream, stream, Config[int, int]{MaxGroupRows: -1}, okEmitter, okFactory); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("negative rows: %v", err)
	}
	if _, err := New(stream, stream, Config[int, int]{MaxGroupBytes: 1}, okEmitter, okFactory); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("byte budget without sizers: %v", err)
	}
}

// TestRunReused ensures a Joiner only runs once.
func TestRunReused(t *testing.T) {
	f := newFixture()
	left := NewSliceStream(append([]Row[int](nil), f.leftRows...), 4)
	right := NewSliceStream(append([]Row[int](nil), f.rightRows...), 4)

	_, _, emit := collectEmitter()
	joiner, err := New(left, right, Config[int, int]{}, emit,
		func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := joiner.Run(context.Background()); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if _, err := joiner.Run(context.Background()); !errors.Is(err, ErrRunReused) {
		t.Fatalf("second run err=%v, want ErrRunReused", err)
	}
}

// TestMemStagingReplayAndDiscard checks repeated rewinds and group cleanup.
func TestMemStagingReplayAndDiscard(t *testing.T) {
	ctx := context.Background()
	staging := NewMemStaging[int, int]()

	writer, err := staging.NewLeftWriter(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	rows := []Row[int]{{Key: 7, ID: 1}, {Key: 7, ID: 2}, {Key: 7, ID: 3}}
	for _, row := range rows {
		if err := writer.Append(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if staging.LeftGroupSize(7) != 3 {
		t.Fatalf("group size=%d, want 3", staging.LeftGroupSize(7))
	}

	reader, err := staging.NewLeftReader(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	for replay := 0; replay < 3; replay++ {
		if err := reader.Rewind(); err != nil {
			t.Fatal(err)
		}
		for i, want := range rows {
			got, err := reader.Next(ctx)
			if err != nil {
				t.Fatalf("replay %d row %d: %v", replay, i, err)
			}
			if got.ID != want.ID {
				t.Fatalf("replay %d row %d: id=%d want=%d", replay, i, got.ID, want.ID)
			}
		}
		if _, err := reader.Next(ctx); !errors.Is(err, io.EOF) {
			t.Fatalf("expected EOF, got %v", err)
		}
	}
	if err := reader.Discard(ctx); err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if staging.LeftGroupSize(7) != 0 {
		t.Fatalf("group size after discard=%d, want 0", staging.LeftGroupSize(7))
	}
	if err := staging.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := staging.NewLeftReader(ctx, 7); !errors.Is(err, ErrClosed) {
		t.Fatalf("reader after close err=%v, want ErrClosed", err)
	}
}

// TestGateLifecycle covers pause/resume/idempotent transitions.
func TestGateLifecycle(t *testing.T) {
	gate := NewGate()
	gate.Wait(nil)

	gate.Pause()
	gate.Pause()
	resumed := make(chan struct{})
	go func() {
		gate.Wait(nil)
		close(resumed)
	}()

	select {
	case <-resumed:
		t.Fatal("Wait returned while paused")
	case <-time.After(20 * time.Millisecond):
	}

	gate.Resume()
	select {
	case <-resumed:
	case <-time.After(time.Second):
		t.Fatal("Resume did not unblock Wait")
	}

	gate.Resume()
	gate.Wait(nil)
}

// TestGateResumeWhenOpen ensures resuming an open gate is harmless and the
// gate can still pause/resume afterwards.
func TestGateResumeWhenOpen(t *testing.T) {
	gate := NewGate()
	gate.Resume() // no pending pause
	gate.Wait(nil)

	gate.Pause()
	gate.Resume()
	gate.Resume() // repeated resume after release
	gate.Wait(nil)
}

// TestByteBudgetExactBoundary verifies spill behavior at the exact byte
// limit and one byte over it.
func TestByteBudgetExactBoundary(t *testing.T) {
	f := newFixture()
	want := expectedJoin(f.leftRows, f.rightRows)
	sizer := func(Row[int]) int { return 10 }

	for _, limit := range []int64{9, 10, 11, 100} {
		t.Run(fmt.Sprintf("limit_%d", limit), func(t *testing.T) {
			cfg := Config[int, int]{
				MaxGroupBytes: limit,
				LeftSizer:     sizer,
				RightSizer:    sizer,
			}
			_, got, emit := collectEmitter()
			result, err := runJoin(t, f, cfg, nil, emit, 1)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if result.Pairs != len(want) || len(*got) != len(want) {
				t.Fatalf("pairs result=%d emitted=%d want=%d",
					result.Pairs, len(*got), len(want))
			}
		})
	}
}

// TestMemStagingReaderForMissingGroup ensures unknown groups read as closed
// rather than silently returning empty data.
func TestMemStagingReaderForMissingGroup(t *testing.T) {
	staging := NewMemStaging[int, int]()
	ctx := context.Background()
	if _, err := staging.NewLeftReader(ctx, 42); !errors.Is(err, ErrClosed) {
		t.Fatalf("missing reader err=%v, want ErrClosed", err)
	}
	if _, err := staging.NewRightReader(ctx, 42); !errors.Is(err, ErrClosed) {
		t.Fatalf("missing reader err=%v, want ErrClosed", err)
	}

	// A writer that is never closed still supports reads of its rows.
	writer, err := staging.NewRightWriter(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ctx, Row[int]{Key: 7, ID: 1}); err != nil {
		t.Fatal(err)
	}
	reader, err := staging.NewRightReader(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	if row, err := reader.Next(ctx); err != nil || row.ID != 1 {
		t.Fatalf("Next row=%+v err=%v", row, err)
	}
	if _, err := reader.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("Next at end err=%v, want EOF", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	// Appending after writer Close is rejected.
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ctx, Row[int]{Key: 7, ID: 2}); !errors.Is(err, ErrClosed) {
		t.Fatalf("append after close err=%v, want ErrClosed", err)
	}
}

// TestGateCanceledWait proves a canceled context unblocks a paused Wait.
func TestGateCanceledWait(t *testing.T) {
	gate := NewGate()
	gate.Pause()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		gate.Wait(ctx.Done())
		close(done)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock gate Wait")
	}
}

// TestSliceStreamClose verifies post-close behavior and paging boundaries.
func TestSliceStreamClose(t *testing.T) {
	stream := NewSliceStream([]Row[int]{{Key: 1, ID: 1}, {Key: 2, ID: 2}}, 1)
	ctx := context.Background()

	page, err := stream.NextPage(ctx)
	if err != nil || len(page) != 1 || page[0].ID != 1 {
		t.Fatalf("first page: %+v err=%v", page, err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.NextPage(ctx); !errors.Is(err, ErrStreamClosed) {
		t.Fatalf("after close err=%v, want ErrStreamClosed", err)
	}
}

// emptyPageStream returns an empty page before the real pages, which the
// cursor must skip without treating as EOF.
type emptyPageStream struct {
	pages [][]Row[int]
	pos   int
}

func (s *emptyPageStream) NextPage(_ context.Context) ([]Row[int], error) {
	if s.pos >= len(s.pages) {
		return nil, io.EOF
	}
	page := s.pages[s.pos]
	s.pos++
	return page, nil
}

func (s *emptyPageStream) Close() error { return nil }

// TestEmptyPagesAndAccessors covers empty page skipping plus small API
// accessors.
func TestEmptyPagesAndAccessors(t *testing.T) {
	if Left.String() != "left" || Right.String() != "right" {
		t.Fatalf("side strings: %q %q", Left, Right)
	}

	left := &emptyPageStream{pages: [][]Row[int]{
		nil,
		{{Key: 5, ID: 1, Payload: 0}},
		{},
		{{Key: 5, ID: 2, Payload: 0}},
	}}
	right := &emptyPageStream{pages: [][]Row[int]{
		{{Key: 5, ID: 9, Payload: 0}},
		nil,
	}}

	_, got, emit := collectEmitter()
	joiner, err := New(left, right, Config[int, int]{}, emit,
		func() (Staging[int, int], error) { return NewMemStaging[int, int](), nil })
	if err != nil {
		t.Fatal(err)
	}
	if joiner.Gate() == nil {
		t.Fatal("Gate() returned nil")
	}
	result, err := joiner.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Pairs != 2 || len(*got) != 2 {
		t.Fatalf("pairs result=%d emitted=%d, want 2", result.Pairs, len(*got))
	}
	ids := [][2]uint64{
		{(*got)[0].Left.ID, (*got)[0].Right.ID},
		{(*got)[1].Left.ID, (*got)[1].Right.ID},
	}
	want := [][2]uint64{{1, 9}, {2, 9}}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("pair %d = %v, want %v", i, ids[i], want[i])
		}
	}
}
