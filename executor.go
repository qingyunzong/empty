// Package executor runs injectable subprocesses, capturing stdout and stderr
// under per-stream byte budgets (retained prefix and tail, counted middle)
// and resolving each run to exactly one terminal state.
package executor

import (
	"context"
	"io"
	"sync"
	"time"
)

// State is the unique terminal state of a run.
type State int

const (
	// StateExited means the process terminated on its own.
	StateExited State = iota
	// StateTimedOut means the run exceeded the configured timeout.
	StateTimedOut
	// StateCanceled means the caller's context was canceled.
	StateCanceled
)

func (s State) String() string {
	switch s {
	case StateExited:
		return "exited"
	case StateTimedOut:
		return "timed_out"
	case StateCanceled:
		return "canceled"
	}
	return "unknown"
}

// Budget bounds how many bytes of a stream are retained: the leading Prefix
// bytes and the trailing Tail bytes. The middle is only counted.
type Budget struct {
	Prefix int
	Tail   int
}

// Result is the outcome of a run. State, ExitCode, Stdout and Stderr are
// meaningful when Err is nil; Err reports failures to start the process.
type Result struct {
	State    State
	ExitCode int
	Stdout   StreamSummary
	Stderr   StreamSummary
	Err      error
}

// Executor runs commands through an injectable Starter.
type Executor struct {
	Starter Starter
	Timeout time.Duration
	Stdout  Budget
	Stderr  Budget
}

// Run starts the command, drains both streams under their budgets, and
// returns after the process has reached exactly one terminal state and all
// stream resources have been released.
func (e *Executor) Run(ctx context.Context, name string, args ...string) Result {
	runCtx := ctx
	cancel := context.CancelFunc(func() {})
	if e.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, e.Timeout)
	}
	defer cancel()

	proc, err := e.Starter.Start(runCtx, name, args...)
	if err != nil {
		return Result{ExitCode: -1, Err: err}
	}

	stdout := proc.Stdout()
	stderr := proc.Stderr()
	stdoutCap := newCapture(e.Stdout.Prefix, e.Stdout.Tail)
	stderrCap := newCapture(e.Stderr.Prefix, e.Stderr.Tail)

	var drain sync.WaitGroup
	drain.Add(2)
	go func() {
		defer drain.Done()
		io.Copy(stdoutCap, stdout)
		stdout.Close()
	}()
	go func() {
		defer drain.Done()
		io.Copy(stderrCap, stderr)
		stderr.Close()
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- proc.Wait() }()

	var state State
	var waitErr error
	select {
	case waitErr = <-waitCh:
		state = StateExited
	case <-runCtx.Done():
		proc.Kill()
		waitErr = <-waitCh
		if ctx.Err() != nil {
			state = StateCanceled
		} else {
			state = StateTimedOut
		}
	}

	// Drain fully and release stream resources before returning.
	drain.Wait()

	return Result{
		State:    state,
		ExitCode: exitCode(waitErr),
		Stdout:   stdoutCap.summary(),
		Stderr:   stderrCap.summary(),
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	if e, ok := err.(interface{ ExitCode() int }); ok {
		return e.ExitCode()
	}
	return -1
}
