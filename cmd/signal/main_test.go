package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"signalcli/internal/signal"
)

const tinyProblem = `{
  "cycle": 5,
  "phases": [
    {"name": "A", "min": 2, "cost": [10, 7, 5, 3, 2, 0]},
    {"name": "B", "min": 1, "cost": [12, 8, 6, 4, 2, 0]}
  ],
  "conflicts": [[0, 1]]
}`

func writeTemp(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCLIEndToEnd(t *testing.T) {
	prob := writeTemp(t, "problem.json", tinyProblem)
	certPath := filepath.Join(t.TempDir(), "cert.json")

	var out, errOut bytes.Buffer
	if code := run([]string{"solve", "-f", prob, "-o", certPath}, &out, &errOut); code != 0 {
		t.Fatalf("solve exit %d: %s", code, errOut.String())
	}
	data, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	var cert signal.Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		t.Fatal(err)
	}
	p, err := signal.LoadProblem(prob)
	if err != nil {
		t.Fatal(err)
	}
	if err := signal.Check(p, &cert); err != nil {
		t.Fatalf("CLI certificate does not verify: %v", err)
	}
	ex, err := signal.Exhaustive(p, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Cost != ex.Cost {
		t.Fatalf("solve cost %d != exhaustive cost %d", cert.Cost, ex.Cost)
	}

	out.Reset()
	if code := run([]string{"verify", "-f", prob, "-c", certPath}, &out, &errOut); code != 0 {
		t.Fatalf("verify exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), `"feasible": true`) ||
		!strings.Contains(out.String(), `"optimal": true`) {
		t.Fatalf("unexpected verify output: %s", out.String())
	}

	out.Reset()
	if code := run([]string{"exhaustive", "-f", prob}, &out, &errOut); code != 0 {
		t.Fatalf("exhaustive exit %d: %s", code, errOut.String())
	}
	var exCert signal.Certificate
	if err := json.Unmarshal(out.Bytes(), &exCert); err != nil {
		t.Fatalf("exhaustive output not JSON: %v", err)
	}
	if exCert.Cost != cert.Cost {
		t.Fatalf("exhaustive CLI cost %d != solve cost %d", exCert.Cost, cert.Cost)
	}
}

func TestCLICycleTooLarge(t *testing.T) {
	prob := writeTemp(t, "big.json", `{
  "cycle": 61,
  "phases": [{"name": "A", "min": 1, "cost": []}],
  "conflicts": []
}`)
	var out, errOut bytes.Buffer
	if code := run([]string{"solve", "-f", prob}, &out, &errOut); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if !strings.Contains(errOut.String(), "cycle must be in [1,60]") {
		t.Fatalf("unexpected error: %s", errOut.String())
	}
}

func TestCLIInfeasible(t *testing.T) {
	prob := writeTemp(t, "inf.json", `{
  "cycle": 3,
  "phases": [
    {"name": "A", "min": 2, "cost": [4, 2, 1, 0]},
    {"name": "B", "min": 2, "cost": [4, 2, 1, 0]}
  ],
  "conflicts": [[0, 1]]
}`)
	var out, errOut bytes.Buffer
	if code := run([]string{"solve", "-f", prob}, &out, &errOut); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if !strings.Contains(errOut.String(), "infeasible") {
		t.Fatalf("unexpected error: %s", errOut.String())
	}
}

func TestCLITamperedCertificate(t *testing.T) {
	prob := writeTemp(t, "problem.json", tinyProblem)
	certPath := writeTemp(t, "cert.json", `{
  "cycle": 5, "cost": 0,
  "green": [2, 1],
  "slots": [[0], [0], [1], [], []],
  "optimal": true, "method": "forged"
}`)
	var out, errOut bytes.Buffer
	if code := run([]string{"verify", "-f", prob, "-c", certPath}, &out, &errOut); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if !strings.Contains(errOut.String(), "INFEASIBLE") {
		t.Fatalf("unexpected error: %s", errOut.String())
	}
}

func TestCLIUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(nil, &out, &errOut); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if code := run([]string{"bogus"}, &out, &errOut); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
}
