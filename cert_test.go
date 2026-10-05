package main

import (
	"math/rand"
	"reflect"
	"testing"
)

func solvedCert(t *testing.T, g *Graph) *Certificate {
	t.Helper()
	s := NewSolver(g, false)
	s.Run(0)
	if !s.Found {
		t.Skip("instance has no feasible route")
	}
	return BuildCertificate(s)
}

// TestCertificateVerify checks that certificates produced by the solver
// replay cleanly, and that the reported lower bound matches an independent
// exhaustive search.
func TestCertificateVerify(t *testing.T) {
	checked := 0
	for seed := int64(0); seed < 60; seed++ {
		g := RandomGraph(rand.New(rand.NewSource(20000+seed)), tinyConfig(seed))
		s := NewSolver(g, false)
		s.Run(0)
		if !s.Found {
			continue
		}
		cert := BuildCertificate(s)
		if err := VerifyCertificate(g, cert); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if exCost, ok := Exhaustive(g); !ok || exCost != cert.LowerBound {
			t.Fatalf("seed %d: lower bound %d, exhaustive %d (found=%v)",
				seed, cert.LowerBound, exCost, ok)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no feasible instance generated")
	}
}

// TestCertificateTamper ensures the verifier rejects corrupted certificates.
func TestCertificateTamper(t *testing.T) {
	var g *Graph
	var cert *Certificate
	for seed := int64(0); seed < 200; seed++ {
		gg := RandomGraph(rand.New(rand.NewSource(30000+seed)), tinyConfig(seed))
		s := NewSolver(gg, false)
		s.Run(0)
		if s.Found && len(BuildCertificate(s).Steps) >= 1 {
			g, cert = gg, BuildCertificate(s)
			break
		}
	}
	if cert == nil {
		t.Fatal("no feasible instance found")
	}
	bad := *cert
	bad.Cost++
	if err := VerifyCertificate(g, &bad); err == nil {
		t.Fatal("tampered cost accepted")
	}
	bad2 := *cert
	bad2.Steps = append([]CertStep(nil), cert.Steps...)
	bad2.Steps[0].Cost++
	if err := VerifyCertificate(g, &bad2); err == nil {
		t.Fatal("tampered step cost accepted")
	}
	bad3 := *cert
	bad3.Steps = append([]CertStep(nil), cert.Steps...)
	bad3.Steps[0].To.Fuel++
	if err := VerifyCertificate(g, &bad3); err == nil {
		t.Fatal("tampered next-state accepted")
	}
}

// TestCertificateDeterminism makes sure solving twice yields identical
// certificates (tie-breaking is deterministic).
func TestCertificateDeterminism(t *testing.T) {
	g := RandomGraph(rand.New(rand.NewSource(42)), tinyConfig(42))
	c1 := solvedCert(t, g)
	c2 := solvedCert(t, g)
	if c1.Cost != c2.Cost || len(c1.Steps) != len(c2.Steps) {
		t.Fatal("non-deterministic certificate")
	}
	for i := range c1.Steps {
		if !reflect.DeepEqual(c1.Steps[i], c2.Steps[i]) {
			t.Fatalf("step %d differs between runs", i)
		}
	}
}
