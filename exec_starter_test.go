package executor

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestHelperProcess is re-executed as a real child process by the
// ExecStarter integration tests.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER") != "1" {
		return
	}
	if os.Getenv("HELPER_SLEEP") == "1" {
		fmt.Fprint(os.Stdout, "before-sleep")
		time.Sleep(30 * time.Second)
		return
	}
	fmt.Fprint(os.Stdout, "hello-stdout")
	fmt.Fprint(os.Stderr, "hello-stderr")
	os.Exit(3)
}

func helperStarter(env ...string) ExecStarter {
	return ExecStarter{
		Name: os.Args[0],
		Args: []string{"-test.run=TestHelperProcess"},
		Env:  append(os.Environ(), env...),
	}
}

func TestExecStarterExit(t *testing.T) {
	res, err := Run(context.Background(), helperStarter("GO_WANT_HELPER=1"), Options{
		StdoutBudget: 1 << 16,
		StderrBudget: 1 << 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateExited || res.ExitCode != 3 {
		t.Fatalf("state=%v code=%d", res.State, res.ExitCode)
	}
	if got := string(append(res.Stdout.Prefix(), res.Stdout.Tail()...)); got != "hello-stdout" {
		t.Fatalf("stdout = %q", got)
	}
	if got := string(append(res.Stderr.Prefix(), res.Stderr.Tail()...)); got != "hello-stderr" {
		t.Fatalf("stderr = %q", got)
	}
}

func TestExecStarterTimeout(t *testing.T) {
	res, err := Run(context.Background(), helperStarter("GO_WANT_HELPER=1", "HELPER_SLEEP=1"), Options{
		Timeout:      100 * time.Millisecond,
		StdoutBudget: 1 << 16,
		StderrBudget: 1 << 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateTimeout {
		t.Fatalf("state = %v, want timeout", res.State)
	}
	if got := string(append(res.Stdout.Prefix(), res.Stdout.Tail()...)); !strings.Contains(got, "before-sleep") {
		t.Fatalf("stdout = %q", got)
	}
}
