package execcache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func baseRequest() Request {
	return Request{
		Inputs:  map[string][]byte{"main.go": []byte("package main")},
		Source:  []byte("source-v1"),
		Command: []string{"go", "build"},
		Env:     map[string]string{"GOFLAGS": "-mod=mod", "GOOS": "linux"},
	}
}

// promise is a test-controlled execution: it signals when it starts and
// blocks until released, letting tests observe cache behavior mid-flight.
type promise struct {
	started   chan struct{}
	release   chan struct{}
	cancelled chan struct{}
	calls     atomic.Int32
}

func newPromise() *promise {
	return &promise{
		started:   make(chan struct{}),
		release:   make(chan struct{}),
		cancelled: make(chan struct{}),
	}
}

func (p *promise) exec(output string) ExecFunc {
	return func(ctx context.Context) (Result, error) {
		p.calls.Add(1)
		close(p.started)
		select {
		case <-p.release:
			return Result{Output: []byte(output)}, nil
		case <-ctx.Done():
			close(p.cancelled)
			return Result{}, ctx.Err()
		}
	}
}

// waitForWaiters blocks until the in-flight call for req has n waiters.
func waitForWaiters(t *testing.T, c *Cache, req Request, n int) {
	t.Helper()
	key := Key(req)
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		cl, ok := c.inflight[key]
		waiters := 0
		if ok {
			waiters = cl.waiters
		}
		c.mu.Unlock()
		if ok && waiters == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d waiters, have %d", n, waiters)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestKeyCoversEveryFingerprintComponent(t *testing.T) {
	base := baseRequest()
	baseKey := Key(base)

	// Same content, different map insertion order -> same key.
	reordered := baseRequest()
	reordered.Inputs = map[string][]byte{"main.go": []byte("package main")}
	reordered.Env = map[string]string{"GOOS": "linux", "GOFLAGS": "-mod=mod"}
	if got := Key(reordered); got != baseKey {
		t.Fatalf("map order changed key: %s != %s", got, baseKey)
	}

	variants := map[string]Request{
		"inputs":  {Inputs: map[string][]byte{"main.go": []byte("package main // changed")}, Source: base.Source, Command: base.Command, Env: base.Env},
		"source":  {Inputs: base.Inputs, Source: []byte("source-v2"), Command: base.Command, Env: base.Env},
		"command": {Inputs: base.Inputs, Source: base.Source, Command: []string{"go", "test"}, Env: base.Env},
		"env":     {Inputs: base.Inputs, Source: base.Source, Command: base.Command, Env: map[string]string{"GOFLAGS": "-mod=vendor", "GOOS": "linux"}},
	}
	for name, req := range variants {
		if got := Key(req); got == baseKey {
			t.Fatalf("changing %s did not change key", name)
		}
	}
}

func TestConcurrentSameKeySharesOneExecution(t *testing.T) {
	c := New()
	req := baseRequest()
	p := newPromise()

	const n = 8
	results := make([]Result, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Do(context.Background(), req, p.exec("ok"))
		}(i)
	}

	<-p.started
	waitForWaiters(t, c, req, n) // all waiters attached to one call
	close(p.release)
	wg.Wait()

	if got := p.calls.Load(); got != 1 {
		t.Fatalf("exec ran %d times, want 1", got)
	}
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("waiter %d got error: %v", i, errs[i])
		}
		if string(results[i].Output) != "ok" {
			t.Fatalf("waiter %d got %q, want %q", i, results[i].Output, "ok")
		}
	}

	// A later call hits the memoized result without re-executing.
	res, err := c.Do(context.Background(), req, p.exec("other"))
	if err != nil || string(res.Output) != "ok" {
		t.Fatalf("cached call = %q, %v; want ok, nil", res.Output, err)
	}
	if got := p.calls.Load(); got != 1 {
		t.Fatalf("exec ran %d times after cache hit, want 1", got)
	}
}

func TestVersionSwitchInvalidatesCache(t *testing.T) {
	c := New()
	var calls atomic.Int32
	exec := func(ctx context.Context) (Result, error) {
		n := calls.Add(1)
		return Result{Output: []byte(fmt.Sprintf("run-%d", n))}, nil
	}

	req := baseRequest()
	r1, err := c.Do(context.Background(), req, exec)
	if err != nil || string(r1.Output) != "run-1" {
		t.Fatalf("first run = %q, %v", r1.Output, err)
	}
	r2, _ := c.Do(context.Background(), req, exec)
	if string(r2.Output) != "run-1" || calls.Load() != 1 {
		t.Fatalf("same key not cached: %q, calls=%d", r2.Output, calls.Load())
	}

	// Environment summary change -> new key -> re-execution.
	envV2 := baseRequest()
	envV2.Env = map[string]string{"GOFLAGS": "-mod=vendor", "GOOS": "linux"}
	r3, _ := c.Do(context.Background(), envV2, exec)
	if string(r3.Output) != "run-2" || calls.Load() != 2 {
		t.Fatalf("env change reused cache: %q, calls=%d", r3.Output, calls.Load())
	}

	// Source change -> new key -> re-execution.
	srcV2 := baseRequest()
	srcV2.Source = []byte("source-v2")
	r4, _ := c.Do(context.Background(), srcV2, exec)
	if string(r4.Output) != "run-3" || calls.Load() != 3 {
		t.Fatalf("source change reused cache: %q, calls=%d", r4.Output, calls.Load())
	}

	// Original key still serves its own cached result.
	r5, _ := c.Do(context.Background(), req, exec)
	if string(r5.Output) != "run-1" || calls.Load() != 3 {
		t.Fatalf("original key lost its entry: %q, calls=%d", r5.Output, calls.Load())
	}
}

func TestFailureIsNotCached(t *testing.T) {
	c := New()
	req := baseRequest()
	boom := errors.New("boom")
	var calls atomic.Int32
	exec := func(ctx context.Context) (Result, error) {
		if calls.Add(1) == 1 {
			return Result{}, boom
		}
		return Result{Output: []byte("ok")}, nil
	}

	if _, err := c.Do(context.Background(), req, exec); !errors.Is(err, boom) {
		t.Fatalf("first call err = %v, want boom", err)
	}
	res, err := c.Do(context.Background(), req, exec)
	if err != nil || string(res.Output) != "ok" {
		t.Fatalf("retry = %q, %v; want ok, nil", res.Output, err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("exec ran %d times, want 2 (failure must not be cached)", got)
	}
	if _, err := c.Do(context.Background(), req, exec); err != nil {
		t.Fatalf("success should now be cached: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("exec ran %d times, want 2 (success must be cached)", got)
	}
}

func TestConcurrentFailureSharedByWaiters(t *testing.T) {
	c := New()
	req := baseRequest()
	boom := errors.New("boom")
	p := newPromise()
	exec := func(ctx context.Context) (Result, error) {
		p.calls.Add(1)
		close(p.started)
		<-p.release
		return Result{}, boom
	}

	const n = 4
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = c.Do(context.Background(), req, exec)
		}(i)
	}
	<-p.started
	waitForWaiters(t, c, req, n)
	close(p.release)
	wg.Wait()

	if got := p.calls.Load(); got != 1 {
		t.Fatalf("exec ran %d times, want 1", got)
	}
	for i, err := range errs {
		if !errors.Is(err, boom) {
			t.Fatalf("waiter %d err = %v, want boom", i, err)
		}
	}
	// Failure left nothing behind: a new call re-executes.
	p2 := newPromise()
	go func() {
		<-p2.started
		close(p2.release)
	}()
	if _, err := c.Do(context.Background(), req, p2.exec("ok")); err != nil {
		t.Fatalf("post-failure call err = %v", err)
	}
	if got := p2.calls.Load(); got != 1 {
		t.Fatalf("post-failure exec ran %d times, want 1", got)
	}
}

func TestOnlyLastWaiterCancelsUpstream(t *testing.T) {
	c := New()
	req := baseRequest()
	p := newPromise()

	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	err1 := make(chan error, 1)
	err2 := make(chan error, 1)
	go func() { _, err := c.Do(ctx1, req, p.exec("ok")); err1 <- err }()
	<-p.started
	go func() { _, err := c.Do(ctx2, req, p.exec("ok")); err2 <- err }()
	waitForWaiters(t, c, req, 2)

	// First waiter leaves: upstream must keep running.
	cancel1()
	if err := <-err1; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter 1 err = %v, want context.Canceled", err)
	}
	select {
	case <-p.cancelled:
		t.Fatal("upstream cancelled while a waiter remained")
	case <-time.After(50 * time.Millisecond):
	}

	// Last waiter leaves: upstream is cancelled now.
	cancel2()
	if err := <-err2; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter 2 err = %v, want context.Canceled", err)
	}
	select {
	case <-p.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream not cancelled after last waiter left")
	}

	// Cancellation was not cached: a fresh call re-executes.
	p2 := newPromise()
	go func() {
		<-p2.started
		close(p2.release)
	}()
	res, err := c.Do(context.Background(), req, p2.exec("ok"))
	if err != nil || string(res.Output) != "ok" {
		t.Fatalf("post-cancel call = %q, %v; want ok, nil", res.Output, err)
	}
}

func TestCancelledWaiterDoesNotAffectOthers(t *testing.T) {
	c := New()
	req := baseRequest()
	p := newPromise()

	ctx1, cancel1 := context.WithCancel(context.Background())
	err1 := make(chan error, 1)
	res2 := make(chan Result, 1)
	go func() { _, err := c.Do(ctx1, req, p.exec("ok")); err1 <- err }()
	<-p.started
	go func() {
		res, err := c.Do(context.Background(), req, p.exec("ok"))
		if err != nil {
			t.Errorf("waiter 2 err = %v", err)
		}
		res2 <- res
	}()
	waitForWaiters(t, c, req, 2)

	cancel1()
	if err := <-err1; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter 1 err = %v, want context.Canceled", err)
	}
	close(p.release)
	select {
	case res := <-res2:
		if string(res.Output) != "ok" {
			t.Fatalf("waiter 2 got %q, want ok", res.Output)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("remaining waiter never received result")
	}
}
