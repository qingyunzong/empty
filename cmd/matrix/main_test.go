package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"matrix/matrix"
)

const testSpec = `{
  "dimensions": [
    {"name": "os", "values": ["linux", "mac", "win"]},
    {"name": "browser", "values": ["chrome", "safari"]}
  ],
  "requires": [{"if": {"browser": "safari"}, "then": {"os": "mac"}}]
}`

func TestRunEndToEnd(t *testing.T) {
	dir := t.TempDir()
	specPath := filepath.Join(dir, "spec.json")
	certPath := filepath.Join(dir, "cert.json")
	if err := os.WriteFile(specPath, []byte(testSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := run([]string{"-spec", specPath, "-cert", certPath}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("run exit = %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "certificate verified") {
		t.Errorf("stderr missing verification note: %q", stderr.String())
	}
	data, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	var cert matrix.Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		t.Fatalf("certificate is not valid JSON: %v", err)
	}
	spec, err := matrix.LoadSpec(strings.NewReader(testSpec))
	if err != nil {
		t.Fatal(err)
	}
	if err := cert.Verify(spec); err != nil {
		t.Fatalf("certificate from CLI does not verify: %v", err)
	}
	// safari only on mac: pair (linux, safari) and (win, safari) uncoverable.
	if len(cert.Uncoverable) != 2 {
		t.Errorf("uncoverable = %+v, want 2 pairs", cert.Uncoverable)
	}
}

func TestRunLimitExceeded(t *testing.T) {
	dir := t.TempDir()
	specPath := filepath.Join(dir, "spec.json")
	var b strings.Builder
	b.WriteString(`{"dimensions":[{"name":"a","values":[`)
	for i := 0; i < 5; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"v` + strings.Repeat("a", i+1) + `"`)
	}
	b.WriteString(`]},{"name":"b","values":[`)
	for i := 0; i < 5; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"w` + strings.Repeat("b", i+1) + `"`)
	}
	b.WriteString(`]}]}`)
	if err := os.WriteFile(specPath, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := run([]string{"-spec", specPath, "-max", "3"}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("run exit = %d, want 1; stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "infeasible") {
		t.Errorf("stderr missing infeasible note: %q", stderr.String())
	}
}

func TestRunBadArgs(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"-bogus"}, &stdout, &stderr); code != 2 {
		t.Errorf("run(-bogus) exit = %d, want 2", code)
	}
}
