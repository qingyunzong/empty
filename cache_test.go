package execcache

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// promise is a test-controlled execution handle: the test decides when
// and how each execution finishes.
type promise struct {
	req  Request
	ctx  context.Context
	done chan struct{}
	res  Result
	err  error
}

func (p *promise) resolve(res Result, err error) {
	p.res, p.err = res, err
	close(p.done)
}

// promiseExecutor is an Executor whose every call creates a promise
// that the test resolves manually.
type promiseExecutor struct {
	mu    sync.Mutex
	calls []*promise
}

func (e *promiseExecutor) Execute(ctx context.Context, req Request) (Result, error) {
	p := &promise{req: req, ctx: ctx, done: make(chan struct{})}
	e.mu.Lock()
	e.calls = append(e.calls, p)
	e.mu.Unlock()
	select {
	case <-p.done:
		return p.res, p.err
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

func (e *promiseExecutor) numCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.calls)
}

func (e *promiseExecutor) call(i int) *promise {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls[i]
}

func waitFor(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", msg)
		}
		time.Sleep(time.Millisecond)
	}
}

func waiterCount(c *Cache, key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cl, ok := c.inflight[key]; ok {
		return cl.waiters
	}
	return 0
}

type doOutcome struct {
	res Result
	err error
}

func doAsync(c *Cache, ctx context.Context, req Request, exec Executor) <-chan doOutcome {
	ch := make(chan doOutcome, 1)
	go func() {
		res, err := c.Do(ctx, req, exec)
		ch <- doOutcome{res, err}
	}()
	return ch
}

func testRequest() Request {
	return Request{
		Inputs:  map[string]string{"main.txt": "hello"},
		Source:  "package main",
		Command: []string{"run", "main.txt"},
		Env:     map[string]string{"MODE": "fast"},
	}
}

func TestKeyCoversInputsSourceCommandEnv(t *testing.T) {
	base := testRequest()
	baseKey := base.Key()

	same := testRequest()
	if same.Key() != baseKey {
		t.Fatal("identical requests must share a key")
	}

	variants := map[string]func(r *Request){
		"inputs":  func(r *Request) { r.Inputs["main.txt"] = "changed" },
		"source":  func(r *Request) { r.Source = "package main // v2" },
		"command": func(r *Request) { r.Command = []string{"run", "--fast", "main.txt"} },
		"env":     func(r *Request) { r.Env["MODE"] = "safe" },
	}
	for name, mutate := range variants {
		r := testRequest()
		mutate(&r)
		if r.Key() == baseKey {
			t.Fatalf("changing %s must change the key", name)
		}
	}
}

func TestConcurrentHitSharesSingleExecution(t *testing.T) {
	c := New()
	exec := &promiseExecutor{}
	req := testRequest()

	const waiters = 8
	outcomes := make([]<-chan doOutcome, waiters)
	for i := range outcomes {
		outcomes[i] = doAsync(c, context.Background(), req, exec)
	}

	waitFor(t, "single upstream execution", func() bool {
		return exec.numCalls() == 1 && waiterCount(c, req.Key()) == waiters
	})

	want := Result{Stdout: []byte("shared output")}
	exec.call(0).resolve(want, nil)

	for i, ch := range outcomes {
		select {
		case o := <-ch:
			if o.err != nil {
				t.Fatalf("waiter %d: unexpected error: %v", i, o.err)
			}
			if string(o.res.Stdout) != string(want.Stdout) {
				t.Fatalf("waiter %d: got %q, want %q", i, o.res.Stdout, want.Stdout)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("waiter %d: timed out", i)
		}
	}

	if got := exec.numCalls(); got != 1 {
		t.Fatalf("expected 1 execution for %d concurrent hits, got %d", waiters, got)
	}

	// A later call with the same key is served from the cache.
	res, err := c.Do(context.Background(), req, exec)
	if err != nil {
		t.Fatalf("cached call: %v", err)
	}
	if string(res.Stdout) != string(want.Stdout) {
		t.Fatalf("cached result = %q, want %q", res.Stdout, want.Stdout)
	}
	if got := exec.numCalls(); got != 1 {
		t.Fatalf("cached call triggered re-execution, calls = %d", got)
	}
}

func TestVersionSwitchForcesReexecution(t *testing.T) {
	c := New()
	exec := &promiseExecutor{}

	run := func(req Request, out string) Result {
		ch := doAsync(c, context.Background(), req, exec)
		callsBefore := exec.numCalls()
		waitFor(t, "execution to start", func() bool {
			return exec.numCalls() == callsBefore+1
		})
		exec.call(callsBefore).resolve(Result{Stdout: []byte(out)}, nil)
		o := <-ch
		if o.err != nil {
			t.Fatalf("unexpected error: %v", o.err)
		}
		return o.res
	}

	v1 := testRequest()
	if res := run(v1, "built with v1"); string(res.Stdout) != "built with v1" {
		t.Fatalf("got %q", res.Stdout)
	}

	// Same key again: served from cache, no new execution.
	if _, err := c.Do(context.Background(), v1, exec); err != nil {
		t.Fatal(err)
	}
	if got := exec.numCalls(); got != 1 {
		t.Fatalf("cache miss on identical key, calls = %d", got)
	}

	// Source version switch: new key, must re-execute.
	v2 := testRequest()
	v2.Source = "package main // version 2"
	if res := run(v2, "built with v2"); string(res.Stdout) != "built with v2" {
		t.Fatalf("got %q", res.Stdout)
	}

	// Environment digest switch: new key, must re-execute.
	v3 := testRequest()
	v3.Env["MODE"] = "safe"
	run(v3, "built with safe env")

	if got := exec.numCalls(); got != 3 {
		t.Fatalf("expected 3 executions after two version switches, got %d", got)
	}

	// The old version's entry remains cached and untouched.
	res, err := c.Do(context.Background(), v1, exec)
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Stdout) != "built with v1" {
		t.Fatalf("old version entry corrupted: %q", res.Stdout)
	}
	if got := exec.numCalls(); got != 3 {
		t.Fatalf("old version should still be cached, calls = %d", got)
	}
}

func TestFailureIsNotCached(t *testing.T) {
	c := New()
	exec := &promiseExecutor{}
	req := testRequest()

	ch := doAsync(c, context.Background(), req, exec)
	waitFor(t, "first execution", func() bool { return exec.numCalls() == 1 })
	exec.call(0).resolve(Result{Stderr: []byte("boom")}, errors.New("build failed"))

	if o := <-ch; o.err == nil {
		t.Fatal("expected error from failing execution")
	}

	// The failure must not be cached: the next call re-executes.
	ch = doAsync(c, context.Background(), req, exec)
	waitFor(t, "re-execution after failure", func() bool { return exec.numCalls() == 2 })
	exec.call(1).resolve(Result{Stdout: []byte("ok now")}, nil)

	o := <-ch
	if o.err != nil {
		t.Fatalf("unexpected error: %v", o.err)
	}
	if string(o.res.Stdout) != "ok now" {
		t.Fatalf("got %q", o.res.Stdout)
	}

	// The success is cached now.
	if _, err := c.Do(context.Background(), req, exec); err != nil {
		t.Fatal(err)
	}
	if got := exec.numCalls(); got != 2 {
		t.Fatalf("success should be cached, calls = %d", got)
	}
}

func TestOnlyLastWaiterCancelStopsUpstream(t *testing.T) {
	c := New()
	exec := &promiseExecutor{}
	req := testRequest()

	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	out1 := doAsync(c, ctx1, req, exec)
	out2 := doAsync(c, ctx2, req, exec)

	waitFor(t, "both waiters attached", func() bool {
		return exec.numCalls() == 1 && waiterCount(c, req.Key()) == 2
	})
	upstream := exec.call(0)

	// First waiter leaves: upstream keeps running.
	cancel1()
	if o := <-out1; !errors.Is(o.err, context.Canceled) {
		t.Fatalf("waiter 1: got %v, want context.Canceled", o.err)
	}
	select {
	case <-upstream.ctx.Done():
		t.Fatal("upstream canceled while a waiter remained")
	case <-time.After(50 * time.Millisecond):
	}

	// Last waiter leaves: upstream is canceled.
	cancel2()
	if o := <-out2; !errors.Is(o.err, context.Canceled) {
		t.Fatalf("waiter 2: got %v, want context.Canceled", o.err)
	}
	waitFor(t, "upstream cancellation", func() bool {
		return upstream.ctx.Err() != nil
	})

	// The canceled call was detached: a new caller starts fresh work.
	ch := doAsync(c, context.Background(), req, exec)
	waitFor(t, "fresh execution after cancellation", func() bool {
		return exec.numCalls() == 2
	})
	exec.call(1).resolve(Result{Stdout: []byte("done")}, nil)
	if o := <-ch; o.err != nil || string(o.res.Stdout) != "done" {
		t.Fatalf("fresh execution: res=%q err=%v", o.res.Stdout, o.err)
	}
}

func TestCommandExecutorEndToEnd(t *testing.T) {
	c := New()
	exec := CommandExecutor{}
	req := Request{
		Source:  "print-greeting-v1",
		Command: []string{"sh", "-c", `printf '%s' "$GREETING"`},
		Env:     map[string]string{"GREETING": "hello"},
	}

	res, err := c.Do(context.Background(), req, exec)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if string(res.Stdout) != "hello" {
		t.Fatalf("got %q, want %q", res.Stdout, "hello")
	}

	// Identical request: served from cache without re-executing.
	res, err = c.Do(context.Background(), req, exec)
	if err != nil {
		t.Fatalf("expected cached result, got error: %v", err)
	}
	if string(res.Stdout) != "hello" {
		t.Fatalf("cached result = %q", res.Stdout)
	}

	// Environment digest change: must re-execute with the new env.
	changed := req
	changed.Env = map[string]string{"GREETING": "goodbye"}
	res, err = c.Do(context.Background(), changed, exec)
	if err != nil {
		t.Fatalf("env-switched run: %v", err)
	}
	if string(res.Stdout) != "goodbye" {
		t.Fatalf("got %q, want %q", res.Stdout, "goodbye")
	}

	// Failing commands are not cached and surface an error.
	failing := req
	failing.Source = "failing-v1"
	failing.Command = []string{"sh", "-c", "echo oops >&2; exit 3"}
	if _, err = c.Do(context.Background(), failing, exec); err == nil {
		t.Fatal("expected error for exit code 3")
	} else if !strings.Contains(err.Error(), "3") {
		t.Fatalf("error should mention exit code: %v", err)
	}
}
