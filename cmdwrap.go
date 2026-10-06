// Package cmdwrap runs external commands and records their lifecycle:
// start time, captured stdout/stderr (with size caps that keep draining),
// exit status, cancellation, and timeouts.
package cmdwrap

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// Options configures a single Run call.
type Options struct {
	// Dir sets the working directory; empty means the current directory.
	Dir string
	// Env sets the environment; nil inherits the parent environment.
	Env []string
	// Timeout bounds the total run time; <= 0 means no timeout.
	Timeout time.Duration
	// MaxStdoutBytes caps captured stdout; <= 0 means unlimited.
	// Output beyond the cap is still drained (never blocking the child)
	// but discarded, and Result.StdoutTruncated is set.
	MaxStdoutBytes int
	// MaxStderrBytes caps captured stderr like MaxStdoutBytes caps stdout.
	MaxStderrBytes int
}

// Result describes one completed command run.
type Result struct {
	Args       []string
	StartedAt  time.Time
	FinishedAt time.Time

	Stdout []byte
	Stderr []byte

	StdoutTruncated bool
	StderrTruncated bool

	// Exited is true only when the OS reported a process exit. A run that
	// never reported an exit (e.g. start failure) can never be Success.
	Exited   bool
	ExitCode int // -1 when unknown (no exit, or terminated by signal)
	Signaled bool
	Signal   string

	// TimedOut and Canceled record which terminal state won the race
	// between context cancellation and process exit. The first terminal
	// state observed wins and is never overwritten.
	TimedOut bool
	Canceled bool

	// Success is true only for an observed clean exit (code 0) that was
	// neither timed out nor canceled.
	Success bool

	// Err holds infrastructure errors (start failures, wait errors).
	Err error
}

// Duration returns the wall-clock time the run took.
func (r *Result) Duration() time.Duration { return r.FinishedAt.Sub(r.StartedAt) }

// cappedBuffer stores at most limit bytes and transparently discards the
// rest while always reporting a full write, so the child never blocks on a
// full pipe even after the cap is hit.
type cappedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.limit > 0 {
		if c.buf.Len() >= c.limit {
			c.truncated = true
			return len(p), nil
		}
		if c.buf.Len()+len(p) > c.limit {
			c.buf.Write(p[:c.limit-c.buf.Len()])
			c.truncated = true
			return len(p), nil
		}
	}
	n, _ := c.buf.Write(p)
	return n, nil
}

// Run executes name with args, records the full lifecycle, and returns the
// result. It always waits for the child to be reaped and for output copying
// to finish, so it cannot leak processes or goroutines.
func Run(ctx context.Context, opts Options, name string, args ...string) *Result {
	res := &Result{
		Args:     append([]string{name}, args...),
		ExitCode: -1,
	}

	if opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}

	cmd := exec.Command(name, args...)
	cmd.Dir = opts.Dir
	if opts.Env != nil {
		cmd.Env = opts.Env
	}
	stdout := &cappedBuffer{limit: opts.MaxStdoutBytes}
	stderr := &cappedBuffer{limit: opts.MaxStderrBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	res.StartedAt = time.Now()
	if err := cmd.Start(); err != nil {
		res.FinishedAt = time.Now()
		res.Err = err
		return res
	}

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	var waitErr error
	select {
	case waitErr = <-waitCh:
		// Process exit is the first terminal state.
	case <-ctx.Done():
		// Cancellation fired; but the exit may already have been reported
		// and merely lost the select race. First terminal state wins.
		select {
		case waitErr = <-waitCh:
		default:
			if opts.Timeout > 0 && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				res.TimedOut = true
			} else {
				res.Canceled = true
			}
			_ = cmd.Process.Kill()
			waitErr = <-waitCh // reap the child and finish draining output
		}
	}
	res.FinishedAt = time.Now()

	res.Stdout = stdout.buf.Bytes()
	res.Stderr = stderr.buf.Bytes()
	res.StdoutTruncated = stdout.truncated
	res.StderrTruncated = stderr.truncated

	switch {
	case waitErr == nil:
		res.Exited = true
		res.ExitCode = 0
	default:
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			res.Exited = true
			res.ExitCode = exitErr.ExitCode()
			if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				res.Signaled = true
				res.Signal = ws.Signal().String()
				res.ExitCode = -1
			}
		} else {
			res.Err = waitErr
		}
	}

	res.Success = res.Exited && !res.Signaled && res.ExitCode == 0 && !res.TimedOut && !res.Canceled
	return res
}
