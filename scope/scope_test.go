package scope

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// recorder is a thread-safe Tracer that collects events.
type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) Emit(e Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) snapshot() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Event(nil), r.events...)
}

func (r *recorder) kinds() []EventKind {
	var ks []EventKind
	for _, e := range r.snapshot() {
		ks = append(ks, e.Kind)
	}
	return ks
}

func (r *recorder) releases() []string {
	var names []string
	for _, e := range r.snapshot() {
		if e.Kind == EventRelease || e.Kind == EventReleaseFailed {
			names = append(names, e.Name)
		}
	}
	return names
}

func noop(context.Context) error { return nil }

func TestLIFOOrderOnClose(t *testing.T) {
	rec := &recorder{}
	s := New(context.Background(), WithTracer(rec))
	for _, name := range []string{"a", "b", "c"} {
		if err := s.Defer(name, noop); err != nil {
			t.Fatalf("Defer(%q): %v", name, err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got, want := rec.releases(), []string{"c", "b", "a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("release order = %v, want %v", got, want)
	}
}

func TestRunCleansUpOnNormalReturn(t *testing.T) {
	rec := &recorder{}
	err := Run(context.Background(), func(s *Scope) error {
		if err := s.Defer("res", noop); err != nil {
			return err
		}
		return nil
	}, WithTracer(rec))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := rec.releases(); !reflect.DeepEqual(got, []string{"res"}) {
		t.Fatalf("releases = %v", got)
	}
}

func TestRunCleansUpOnErrorAndPreservesPrimary(t *testing.T) {
	primary := errors.New("boom")
	secondary := errors.New("cleanup failed")
	rec := &recorder{}

	err := Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("bad", func(context.Context) error { return secondary })
		return primary
	}, WithTracer(rec))

	if !errors.Is(err, primary) {
		t.Fatalf("primary error lost: %v", err)
	}
	if !errors.Is(err, secondary) {
		t.Fatalf("secondary error not attached: %v", err)
	}
	// Primary must come first in the joined error chain.
	type unwrapper interface{ Unwrap() []error }
	joined, ok := err.(unwrapper)
	if !ok || len(joined.Unwrap()) != 2 || !errors.Is(joined.Unwrap()[0], primary) {
		t.Fatalf("joined error = %v, want primary first", err)
	}
	if got := rec.releases(); !reflect.DeepEqual(got, []string{"bad"}) {
		t.Fatalf("releases = %v", got)
	}
}

func TestRunCleansUpOnPanicAndRepanics(t *testing.T) {
	rec := &recorder{}
	defer func() {
		r := recover()
		if r != "kaboom" {
			t.Fatalf("recover = %v, want kaboom", r)
		}
		if got := rec.releases(); !reflect.DeepEqual(got, []string{"res"}) {
			t.Fatalf("cleanup did not run on panic, releases = %v", got)
		}
	}()
	_ = Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("res", noop)
		panic("kaboom")
	}, WithTracer(rec))
}

func TestRunCleansUpOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	rec := &recorder{}

	err := Run(ctx, func(s *Scope) error {
		_ = s.Defer("res", noop)
		cancel() // cancel mid-block; cleanup must still run
		return ctx.Err()
	}, WithTracer(rec))

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if got := rec.releases(); !reflect.DeepEqual(got, []string{"res"}) {
		t.Fatalf("cleanup did not run on cancel, releases = %v", got)
	}
}

func TestRunWithPreCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := &recorder{}

	err := Run(ctx, func(s *Scope) error {
		t.Fatal("fn must not run with canceled context")
		return nil
	}, WithTracer(rec))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestMultipleCleanupFailuresAllAttached(t *testing.T) {
	primary := errors.New("primary")
	fail1 := errors.New("fail-1")
	fail2 := errors.New("fail-2")

	err := Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("ok", noop)
		_ = s.Defer("bad1", func(context.Context) error { return fail1 })
		_ = s.Defer("bad2", func(context.Context) error { return fail2 })
		return primary
	})

	for _, want := range []error{primary, fail1, fail2} {
		if !errors.Is(err, want) {
			t.Fatalf("err %v missing %v", err, want)
		}
	}
}

func TestResourceRegisteredDuringCleanupIsCleaned(t *testing.T) {
	rec := &recorder{}
	s := New(context.Background(), WithTracer(rec))

	// "outer" is released first (LIFO); its cleanup creates "inner",
	// which must be released before Close returns.
	err := s.Defer("outer", func(context.Context) error {
		return s.Defer("inner", noop)
	})
	if err != nil {
		t.Fatalf("Defer: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got, want := rec.releases(), []string{"outer", "inner"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %v, want %v", got, want)
	}
}

func TestDeferRejectedAfterClose(t *testing.T) {
	rec := &recorder{}
	s := New(context.Background(), WithTracer(rec))
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := s.Defer("late", noop); !errors.Is(err, ErrClosed) {
		t.Fatalf("Defer after Close = %v, want ErrClosed", err)
	}
	var sawRejected bool
	for _, e := range rec.snapshot() {
		if e.Kind == EventAcquireRejected && e.Name == "late" && errors.Is(e.Err, ErrClosed) {
			sawRejected = true
		}
	}
	if !sawRejected {
		t.Fatalf("missing acquire_rejected event, events = %v", rec.snapshot())
	}
}

func TestDeferRejectsNilCallback(t *testing.T) {
	s := New(context.Background())
	if err := s.Defer("nil-fn", nil); !errors.Is(err, ErrNilCleanup) {
		t.Fatalf("Defer(nil) = %v, want ErrNilCleanup", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestCleanupPanicRecoveredAndRemainingCleanupsRun(t *testing.T) {
	rec := &recorder{}
	s := New(context.Background(), WithTracer(rec))
	_ = s.Defer("first", noop)
	_ = s.Defer("panics", func(context.Context) error { panic("cleanup boom") })

	err := s.Close()
	if err == nil || !strings.Contains(err.Error(), "cleanup boom") {
		t.Fatalf("Close err = %v, want panic converted to error", err)
	}
	// "panics" is released (with failure) before "first"; both must run.
	if got, want := rec.releases(), []string{"panics", "first"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %v, want %v", got, want)
	}
}

func TestDoubleCloseReturnsErrClosed(t *testing.T) {
	s := New(context.Background())
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); !errors.Is(err, ErrClosed) {
		t.Fatalf("second Close = %v, want ErrClosed", err)
	}
}

func TestTraceEventSequence(t *testing.T) {
	rec := &recorder{}
	secondary := errors.New("nope")
	err := Run(context.Background(), func(s *Scope) error {
		if err := s.Defer("db", noop); err != nil {
			return err
		}
		if err := s.Defer("cache", func(context.Context) error { return secondary }); err != nil {
			return err
		}
		return nil
	}, WithTracer(rec))
	if !errors.Is(err, secondary) {
		t.Fatalf("err = %v, want secondary", err)
	}

	want := []EventKind{
		EventOpen,
		EventAcquire,       // db
		EventAcquire,       // cache
		EventReleaseFailed, // cache (LIFO first, fails)
		EventRelease,       // db
		EventClose,
	}
	if got := rec.kinds(); !reflect.DeepEqual(got, want) {
		t.Fatalf("event kinds = %v, want %v", got, want)
	}
}

func TestConcurrentDeferAndClose(t *testing.T) {
	s := New(context.Background())
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = s.Defer(fmt.Sprintf("res-%d", i), noop)
		}(i)
	}
	wg.Wait()
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
