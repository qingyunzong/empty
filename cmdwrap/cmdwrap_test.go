package cmdwrap

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// TestHelperProcess is not a real test; it is re-executed as a child
// process by the fixtures below to produce controlled behaviors.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_HELPER_PROCESS") != "1" {
		return
	}
	switch os.Getenv("GO_HELPER_MODE") {
	case "echo":
		fmt.Fprint(os.Stdout, os.Getenv("GO_HELPER_STDOUT"))
		fmt.Fprint(os.Stderr, os.Getenv("GO_HELPER_STDERR"))
		os.Exit(0)
	case "exitcode":
		code, _ := strconv.Atoi(os.Getenv("GO_HELPER_EXIT"))
		os.Exit(code)
	case "bigout":
		n, _ := strconv.Atoi(os.Getenv("GO_HELPER_BYTES"))
		chunk := make([]byte, 64*1024)
		for i := range chunk {
			chunk[i] = byte('a' + i%26)
		}
		for _, w := range []io.Writer{os.Stdout, os.Stderr} {
			for written := 0; written < n; {
				m, err := w.Write(chunk)
				if err != nil {
					os.Exit(2)
				}
				written += m
			}
		}
		os.Exit(0)
	case "signal":
		if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
			os.Exit(2)
		}
		select {} // wait to be killed
	case "sleep":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(0)
}

func helper(t *testing.T, mode string, env ...string) Options {
	t.Helper()
	e := append([]string{
		"GO_HELPER_PROCESS=1",
		"GO_HELPER_MODE=" + mode,
	}, env...)
	return Options{
		Name: os.Args[0],
		Args: []string{"-test.run", "^TestHelperProcess$"},
		Env:  append(os.Environ(), e...),
	}
}

func TestRunSuccess(t *testing.T) {
	opts := helper(t, "echo", "GO_HELPER_STDOUT=hello", "GO_HELPER_STDERR=oops")
	res := Run(context.Background(), opts)

	if !res.Success() {
		t.Fatalf("expected success, got state=%v exit=%d err=%v", res.State, res.ExitCode, res.Err)
	}
	if res.State != StateExited || res.ExitCode != 0 {
		t.Fatalf("expected exited/0, got %v/%d", res.State, res.ExitCode)
	}
	if string(res.Stdout) != "hello" || string(res.Stderr) != "oops" {
		t.Fatalf("bad capture: stdout=%q stderr=%q", res.Stdout, res.Stderr)
	}
	if res.StdoutTruncated || res.StderrTruncated {
		t.Fatal("unexpected truncation")
	}
	if res.StartedAt.IsZero() || res.EndedAt.Before(res.StartedAt) {
		t.Fatalf("bad timestamps: %v -> %v", res.StartedAt, res.EndedAt)
	}
	if res.Duration() <= 0 {
		t.Fatalf("bad duration: %v", res.Duration())
	}
}

func TestRunNonZeroExit(t *testing.T) {
	res := Run(context.Background(), helper(t, "exitcode", "GO_HELPER_EXIT=3"))

	if res.State != StateExited || res.ExitCode != 3 {
		t.Fatalf("expected exited/3, got %v/%d", res.State, res.ExitCode)
	}
	if res.Success() {
		t.Fatal("non-zero exit must not be a success")
	}
}

// TestLargeOutputTruncation proves output past the limit is still drained
// (otherwise the child would block on a full pipe and the run would
// deadlock) while the captured buffers stay bounded and flagged.
func TestLargeOutputTruncation(t *testing.T) {
	const (
		total = 8 << 20 // 8 MiB per stream
		limit = 64 << 10
	)
	opts := helper(t, "bigout", "GO_HELPER_BYTES="+strconv.Itoa(total))
	opts.MaxOutputBytes = limit

	done := make(chan *Result, 1)
	go func() { done <- Run(context.Background(), opts) }()

	var res *Result
	select {
	case res = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("run deadlocked on large output")
	}

	if !res.Success() {
		t.Fatalf("expected success, got state=%v err=%v", res.State, res.Err)
	}
	if len(res.Stdout) != limit || len(res.Stderr) != limit {
		t.Fatalf("capture not bounded: stdout=%d stderr=%d", len(res.Stdout), len(res.Stderr))
	}
	if !res.StdoutTruncated || !res.StderrTruncated {
		t.Fatal("expected both streams marked truncated")
	}
}

func TestSignalExit(t *testing.T) {
	res := Run(context.Background(), helper(t, "signal"))

	if res.State != StateSignaled {
		t.Fatalf("expected signaled, got %v (err=%v)", res.State, res.Err)
	}
	if res.Signal != syscall.SIGTERM {
		t.Fatalf("expected SIGTERM, got %v", res.Signal)
	}
	if res.ExitCode != -1 {
		t.Fatalf("signaled run must not record an exit code, got %d", res.ExitCode)
	}
	if res.Success() {
		t.Fatal("signaled run must not be a success")
	}
}

func TestTimeout(t *testing.T) {
	opts := helper(t, "sleep")
	opts.Timeout = 200 * time.Millisecond

	start := time.Now()
	res := Run(context.Background(), opts)
	elapsed := time.Since(start)

	if res.State != StateTimedOut {
		t.Fatalf("expected timed_out, got %v", res.State)
	}
	if !errors.Is(res.Err, ErrTimeout) {
		t.Fatalf("expected ErrTimeout, got %v", res.Err)
	}
	if res.Success() {
		t.Fatal("timed-out run must not be a success")
	}
	if elapsed > 10*time.Second {
		t.Fatalf("kill after timeout took too long (deadlock?): %v", elapsed)
	}
}

func TestCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()

	res := Run(ctx, helper(t, "sleep"))

	if res.State != StateCanceled {
		t.Fatalf("expected canceled, got %v", res.State)
	}
	if !errors.Is(res.Err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", res.Err)
	}
	if res.Success() {
		t.Fatal("canceled run must not be a success")
	}
}

// TestExitBeatsCancel verifies the first terminal event wins: when the
// process exits before the context is canceled, the exit is recorded.
func TestExitBeatsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		time.Sleep(5 * time.Second) // fires long after the fast command exits
		cancel()
	}()

	res := Run(ctx, helper(t, "exitcode", "GO_HELPER_EXIT=0"))

	if res.State != StateExited || res.ExitCode != 0 || !res.Success() {
		t.Fatalf("expected clean exit to win, got %v/%d", res.State, res.ExitCode)
	}
}

func TestStartFailure(t *testing.T) {
	res := Run(context.Background(), Options{Name: "/nonexistent/cmdwrap-binary"})

	if res.State != StateStartFailed {
		t.Fatalf("expected start_failed, got %v", res.State)
	}
	if res.Err == nil {
		t.Fatal("expected a start error")
	}
	if res.Success() {
		t.Fatal("start failure must not be a success")
	}
}

// TestNoExitNoSuccess pins the invariant: without a recorded exit there
// is no success, regardless of how the run ended.
func TestNoExitNoSuccess(t *testing.T) {
	cases := []Result{
		{State: StateSignaled, ExitCode: -1},
		{State: StateTimedOut, ExitCode: -1},
		{State: StateCanceled, ExitCode: -1},
		{State: StateStartFailed, ExitCode: -1},
		{State: StateExited, ExitCode: 1},
	}
	for _, res := range cases {
		if res.Success() {
			t.Errorf("state=%v exit=%d must not be a success", res.State, res.ExitCode)
		}
	}
	ok := Result{State: StateExited, ExitCode: 0}
	if !ok.Success() {
		t.Error("exited/0 must be a success")
	}
}
