package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProcess is an injectable Process driven explicitly by the test.
type fakeProcess struct {
	stdout  io.ReadCloser
	stderr  io.ReadCloser
	waitCh  chan error
	killCh  chan struct{}
	killOne sync.Once
	closed  atomic.Int32
}

func newFakeProcess() (*fakeProcess, *io.PipeWriter, *io.PipeWriter) {
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	return &fakeProcess{
		stdout: outR,
		stderr: errR,
		waitCh: make(chan error, 1),
		killCh: make(chan struct{}),
	}, outW, errW
}

func (f *fakeProcess) Stdout() io.Reader { return f.stdout }
func (f *fakeProcess) Stderr() io.Reader { return f.stderr }
func (f *fakeProcess) Wait() error       { return <-f.waitCh }
func (f *fakeProcess) Kill() error {
	f.killOne.Do(func() { close(f.killCh) })
	return nil
}
func (f *fakeProcess) Close() error {
	f.stdout.Close()
	f.stderr.Close()
	f.closed.Add(1)
	return nil
}

type exitError struct{ code int }

func (e exitError) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e exitError) ExitCode() int { return e.code }

func fakeStarter(fp *fakeProcess) Starter {
	return StarterFunc(func(context.Context) (Process, error) { return fp, nil })
}

func TestRunExitZero(t *testing.T) {
	fp, outW, errW := newFakeProcess()
	go func() {
		outW.Write([]byte("out"))
		outW.Close()
		errW.Write([]byte("err"))
		errW.Close()
		fp.waitCh <- nil
	}()
	res, err := Run(context.Background(), fakeStarter(fp), Options{
		StdoutBudget: 1 << 10,
		StderrBudget: 1 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateExited {
		t.Fatalf("state = %v, want exited", res.State)
	}
	if res.ExitCode != 0 || res.Err != nil {
		t.Fatalf("exit code = %d, err = %v", res.ExitCode, res.Err)
	}
	if got := append(res.Stdout.Prefix(), res.Stdout.Tail()...); !bytes.Equal(got, []byte("out")) {
		t.Fatalf("stdout = %q", got)
	}
	if got := append(res.Stderr.Prefix(), res.Stderr.Tail()...); !bytes.Equal(got, []byte("err")) {
		t.Fatalf("stderr = %q", got)
	}
	if fp.closed.Load() != 1 {
		t.Fatalf("Close called %d times, want 1", fp.closed.Load())
	}
}

func TestRunExitNonZero(t *testing.T) {
	fp, outW, errW := newFakeProcess()
	outW.Close()
	errW.Close()
	fp.waitCh <- exitError{code: 3}
	res, err := Run(context.Background(), fakeStarter(fp), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateExited || res.ExitCode != 3 || res.Err != nil {
		t.Fatalf("state=%v code=%d err=%v", res.State, res.ExitCode, res.Err)
	}
}

// TestRunDrainsBeforeReturning is the barrier test: even after the
// process has exited, Run must not return until both streams are fully
// drained, and it must release resources exactly once.
func TestRunDrainsBeforeReturning(t *testing.T) {
	fp, outW, errW := newFakeProcess()

	// The process "exits" immediately, but its stdout is still streaming.
	fp.waitCh <- nil

	chunk := bytes.Repeat([]byte("x"), 4096)
	const chunks = 32
	halfWritten := make(chan struct{})
	finish := make(chan struct{})
	go func() {
		for i := 0; i < chunks/2; i++ {
			outW.Write(chunk)
		}
		close(halfWritten)
		<-finish
		for i := chunks / 2; i < chunks; i++ {
			outW.Write(chunk)
		}
		outW.Close()
		errW.Close()
	}()

	resCh := make(chan *Result, 1)
	go func() {
		res, err := Run(context.Background(), fakeStarter(fp), Options{
			StdoutBudget: 1 << 20,
			StderrBudget: 1 << 20,
		})
		if err != nil {
			t.Error(err)
		}
		resCh <- res
	}()

	<-halfWritten
	// Wait already returned and half the output is buffered, yet Run
	// must still be blocked on the drain barrier.
	select {
	case <-resCh:
		t.Fatal("Run returned before streams were drained")
	case <-time.After(100 * time.Millisecond):
	}

	close(finish)
	var res *Result
	select {
	case res = <-resCh:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after drain completed")
	}

	want := bytes.Repeat(chunk, chunks)
	if got := append(res.Stdout.Prefix(), res.Stdout.Tail()...); !bytes.Equal(got, want) {
		t.Fatalf("stdout length = %d, want %d", len(got), len(want))
	}
	if res.State != StateExited {
		t.Fatalf("state = %v, want exited", res.State)
	}
	if fp.closed.Load() != 1 {
		t.Fatalf("Close called %d times, want 1", fp.closed.Load())
	}
}

func TestRunTimeout(t *testing.T) {
	fp, outW, errW := newFakeProcess()
	// The process only terminates once killed.
	go func() {
		<-fp.killCh
		outW.Close()
		errW.Close()
		fp.waitCh <- exitError{code: -1}
	}()
	res, err := Run(context.Background(), fakeStarter(fp), Options{Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateTimeout {
		t.Fatalf("state = %v, want timeout", res.State)
	}
	select {
	case <-fp.killCh:
	default:
		t.Fatal("process was not killed")
	}
	if fp.closed.Load() != 1 {
		t.Fatalf("Close called %d times, want 1", fp.closed.Load())
	}
}

func TestRunCanceled(t *testing.T) {
	fp, outW, errW := newFakeProcess()
	go func() {
		<-fp.killCh
		outW.Close()
		errW.Close()
		fp.waitCh <- exitError{code: -1}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	res, err := Run(ctx, fakeStarter(fp), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateCanceled {
		t.Fatalf("state = %v, want canceled", res.State)
	}
	if fp.closed.Load() != 1 {
		t.Fatalf("Close called %d times, want 1", fp.closed.Load())
	}
}

func TestRunStreamBudgets(t *testing.T) {
	fp, outW, errW := newFakeProcess()
	stdout := make([]byte, 10000)
	for i := range stdout {
		stdout[i] = byte('a' + i%26)
	}
	stderr := []byte("short error")
	go func() {
		outW.Write(stdout)
		outW.Close()
		errW.Write(stderr)
		errW.Close()
		fp.waitCh <- nil
	}()
	res, err := Run(context.Background(), fakeStarter(fp), Options{
		StdoutBudget: 1000,
		StderrBudget: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Stdout.Prefix(); !bytes.Equal(got, stdout[:500]) {
		t.Fatal("stdout prefix mismatch")
	}
	if got := res.Stdout.Tail(); !bytes.Equal(got, stdout[9500:]) {
		t.Fatal("stdout tail mismatch")
	}
	st := res.Stdout.Stats()
	if st.Total != 10000 || st.Retained != 1000 || st.Dropped != 9000 {
		t.Fatalf("stdout stats = %+v", st)
	}
	// stderr fits the budget: nothing dropped.
	if got := append(res.Stderr.Prefix(), res.Stderr.Tail()...); !bytes.Equal(got, stderr) {
		t.Fatalf("stderr = %q", got)
	}
	if res.Stderr.Stats().Dropped != 0 {
		t.Fatal("stderr should not be truncated")
	}
}

func TestRunStartFailure(t *testing.T) {
	want := fmt.Errorf("cannot start")
	starter := StarterFunc(func(context.Context) (Process, error) { return nil, want })
	res, err := Run(context.Background(), starter, Options{})
	if res != nil || err != want {
		t.Fatalf("res = %v, err = %v", res, err)
	}
}
