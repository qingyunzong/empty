package main_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"crashreplay"
)

var (
	binOnce sync.Once
	binPath string
	binErr  error
)

func binary(t *testing.T) string {
	t.Helper()
	binOnce.Do(func() {
		dir, err := os.MkdirTemp("", "crashreplay-bin")
		if err != nil {
			binErr = err
			return
		}
		binPath = filepath.Join(dir, "crashreplay")
		out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput()
		if err != nil {
			binErr = fmt.Errorf("build CLI: %v\n%s", err, out)
		}
	})
	if binErr != nil {
		t.Fatal(binErr)
	}
	return binPath
}

func runCLI(t *testing.T, input string, args ...string) (crashreplay.Report, int) {
	t.Helper()
	cmd := exec.Command(binary(t), args...)
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatalf("run CLI: %v\n%s", err, stderr.String())
	}
	var report crashreplay.Report
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("bad CLI output %q: %v\n%s", stdout.String(), err, stderr.String())
	}
	return report, code
}

// Acceptance: the CLI accepts events deliberately published out of order.
func TestCLIOutOfOrderPublish(t *testing.T) {
	input := strings.Join([]string{
		`{"seq":3,"op":"crash"}`,
		`{"seq":1,"op":"write","key":"a","value":"1"}`,
		`{"seq":2,"op":"sync"}`,
	}, "\n")
	report, code := runCLI(t, input, "-require", "a=1")
	if code != 0 || report.Verdict != crashreplay.VerdictOK {
		t.Fatalf("got code=%d verdict=%s, want ok", code, report.Verdict)
	}
}

func TestCLICounterexample(t *testing.T) {
	input := strings.Join([]string{
		`{"seq":2,"op":"crash"}`,
		`{"seq":1,"op":"write","key":"a","value":"1"}`,
	}, "\n")
	report, code := runCLI(t, input, "-require", "a=1")
	if code != 1 || report.Verdict != crashreplay.VerdictCounterexample {
		t.Fatalf("got code=%d verdict=%s, want counterexample", code, report.Verdict)
	}
	if len(report.Counterexample) != 0 {
		t.Fatalf("want empty-state counterexample, got %v", report.Counterexample)
	}
	if report.Actual == nil {
		t.Fatal("actual recovery result missing from CLI report")
	}
}

func TestCLIUnknownWhenBudgetInsufficient(t *testing.T) {
	var lines []string
	for i := 1; i <= 19; i++ {
		lines = append(lines, fmt.Sprintf(`{"seq":%d,"op":"write","key":"k%d","value":"v"}`, i, i))
	}
	lines = append(lines, `{"seq":20,"op":"crash"}`)
	report, code := runCLI(t, strings.Join(lines, "\n"))
	if code != 2 || report.Verdict != crashreplay.VerdictUnknown {
		t.Fatalf("got code=%d verdict=%s, want unknown", code, report.Verdict)
	}
	if report.UnknownReason == "" {
		t.Fatal("missing unknown reason")
	}
}
