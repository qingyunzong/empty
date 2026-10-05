package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeStream is an io.Pipe-backed stream that records whether it was closed.
type fakeStream struct {
	*io.PipeReader
	closed atomic.Bool
}

func (s *fakeStream) Close() error {
	s.closed.Store(true)
	return s.PipeReader.Close()
}

// fakeProcess is an injectable Process. Its Wait acts as a barrier: it
// returns only after every scripted byte has been consumed by the reader
// (io.Pipe is synchronous) and, for blocking processes, after Kill.
type fakeProcess struct {
	stdout *fakeStream
	stderr *fakeStream
	outW   *io.PipeWriter
	errW   *io.PipeWriter

	writeDone chan struct{}
	killedCh  chan struct{}
	killOnce  sync.Once
	killed    atomic.Bool

	blockUntilKill bool
	exitErr        error
}

type exitError struct{ code int }

func (e exitError) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e exitError) ExitCode() int { return e.code }

func newFakeProcess(stdout, stderr []byte, blockUntilKill bool, exitErr error) *fakeProcess {
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	p := &fakeProcess{
		stdout:         &fakeStream{PipeReader: outR},
		stderr:         &fakeStream{PipeReader: errR},
		outW:           outW,
		errW:           errW,
		writeDone:      make(chan struct{}),
		killedCh:       make(chan struct{}),
		blockUntilKill: blockUntilKill,
		exitErr:        exitErr,
	}
	var writers sync.WaitGroup
	writers.Add(2)
	go func() {
		defer writers.Done()
		writeScript(outW, stdout)
	}()
	go func() {
		defer writers.Done()
		writeScript(errW, stderr)
	}()
	go func() {
		writers.Wait()
		close(p.writeDone)
	}()
	return p
}

// writeScript writes the script; a nil script means "write until killed".
func writeScript(w *io.PipeWriter, script []byte) {
	if script == nil {
		chunk := bytes.Repeat([]byte("x"), 4096)
		for {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}
	w.Write(script)
	w.Close()
}

func (p *fakeProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *fakeProcess) Stderr() io.ReadCloser { return p.stderr }

func (p *fakeProcess) Wait() error {
	<-p.writeDone // barrier: all scripted output consumed first
	if p.blockUntilKill {
		<-p.killedCh
	}
	return p.exitErr
}

func (p *fakeProcess) Kill() error {
	p.killOnce.Do(func() {
		p.killed.Store(true)
		close(p.killedCh)
		// Emulate process death: write ends close, readers see EOF.
		p.outW.Close()
		p.errW.Close()
	})
	return nil
}

type fakeStarter struct{ proc *fakeProcess }

func (s fakeStarter) Start(context.Context, string, ...string) (Process, error) {
	return s.proc, nil
}

func TestCapturePrefixTailBudgets(t *testing.T) {
	proc := newFakeProcess([]byte("0123456789"), []byte("abc"), false, nil)
	ex := &Executor{
		Starter: fakeStarter{proc},
		Stdout:  Budget{Prefix: 4, Tail: 4},
		Stderr:  Budget{Prefix: 8, Tail: 8},
	}
	res := ex.Run(context.Background(), "fake")

	if res.State != StateExited || res.ExitCode != 0 {
		t.Fatalf("state=%v code=%d", res.State, res.ExitCode)
	}
	if got := string(res.Stdout.Prefix); got != "0123" {
		t.Errorf("stdout prefix = %q, want %q", got, "0123")
	}
	if got := string(res.Stdout.Tail); got != "6789" {
		t.Errorf("stdout tail = %q, want %q", got, "6789")
	}
	if res.Stdout.Total != 10 || res.Stdout.Dropped != 2 {
		t.Errorf("stdout total=%d dropped=%d, want 10/2", res.Stdout.Total, res.Stdout.Dropped)
	}
	// Stream shorter than the budget: everything retained, nothing dropped.
	if got := string(res.Stderr.Prefix); got != "abc" {
		t.Errorf("stderr prefix = %q, want %q", got, "abc")
	}
	if res.Stderr.Total != 3 || res.Stderr.Dropped != 0 {
		t.Errorf("stderr total=%d dropped=%d, want 3/0", res.Stderr.Total, res.Stderr.Dropped)
	}
}

func TestRunExitBarrierAndRelease(t *testing.T) {
	// Large output forces the executor to drain continuously; the fake's
	// Wait barrier only opens once every byte has been consumed.
	stdout := bytes.Repeat([]byte("0123456789abcdef"), 1<<16) // 1 MiB
	stderr := bytes.Repeat([]byte("e"), 1<<15)
	proc := newFakeProcess(stdout, stderr, false, exitError{code: 3})
	ex := &Executor{
		Starter: fakeStarter{proc},
		Stdout:  Budget{Prefix: 16, Tail: 16},
		Stderr:  Budget{Prefix: 4, Tail: 4},
	}
	res := ex.Run(context.Background(), "fake")

	if res.State != StateExited {
		t.Fatalf("state = %v, want exited", res.State)
	}
	if res.ExitCode != 3 {
		t.Errorf("exit code = %d, want 3", res.ExitCode)
	}
	if res.Stdout.Total != int64(len(stdout)) || res.Stderr.Total != int64(len(stderr)) {
		t.Errorf("totals = %d/%d, want %d/%d",
			res.Stdout.Total, res.Stderr.Total, len(stdout), len(stderr))
	}
	if !bytes.Equal(res.Stdout.Prefix, stdout[:16]) || !bytes.Equal(res.Stdout.Tail, stdout[len(stdout)-16:]) {
		t.Errorf("stdout prefix/tail mismatch")
	}
	if res.Stdout.Dropped != int64(len(stdout)-32) {
		t.Errorf("stdout dropped = %d, want %d", res.Stdout.Dropped, len(stdout)-32)
	}
	// Resource release: both streams closed before Run returned.
	if !proc.stdout.closed.Load() || !proc.stderr.closed.Load() {
		t.Errorf("streams not closed: stdout=%v stderr=%v",
			proc.stdout.closed.Load(), proc.stderr.closed.Load())
	}
}

func TestRunTimeoutUniqueTerminalState(t *testing.T) {
	proc := newFakeProcess(nil, nil, true, nil) // writes forever until killed
	ex := &Executor{
		Starter: fakeStarter{proc},
		Timeout: 50 * time.Millisecond,
		Stdout:  Budget{Prefix: 8, Tail: 8},
		Stderr:  Budget{Prefix: 8, Tail: 8},
	}
	res := ex.Run(context.Background(), "fake")

	if res.State != StateTimedOut {
		t.Fatalf("state = %v, want timed_out", res.State)
	}
	if !proc.killed.Load() {
		t.Error("process was not killed on timeout")
	}
	if !proc.stdout.closed.Load() || !proc.stderr.closed.Load() {
		t.Error("streams not closed after timeout")
	}
	if res.Stdout.Total == 0 {
		t.Error("expected drained output before timeout")
	}
}

func TestRunCancelUniqueTerminalState(t *testing.T) {
	proc := newFakeProcess(nil, nil, true, nil)
	ex := &Executor{
		Starter: fakeStarter{proc},
		Timeout: time.Hour, // must not fire first
		Stdout:  Budget{Prefix: 8, Tail: 8},
		Stderr:  Budget{Prefix: 8, Tail: 8},
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	res := ex.Run(ctx, "fake")

	if res.State != StateCanceled {
		t.Fatalf("state = %v, want canceled", res.State)
	}
	if !proc.killed.Load() {
		t.Error("process was not killed on cancel")
	}
	if !proc.stdout.closed.Load() || !proc.stderr.closed.Load() {
		t.Error("streams not closed after cancel")
	}
}

func TestRunRealProcess(t *testing.T) {
	ex := &Executor{
		Starter: ExecStarter{},
		Stdout:  Budget{Prefix: 64, Tail: 64},
		Stderr:  Budget{Prefix: 64, Tail: 64},
	}
	res := ex.Run(context.Background(), "sh", "-c", "printf hello; printf oops >&2")

	if res.State != StateExited || res.ExitCode != 0 {
		t.Fatalf("state=%v code=%d err=%v", res.State, res.ExitCode, res.Err)
	}
	if got := string(res.Stdout.Prefix); got != "hello" {
		t.Errorf("stdout = %q, want %q", got, "hello")
	}
	if got := string(res.Stderr.Prefix); got != "oops" {
		t.Errorf("stderr = %q, want %q", got, "oops")
	}
}

func TestRunRealProcessDrainLargeOutput(t *testing.T) {
	ex := &Executor{
		Starter: ExecStarter{},
		Stdout:  Budget{Prefix: 4, Tail: 4},
		Stderr:  Budget{Prefix: 4, Tail: 4},
	}
	// 4 MiB on stdout would deadlock a non-draining executor (pipe capacity).
	res := ex.Run(context.Background(), "sh", "-c",
		"head -c 4194304 /dev/zero | tr '\\0' 'A'; echo done >&2")

	if res.State != StateExited || res.ExitCode != 0 {
		t.Fatalf("state=%v code=%d err=%v", res.State, res.ExitCode, res.Err)
	}
	if res.Stdout.Total != 4194304 {
		t.Errorf("stdout total = %d, want 4194304", res.Stdout.Total)
	}
	if got := string(res.Stdout.Prefix); got != "AAAA" {
		t.Errorf("stdout prefix = %q, want %q", got, "AAAA")
	}
	if got := string(res.Stdout.Tail); got != "AAAA" {
		t.Errorf("stdout tail = %q, want %q", got, "AAAA")
	}
	if res.Stdout.Dropped != 4194304-8 {
		t.Errorf("stdout dropped = %d, want %d", res.Stdout.Dropped, 4194304-8)
	}
	if !strings.Contains(string(res.Stderr.Prefix), "done") {
		t.Errorf("stderr prefix = %q, want it to contain %q", res.Stderr.Prefix, "done")
	}
}

func TestRunRealProcessTimeout(t *testing.T) {
	ex := &Executor{
		Starter: ExecStarter{},
		Timeout: 100 * time.Millisecond,
		Stdout:  Budget{Prefix: 8, Tail: 8},
		Stderr:  Budget{Prefix: 8, Tail: 8},
	}
	start := time.Now()
	res := ex.Run(context.Background(), "sh", "-c", "sleep 30")

	if res.State != StateTimedOut {
		t.Fatalf("state = %v, want timed_out", res.State)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("took %v, kill+drain should be prompt", elapsed)
	}
}

func TestRunStartError(t *testing.T) {
	ex := &Executor{Starter: ExecStarter{}}
	res := ex.Run(context.Background(), "definitely-not-a-real-binary-xyz")
	if res.Err == nil {
		t.Fatal("expected start error")
	}
}
