package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func constrainedSpec() *Spec {
	return &Spec{
		Dimensions: []Dimension{
			{Name: "os", Values: []string{"linux", "win", "mac"}},
			{Name: "browser", Values: []string{"chrome", "safari"}},
			{Name: "db", Values: []string{"mysql", "pg"}},
		},
		Forbidden: []Assignment{
			{"os": "win", "browser": "safari"},
			{"os": "mac", "browser": "chrome"},
		},
		Preconditions: []Precondition{
			{When: Assignment{"db": "mysql"}, Require: Assignment{"os": "linux"}},
		},
	}
}

func TestCertificateRoundTrip(t *testing.T) {
	s := constrainedSpec()
	cert, err := BuildCertificate(s, 30, 20)
	if err != nil {
		t.Fatal(err)
	}
	if bad := VerifyCertificate(s, cert, 20); len(bad) > 0 {
		t.Fatalf("certificate invalid: %v", bad)
	}
	if cert.ConfigCount > 30 {
		t.Fatalf("cap violated: %d configs", cert.ConfigCount)
	}
	// Uncoverable pairs must exist here: (win,safari) and (mac,chrome)
	// are forbidden, and (win|mac, mysql) violate the precondition.
	if len(cert.UncoverablePairs) == 0 {
		t.Fatal("expected uncoverable pairs")
	}
	if len(cert.UncoveredPairs) != 0 {
		t.Fatalf("unexpected uncovered pairs: %v", cert.UncoveredPairs)
	}
	if cert.Minimality == nil {
		t.Fatal("expected minimality check on small universe")
	}
	if !cert.Minimality.Verified {
		t.Fatalf("minimality not verified: %+v", cert.Minimality)
	}
	// Every coverable pair must appear in the coverage list.
	total := len(AllPairs(s))
	if got := len(cert.Coverage) + len(cert.UncoverablePairs) + len(cert.UncoveredPairs); got != total {
		t.Fatalf("categories sum to %d, want %d", got, total)
	}
}

func TestCertificateKnownMinimum(t *testing.T) {
	s := spec3x2()
	cert, err := BuildCertificate(s, 30, 20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Minimality == nil || cert.Minimality.OptimalSize != 4 || cert.ConfigCount != 4 {
		t.Fatalf("3x2 universe: want optimal 4, got %+v (configs=%d)", cert.Minimality, cert.ConfigCount)
	}
	if cert.Minimality.LegalConfigCount != 8 {
		t.Fatalf("want 8 legal configs, got %d", cert.Minimality.LegalConfigCount)
	}
}

func TestCertificateTamperingDetected(t *testing.T) {
	s := constrainedSpec()
	fresh := func() *Certificate {
		cert, err := BuildCertificate(s, 30, 20)
		if err != nil {
			t.Fatal(err)
		}
		return cert
	}

	// 1. Flip a config value into an illegal combination.
	c1 := fresh()
	c1.Configs[0].Values["os"] = "win"
	c1.Configs[0].Values["browser"] = "safari"
	if bad := VerifyCertificate(s, c1, 20); len(bad) == 0 {
		t.Fatal("tampered config not detected")
	}

	// 2. Drop a coverage entry.
	c2 := fresh()
	c2.Coverage = c2.Coverage[1:]
	if bad := VerifyCertificate(s, c2, 20); len(bad) == 0 {
		t.Fatal("dropped coverage entry not detected")
	}

	// 3. Point a coverage entry at a config that lacks the pair.
	c3 := fresh()
	for i := range c3.Coverage {
		c3.Coverage[i].Config = (c3.Coverage[i].Config + 1) % c3.ConfigCount
	}
	if bad := VerifyCertificate(s, c3, 20); len(bad) == 0 {
		t.Fatal("misattributed coverage not detected")
	}

	// 4. Move a covered pair into the uncoverable list.
	c4 := fresh()
	c4.UncoverablePairs = append(c4.UncoverablePairs, c4.Coverage[0].Pair)
	c4.Coverage = c4.Coverage[1:]
	if bad := VerifyCertificate(s, c4, 20); len(bad) == 0 {
		t.Fatal("false uncoverable claim not detected")
	}

	// 5. Lie about the optimal size.
	c5 := fresh()
	c5.Minimality.OptimalSize--
	if bad := VerifyCertificate(s, c5, 20); len(bad) == 0 {
		t.Fatal("false minimality claim not detected")
	}
}

func TestCertificateCapReporting(t *testing.T) {
	s := spec3x2()
	cert, err := BuildCertificate(s, 2, 20)
	if err != nil {
		t.Fatal(err)
	}
	if cert.ConfigCount != 2 {
		t.Fatalf("expected 2 configs, got %d", cert.ConfigCount)
	}
	if len(cert.UncoveredPairs) == 0 {
		t.Fatal("expected uncovered-due-to-cap pairs")
	}
	if bad := VerifyCertificate(s, cert, 20); len(bad) > 0 {
		t.Fatalf("capped certificate invalid: %v", bad)
	}
	// A certificate claiming uncovered pairs without exhausting the cap
	// must be rejected.
	cert.Configs = cert.Configs[:1]
	cert.ConfigCount = 1
	if bad := VerifyCertificate(s, cert, 20); len(bad) == 0 {
		t.Fatal("under-cap uncovered claim not detected")
	}
}

func TestCLIEndToEnd(t *testing.T) {
	dir := t.TempDir()
	specPath := filepath.Join(dir, "spec.json")
	certPath := filepath.Join(dir, "cert.json")
	data, err := json.Marshal(constrainedSpec())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(specPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runSolve([]string{"-spec", specPath, "-cert", certPath}); code != 0 {
		t.Fatalf("solve exited %d", code)
	}
	if code := runVerify([]string{"-spec", specPath, "-cert", certPath}); code != 0 {
		t.Fatalf("verify exited %d", code)
	}
	// Corrupt the certificate: verify must fail.
	raw, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	var cert Certificate
	if err := json.Unmarshal(raw, &cert); err != nil {
		t.Fatal(err)
	}
	cert.Coverage = cert.Coverage[:len(cert.Coverage)/2]
	corrupt, _ := json.Marshal(cert)
	if err := os.WriteFile(certPath, corrupt, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runVerify([]string{"-spec", specPath, "-cert", certPath}); code == 0 {
		t.Fatal("verify accepted corrupted certificate")
	}
}
