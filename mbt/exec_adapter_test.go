package mbt

import (
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

// TestHelperProcess is not a real test; it is re-exec'ed as the adapter
// subprocess by TestExecAdapter.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	ad := newFakeAdapter()
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var req Request
		if err := dec.Decode(&req); err != nil {
			os.Exit(0)
		}
		var resp Response
		var err error
		switch req.Op {
		case "reset":
			resp, err = ad.Reset()
		case "state":
			resp, err = ad.State()
		case "apply":
			resp, err = ad.Apply(req.Action)
		default:
			resp = Response{OK: false, Error: "unknown op"}
		}
		if err != nil {
			resp = Response{OK: false, Error: err.Error()}
		}
		if err := enc.Encode(resp); err != nil {
			os.Exit(1)
		}
	}
}

func TestExecAdapter(t *testing.T) {
	c := exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--")
	c.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
	stdin, err := c.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := c.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	ad := &ExecAdapter{cmd: c, stdin: stdin, dec: json.NewDecoder(stdout)}

	resp, err := ad.Reset()
	if err != nil || !resp.OK || resp.State != "A" {
		t.Fatalf("reset = %+v, err=%v", resp, err)
	}
	resp, err = ad.Apply("ab")
	if err != nil || !resp.OK || resp.State != "B" {
		t.Fatalf("apply ab = %+v, err=%v", resp, err)
	}
	resp, err = ad.Apply("ab") // illegal from B
	if err != nil {
		t.Fatal(err)
	}
	if resp.OK || resp.Error == "" {
		t.Fatalf("illegal apply = %+v, want rejection", resp)
	}
	resp, err = ad.State()
	if err != nil || resp.State != "B" {
		t.Fatalf("state after illegal = %+v, want B unchanged", resp)
	}
	if err := ad.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}
