package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mbt/mbt"
)

// TestCLIHelperProcess is re-exec'ed as the adapter subprocess by the
// CLI end-to-end tests. It implements the turnstile example protocol;
// TURNSTILE_FAULT=accept makes it accept illegal actions.
func TestCLIHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CLI_HELPER") != "1" {
		return
	}
	state := "locked"
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var req mbt.Request
		if err := dec.Decode(&req); err != nil {
			os.Exit(0)
		}
		snap := func() mbt.Response {
			return mbt.Response{OK: true, State: state}
		}
		var resp mbt.Response
		switch req.Op {
		case "reset":
			state = "locked"
			resp = snap()
		case "state":
			resp = snap()
		case "apply":
			switch req.Action {
			case "coin":
				state = "unlocked"
				resp = snap()
			case "push":
				if state == "locked" && os.Getenv("TURNSTILE_FAULT") != "accept" {
					resp = mbt.Response{OK: false, Error: "turnstile is locked"}
				} else {
					state = "locked"
					resp = snap()
				}
			default:
				resp = mbt.Response{OK: false, Error: "unknown action"}
			}
		default:
			resp = mbt.Response{OK: false, Error: "unknown op"}
		}
		if err := enc.Encode(resp); err != nil {
			os.Exit(1)
		}
	}
}

func cliArgs(t *testing.T, modelPath string, n string) []string {
	t.Helper()
	t.Setenv("GO_WANT_CLI_HELPER", "1")
	return []string{"run", "-model", modelPath, "-n", n, "--",
		os.Args[0], "-test.run=TestCLIHelperProcess", "--"}
}

func exampleModel(t *testing.T) string {
	t.Helper()
	return filepath.Join("..", "..", "examples", "turnstile", "model.json")
}

func TestCLIPass(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(cliArgs(t, exampleModel(t), "3"), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	var rep mbt.Report
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("report not JSON: %v", err)
	}
	if rep.Verdict != "PASS" || !rep.Closed {
		t.Fatalf("verdict=%s closed=%v", rep.Verdict, rep.Closed)
	}
	// push@locked is illegal in the example model and must be probed.
	found := false
	for _, ir := range rep.Illegal {
		if ir.AtState == "locked" && ir.Action == "push" && ir.Rejected && ir.Unchanged {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing illegal probe push@locked: %+v", rep.Illegal)
	}
	// Actual adapter outputs must be retained in the report.
	if len(rep.Sequences) == 0 || len(rep.Sequences[0].Calls) == 0 {
		t.Fatal("report retains no actual call outputs")
	}
}

func TestCLIFailOnFaultyImpl(t *testing.T) {
	t.Setenv("TURNSTILE_FAULT", "accept")
	var stdout, stderr bytes.Buffer
	code := run(cliArgs(t, exampleModel(t), "3"), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit = %d, want 1; stderr:\n%s", code, stderr.String())
	}
	var rep mbt.Report
	json.Unmarshal(stdout.Bytes(), &rep)
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, "accepted by implementation") {
		t.Fatalf("failures:\n%s", joined)
	}
}

func TestCLIInconclusiveOnSmallBudget(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run(cliArgs(t, exampleModel(t), "1"), &stdout, &stderr)
	if code != 3 {
		t.Fatalf("exit = %d, want 3 (INCONCLUSIVE); stderr:\n%s", code, stderr.String())
	}
	var rep mbt.Report
	json.Unmarshal(stdout.Bytes(), &rep)
	if rep.Verdict == "PASS" {
		t.Fatal("PASS reported with unclosed budget")
	}
	if !strings.Contains(stderr.String(), "needs more than 1 steps") {
		t.Fatalf("stderr lacks budget warning:\n%s", stderr.String())
	}
}
