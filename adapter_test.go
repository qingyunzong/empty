package protocheck

import (
	"encoding/json"
	"os"
	"testing"
)

// TestExecAdapter drives a helper copy of this test binary speaking the
// JSON-lines adapter protocol.
func TestExecAdapter(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") == "1" {
		serveHelper()
		os.Exit(0)
	}
	os.Setenv("GO_WANT_HELPER_PROCESS", "1")
	defer os.Unsetenv("GO_WANT_HELPER_PROCESS")

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ad, err := NewExecAdapter(exe, "-test.run=TestExecAdapter")
	if err != nil {
		t.Fatalf("NewExecAdapter: %v", err)
	}
	defer ad.Close()

	if err := ad.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if err := ad.Apply("open"); err != nil {
		t.Fatalf("Apply(open): %v", err)
	}
	s, err := ad.State()
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if s != "open" {
		t.Fatalf("state = %q, want %q", s, "open")
	}
	if err := ad.Apply("unlock"); err == nil {
		t.Fatal("expected error for illegal action")
	}
	s, err = ad.State()
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if s != "open" {
		t.Fatalf("state = %q after illegal action, want %q", s, "open")
	}
}

// serveHelper is a minimal door implementation for TestExecAdapter.
func serveHelper() {
	state := "closed"
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var req struct {
			Op     string `json:"op"`
			Action string `json:"action"`
		}
		if err := dec.Decode(&req); err != nil {
			return
		}
		resp := map[string]any{}
		switch req.Op {
		case "reset":
			state = "closed"
			resp["ok"] = true
		case "apply":
			switch {
			case state == "closed" && req.Action == "open":
				state = "open"
				resp["ok"] = true
			case state == "open" && req.Action == "close":
				state = "closed"
				resp["ok"] = true
			default:
				resp["error"] = "illegal action " + req.Action + " in state " + state
			}
		case "state":
			resp["ok"] = true
			resp["state"] = state
		default:
			resp["error"] = "unknown op"
		}
		if err := enc.Encode(resp); err != nil {
			return
		}
	}
}
