// Package executor runs injectable subprocesses while capturing their
// stdout and stderr within per-stream byte budgets. Each run ends in
// exactly one terminal state: exit, timeout, or cancellation.
package executor

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

// State is the unique terminal state of a run.
type State int

const (
	// StateExited means the process finished on its own.
	StateExited State = iota
	// StateTimeout means the run exceeded Options.Timeout and was killed.
	StateTimeout
	// StateCanceled means the caller's context was canceled and the
	// process was killed.
	StateCanceled
)

func (s State) String() string {
	switch s {
	case StateExited:
		return "exited"
	case StateTimeout:
		return "timeout"
	case StateCanceled:
		return "canceled"
	}
	return "unknown"
}

// Process abstracts a started subprocess so tests can inject fakes.
type Process interface {
	Stdout() io.Reader
	Stderr() io.Reader
	// Wait blocks until the process terminates.
	Wait() error
	// Kill terminates the process. It must make Wait return and must
	// eventually cause Stdout/Stderr readers to reach EOF.
	Kill() error
	// Close releases resources after both streams are fully drained.
	Close() error
}

// Starter starts a subprocess. The ctx is the run's context: a Starter
// may fail fast if it is already done, but Run owns timeout/cancel
// handling and killing.
type Starter interface {
	Start(ctx context.Context) (Process, error)
}

// StarterFunc adapts a function to Starter.
type StarterFunc func(ctx context.Context) (Process, error)

// Start implements Starter.
func (f StarterFunc) Start(ctx context.Context) (Process, error) { return f(ctx) }

// Options configures a run.
type Options struct {
	// Timeout bounds the whole run; zero means no timeout.
	Timeout time.Duration
	// StdoutBudget is the byte budget for captured stdout.
	StdoutBudget int
	// StderrBudget is the byte budget for captured stderr.
	StderrBudget int
}

// Result describes a finished run. State holds the unique terminal state.
type Result struct {
	State    State
	ExitCode int   // valid for StateExited; -1 if unavailable
	Err      error // abnormal wait failure; nil for ordinary non-zero exits
	Stdout   *Capture
	Stderr   *Capture
	Duration time.Duration
}

type exitCoder interface {
	ExitCode() int
}

// exitInfo splits a Wait error into an exit code and an abnormal error.
func exitInfo(err error) (code int, werr error) {
	if err == nil {
		return 0, nil
	}
	var ec exitCoder
	if errors.As(err, &ec) {
		return ec.ExitCode(), nil
	}
	return -1, err
}

// Run starts a process via s, drains both streams into budgeted captures,
// and returns the unique terminal state. It never returns before both
// streams are fully drained and the process resources are released.
//
// A non-nil error is returned only when the process fails to start; in
// that case no Result exists and no terminal state was reached.
func Run(ctx context.Context, s Starter, opts Options) (*Result, error) {
	start := time.Now()
	if opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}

	proc, err := s.Start(ctx)
	if err != nil {
		return nil, err
	}

	res := &Result{
		ExitCode: -1,
		Stdout:   NewCapture(opts.StdoutBudget),
		Stderr:   NewCapture(opts.StderrBudget),
	}

	// Drain both streams concurrently so the child never blocks on a
	// full pipe.
	var drain sync.WaitGroup
	drain.Add(2)
	go func() {
		defer drain.Done()
		_, _ = io.Copy(res.Stdout, proc.Stdout())
	}()
	go func() {
		defer drain.Done()
		_, _ = io.Copy(res.Stderr, proc.Stderr())
	}()
	drained := make(chan struct{})
	go func() {
		drain.Wait()
		close(drained)
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- proc.Wait() }()

	// The select below assigns res.State exactly once, guaranteeing a
	// unique terminal state.
	select {
	case werr := <-waitCh:
		res.State = StateExited
		res.ExitCode, res.Err = exitInfo(werr)
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			res.State = StateTimeout
		} else {
			res.State = StateCanceled
		}
		_ = proc.Kill()
		werr := <-waitCh
		res.ExitCode, _ = exitInfo(werr)
	}

	// Barrier: only return after both streams are drained to EOF and
	// the process resources are released.
	<-drained
	_ = proc.Close()
	res.Duration = time.Since(start)
	return res, nil
}
