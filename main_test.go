package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestCLIStdinToStdout(t *testing.T) {
	in := `{"rules":[{"id":"r1","cost":2,"actions":["read"]}],"demands":{"read":1}}`
	var out bytes.Buffer
	if err := run(nil, strings.NewReader(in), &out); err != nil {
		t.Fatalf("run: %v", err)
	}
	var rep map[string]any
	if err := json.Unmarshal(out.Bytes(), &rep); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if rep["status"] != "optimal" {
		t.Fatalf("status = %v", rep["status"])
	}
	if rep["cost"] != 2.0 {
		t.Fatalf("cost = %v", rep["cost"])
	}
}

func TestCLIInvalidSpec(t *testing.T) {
	var out bytes.Buffer
	if err := run(nil, strings.NewReader(`{"rules":[{"id":"r1","cost":-1,"actions":["a"]}]}`), &out); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestCLIRejectsUnknownFields(t *testing.T) {
	var out bytes.Buffer
	err := run(nil, strings.NewReader(`{"rules":[],"demands":{},"bogus":1}`), &out)
	if err == nil {
		t.Fatal("expected unknown-field error")
	}
}
