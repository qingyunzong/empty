// Package cmdwrap runs external commands while recording their lifecycle
// (start, output, exit, timeout) with bounded memory use.
//
// Semantics:
//   - stdout/stderr are captured up to a per-stream byte limit; once the
//     limit is reached the child keeps being drained (so it never blocks
//     on a full pipe) but the stream is marked truncated.
//   - A run has exactly one terminal state; the first terminal event
//     (process exit, timeout, context cancel) wins.
//   - Success requires a recorded exit code of 0. A run without an exit
//     (signal, timeout, cancel, start failure) is never a success.
package cmdwrap

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// ErrTimeout is recorded in Result.Err when a run exceeds its Timeout.
var ErrTimeout = errors.New("cmdwrap: command timed out")

// DefaultMaxOutputBytes is the per-stream capture limit used when
// Options.MaxOutputBytes is not positive.
const DefaultMaxOutputBytes = 1 << 20 // 1 MiB

// State is the terminal state of a run.
type State int

const (
	// StateExited means the process exited on its own (any exit code).
	StateExited State = iota
	// StateSignaled means the process was terminated by a signal.
	StateSignaled
	// StateTimedOut means the timeout fired before the process exited.
	StateTimedOut
	// StateCanceled means the context was canceled before the process exited.
	StateCanceled
	// StateStartFailed means the process could not be started at all.
	StateStartFailed
)

func (s State) String() string {
	switch s {
	case StateExited:
		return "exited"
	case StateSignaled:
		return "signaled"
	case StateTimedOut:
		return "timed_out"
	case StateCanceled:
		return "canceled"
	case StateStartFailed:
		return "start_failed"
	}
	return "unknown"
}

// Options describes a command to run.
type Options struct {
	Name string
	Args []string
	Dir  string
	Env  []string // nil inherits the current environment

	// Timeout bounds the whole run; zero means no timeout.
	Timeout time.Duration
	// MaxOutputBytes bounds captured stdout and stderr individually.
	// Non-positive means DefaultMaxOutputBytes.
	MaxOutputBytes int
}

// Result describes a finished run.
type Result struct {
	State    State
	ExitCode int            // -1 when no exit code was recorded
	Signal   syscall.Signal // valid when State == StateSignaled
	Err      error          // ErrTimeout, ctx.Err(), or a start/wait failure

	StartedAt time.Time
	EndedAt   time.Time

	Stdout []byte
	Stderr []byte

	StdoutTruncated bool
	StderrTruncated bool
}

// Duration returns the wall-clock time of the run.
func (r *Result) Duration() time.Duration { return r.EndedAt.Sub(r.StartedAt) }

// Success reports whether the process ran to completion and exited 0.
// A run without a recorded exit (signal, timeout, cancel, start failure)
// is never a success.
func (r *Result) Success() bool {
	return r.State == StateExited && r.ExitCode == 0
}

// limitedWriter captures up to limit bytes and discards the rest while
// always reporting a full write, so the child process never blocks.
type limitedWriter struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.buf.Len()
	switch {
	case remaining <= 0:
		w.truncated = true
	case len(p) <= remaining:
		w.buf.Write(p)
	default:
		w.buf.Write(p[:remaining])
		w.truncated = true
	}
	return len(p), nil
}

// Run executes the command and blocks until the first terminal event:
// process exit, timeout, or context cancellation.
func Run(ctx context.Context, opts Options) *Result {
	res := &Result{ExitCode: -1}

	limit := opts.MaxOutputBytes
	if limit <= 0 {
		limit = DefaultMaxOutputBytes
	}
	stdout := &limitedWriter{limit: limit}
	stderr := &limitedWriter{limit: limit}

	cmd := exec.Command(opts.Name, opts.Args...)
	cmd.Dir = opts.Dir
	if opts.Env != nil {
		cmd.Env = opts.Env
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	res.StartedAt = time.Now()
	if err := cmd.Start(); err != nil {
		res.EndedAt = time.Now()
		res.State = StateStartFailed
		res.Err = err
		return res
	}

	type waitOutcome struct{ err error }
	waitCh := make(chan waitOutcome, 1)
	go func() { waitCh <- waitOutcome{cmd.Wait()} }()

	var timeoutC <-chan time.Time
	if opts.Timeout > 0 {
		timer := time.NewTimer(opts.Timeout)
		defer timer.Stop()
		timeoutC = timer.C
	}

	var waitErr error
	forced := false
	finish := func(out waitOutcome) { waitErr = out.err }

	select {
	case out := <-waitCh:
		finish(out)
	case <-timeoutC:
		// Exit may have raced with the timer; a recorded exit wins.
		select {
		case out := <-waitCh:
			finish(out)
		default:
			forced = true
			res.State = StateTimedOut
			res.Err = ErrTimeout
			_ = cmd.Process.Kill()
			<-waitCh
		}
	case <-ctx.Done():
		// Exit may have raced with cancellation; a recorded exit wins.
		select {
		case out := <-waitCh:
			finish(out)
		default:
			forced = true
			res.State = StateCanceled
			res.Err = ctx.Err()
			_ = cmd.Process.Kill()
			<-waitCh
		}
	}

	res.EndedAt = time.Now()
	res.Stdout = append([]byte(nil), stdout.buf.Bytes()...)
	res.Stderr = append([]byte(nil), stderr.buf.Bytes()...)
	res.StdoutTruncated = stdout.truncated
	res.StderrTruncated = stderr.truncated

	if !forced {
		classify(waitErr, res)
	}
	return res
}

// classify maps the error from cmd.Wait onto the result for runs that
// terminated on their own (not killed by us).
func classify(err error, res *Result) {
	if err == nil {
		res.State = StateExited
		res.ExitCode = 0
		return
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			res.State = StateSignaled
			res.Signal = ws.Signal()
			res.ExitCode = -1
			res.Err = err
			return
		}
		res.State = StateExited
		res.ExitCode = exitErr.ExitCode()
		return
	}
	// No exit recorded; the run cannot be a success.
	res.Err = err
}
