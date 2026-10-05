package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeJSON(t *testing.T, dir, name string, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCLIEndToEnd(t *testing.T) {
	dir := t.TempDir()
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	manifestPath := writeJSON(t, dir, "full.json", m)
	// Feed packages in reverse order; the CLI must resolve the chain itself.
	pkgArgs := []string{}
	for i := len(chain) - 1; i >= 0; i-- {
		pkgArgs = append(pkgArgs, writeJSON(t, dir, "pkg"+string(rune('0'+i))+".json", chain[i]))
	}

	_, wantDigest, err := RestoreSerial(m, chain)
	if err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run(append([]string{"-manifest", manifestPath}, pkgArgs...), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "digest: "+wantDigest) {
		t.Fatalf("stdout missing final digest:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "object: gamma version=1") {
		t.Fatalf("stdout missing restored object:\n%s", stdout.String())
	}
}

func TestCLIReportsEarliestInvalidEdge(t *testing.T) {
	dir := t.TempDir()
	m := baseManifest()
	chain := buildChain(t, m, chainTemplates())
	manifestPath := writeJSON(t, dir, "full.json", m)
	// Omit the middle package: invalidation at edge 1.
	p0 := writeJSON(t, dir, "p0.json", chain[0])
	p2 := writeJSON(t, dir, "p2.json", chain[2])

	var stdout, stderr bytes.Buffer
	code := run([]string{"-manifest", manifestPath, p0, p2}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "edge 1") || !strings.Contains(stderr.String(), string(KindMissingParent)) {
		t.Fatalf("stderr missing earliest edge diagnostic: %s", stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("no partial restore may be printed, got: %s", stdout.String())
	}
}
