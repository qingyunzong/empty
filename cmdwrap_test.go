package cmdwrap

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestHelperProcess is not a real test; it is re-execed by the fixtures
// below to act as the child program under measurement.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_CMDWRAP_HELPER") != "1" {
		return
	}
	switch os.Getenv("GO_CMDWRAP_MODE") {
	case "echo":
		fmt.Fprint(os.Stdout, "hello-out")
		fmt.Fprint(os.Stderr, "hello-err")
	case "exit3":
		os.Exit(3)
	case "big":
		chunk := bytes.Repeat([]byte("x"), 64<<10)
		for i := 0; i < 64; i++ { // 4 MiB total
			if _, err := os.Stdout.Write(chunk); err != nil {
				os.Exit(1)
			}
		}
	case "signal":
		_ = syscall.Kill(syscall.Getpid(), syscall.SIGTERM)
		select {} // in case the signal is somehow delayed
	case "hang":
		// Spew output continuously, then sleep far beyond any test timeout.
		chunk := bytes.Repeat([]byte("y"), 64<<10)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stdout.Write(chunk); err != nil {
				os.Exit(1) // pipe closed after kill: exit quietly
			}
		}
	}
	os.Exit(0)
}

func helper(t *testing.T, mode string) (string, []string, []string) {
	t.Helper()
	env := append(os.Environ(),
		"GO_CMDWRAP_HELPER=1",
		"GO_CMDWRAP_MODE="+mode,
	)
	return os.Args[0], []string{"-test.run=TestHelperProcess"}, env
}

func TestSuccessRecordsLifecycle(t *testing.T) {
	name, args, env := helper(t, "echo")
	before := time.Now()
	res := Run(context.Background(), Options{Env: env}, name, args...)

	if !res.Success {
		t.Fatalf("expected success, got %+v (err=%v)", res, res.Err)
	}
	if !res.Exited || res.ExitCode != 0 || res.Signaled {
		t.Fatalf("bad exit record: %+v", res)
	}
	if string(res.Stdout) != "hello-out" || string(res.Stderr) != "hello-err" {
		t.Fatalf("bad capture: stdout=%q stderr=%q", res.Stdout, res.Stderr)
	}
	if res.StartedAt.Before(before) || res.FinishedAt.Before(res.StartedAt) {
		t.Fatalf("bad timestamps: %v -> %v", res.StartedAt, res.FinishedAt)
	}
	if res.Duration() <= 0 {
		t.Fatalf("bad duration: %v", res.Duration())
	}
	if res.TimedOut || res.Canceled || res.StdoutTruncated || res.StderrTruncated {
		t.Fatalf("unexpected flags: %+v", res)
	}
}

func TestNonZeroExitIsNotSuccess(t *testing.T) {
	name, args, env := helper(t, "exit3")
	res := Run(context.Background(), Options{Env: env}, name, args...)

	if !res.Exited || res.ExitCode != 3 {
		t.Fatalf("expected exit code 3, got %+v", res)
	}
	if res.Success {
		t.Fatalf("exit 3 must not be success: %+v", res)
	}
}

func TestLargeOutputTruncatesButKeepsDraining(t *testing.T) {
	name, args, env := helper(t, "big")
	const limit = 64 << 10

	start := time.Now()
	res := Run(context.Background(), Options{Env: env, MaxStdoutBytes: limit}, name, args...)
	elapsed := time.Since(start)

	if !res.Success {
		t.Fatalf("expected success, got %+v (err=%v)", res, res.Err)
	}
	if !res.StdoutTruncated {
		t.Fatalf("expected truncation flag, got %+v", res)
	}
	if len(res.Stdout) != limit {
		t.Fatalf("expected exactly %d captured bytes, got %d", limit, len(res.Stdout))
	}
	if !bytes.Equal(res.Stdout, bytes.Repeat([]byte("x"), limit)) {
		t.Fatalf("captured prefix corrupted")
	}
	// 4 MiB against a 64 KiB cap must still drain promptly; if the reader
	// stopped at the cap the child would block on the pipe forever.
	if elapsed > 10*time.Second {
		t.Fatalf("draining took too long (%v); possible pipe deadlock", elapsed)
	}
}

func TestSignalExitIsRecorded(t *testing.T) {
	name, args, env := helper(t, "signal")
	res := Run(context.Background(), Options{Env: env}, name, args...)

	if !res.Exited || !res.Signaled {
		t.Fatalf("expected signaled exit, got %+v", res)
	}
	if !strings.Contains(res.Signal, "terminated") {
		t.Fatalf("expected SIGTERM, got %q", res.Signal)
	}
	if res.ExitCode != -1 {
		t.Fatalf("signaled exit must not invent an exit code, got %d", res.ExitCode)
	}
	if res.Success {
		t.Fatalf("signaled exit must not be success: %+v", res)
	}
}

func TestTimeoutWinsAndDoesNotDeadlock(t *testing.T) {
	name, args, env := helper(t, "hang")

	start := time.Now()
	res := Run(context.Background(), Options{
		Env:            env,
		Timeout:        300 * time.Millisecond,
		MaxStdoutBytes: 16 << 10,
	}, name, args...)
	elapsed := time.Since(start)

	if !res.TimedOut || res.Canceled {
		t.Fatalf("expected timeout terminal state, got %+v", res)
	}
	if res.Success {
		t.Fatalf("timed-out run must not be success: %+v", res)
	}
	if !res.StdoutTruncated {
		t.Fatalf("expected truncated stdout from spewing child, got %+v", res)
	}
	// The child sleeps 30s; a correct kill+reap returns in well under that.
	if elapsed > 5*time.Second {
		t.Fatalf("timeout path took %v; possible deadlock or unreaped child", elapsed)
	}
}

func TestCancelWinsOverExit(t *testing.T) {
	name, args, env := helper(t, "hang")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	res := Run(ctx, Options{Env: env}, name, args...)
	elapsed := time.Since(start)

	if !res.Canceled || res.TimedOut {
		t.Fatalf("expected canceled terminal state, got %+v", res)
	}
	if res.Success {
		t.Fatalf("canceled run must not be success: %+v", res)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("cancel path took %v; possible deadlock", elapsed)
	}
}

func TestExitBeforeCancelKeepsExitState(t *testing.T) {
	// The process exits immediately; the context is already canceled.
	// Whichever terminal state is observed first must win, and the result
	// must never be reported as success-without-exit.
	name, args, env := helper(t, "echo")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	res := Run(ctx, Options{Env: env}, name, args...)

	if res.Canceled && res.TimedOut {
		t.Fatalf("terminal states are mutually exclusive: %+v", res)
	}
	if res.Exited && res.ExitCode == 0 && !res.Canceled && !res.TimedOut && !res.Success {
		t.Fatalf("clean observed exit should be success: %+v", res)
	}
	if !res.Exited && res.Success {
		t.Fatalf("success without observed exit: %+v", res)
	}
}

func TestMissingExitCannotBeSuccess(t *testing.T) {
	res := Run(context.Background(), Options{}, "definitely-not-a-real-binary-cmdwrap")

	if res.Err == nil {
		t.Fatalf("expected start error, got %+v", res)
	}
	if res.Exited {
		t.Fatalf("no exit should be recorded for a start failure: %+v", res)
	}
	if res.Success {
		t.Fatalf("run without observed exit must not be success: %+v", res)
	}
	if res.ExitCode != -1 {
		t.Fatalf("exit code must be unknown (-1), got %d", res.ExitCode)
	}
}
