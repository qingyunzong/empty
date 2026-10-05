package main

import (
	"testing"

	"testplan/solver"
)

// TestExampleInstance solves the built-in example and verifies its
// certificate end to end.
func TestExampleInstance(t *testing.T) {
	inst := exampleInstance()
	res, err := solver.Solve(&inst, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != solver.Optimal {
		t.Fatalf("status = %s, want OPTIMAL", res.Status)
	}
	cert := solver.BuildCertificate(&inst, res)
	if err := solver.VerifyCertificate(&inst, cert, true); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
	if cert.Time > inst.TimeLimit {
		t.Fatalf("time %d exceeds limit %d", cert.Time, inst.TimeLimit)
	}
}
