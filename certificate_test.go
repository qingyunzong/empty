package statmatch

import (
	"math/big"
	"strings"
	"testing"
)

func buildCertAligner(t *testing.T) *Aligner {
	t.Helper()
	al := NewAligner(rat(1, 2))
	points := []struct {
		side Side
		id   string
		n, v int64
	}{
		{SideA, "a1", 0, 1}, {SideA, "a2", 1, 2}, {SideA, "a3", 2, 3},
		{SideB, "b1", 0, 1}, {SideB, "b2", 1, 2}, {SideB, "b3", 2, 4},
	}
	for _, p := range points {
		if err := al.AddPoint(p.side, Point{p.id, rat(p.n, 1), p.v}); err != nil {
			t.Fatal(err)
		}
	}
	return al
}

func TestCertificateVerifyAndFormat(t *testing.T) {
	cert, err := buildCertAligner(t).Certificate()
	if err != nil {
		t.Fatal(err)
	}
	s := cert.String()
	for _, want := range []string{
		"max gap: 1/2",
		"a1~b1", "a2~b2", "a3~b3",
		"n=3 Sx=6 Sy=7 Sxx=14 Sxy=17 Syy=21",
		"cov=9 varX=6 varY=14",
		"r=3√21/14",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("certificate missing %q:\n%s", want, s)
		}
	}
}

func TestCertificateUndefined(t *testing.T) {
	al := NewAligner(rat(1, 2))
	if err := al.AddPoint(SideA, Point{"a1", rat(0, 1), 5}); err != nil {
		t.Fatal(err)
	}
	if err := al.AddPoint(SideB, Point{"b1", rat(0, 1), 6}); err != nil {
		t.Fatal(err)
	}
	cert, err := al.Certificate()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cert.String(), "r=undefined") {
		t.Fatalf("want undefined correlation:\n%s", cert.String())
	}
}

func TestCertificateTamperingDetected(t *testing.T) {
	cert, err := buildCertAligner(t).Certificate()
	if err != nil {
		t.Fatal(err)
	}

	tampered := *cert
	tampered.Stats.Cov = big.NewInt(10)
	if err := tampered.Verify(); err == nil {
		t.Fatal("tampered covariance must fail verification")
	}

	tampered = *cert
	tampered.Pairs = cert.Pairs[:1]
	if err := tampered.Verify(); err == nil {
		t.Fatal("tampered matching must fail verification")
	}

	tampered = *cert
	sums := cert.Sums.Clone()
	sums.AddPair(1, 1)
	tampered.Sums = sums
	if err := tampered.Verify(); err == nil {
		t.Fatal("tampered sums must fail verification")
	}
}
