package dataeng

import (
	"math/big"
	"strings"
	"testing"

	"example.org/dataeng/q0319/cert"
)

func testRat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rational: " + s)
	}
	return r
}

func mustCompile(t *testing.T, ids []string, y, w []*big.Rat, edges []Edge) *Graph {
	t.Helper()
	g, err := Compile(ids, y, w, edges)
	if err != nil {
		t.Fatalf("compile failed: %v", err)
	}
	return g
}

func rawEdges(g *Graph) []cert.Edge {
	out := make([]cert.Edge, 0)
	for _, e := range g.edges {
		for _, src := range e.sourceIDs {
			out = append(out, cert.Edge{
				EdgeID: src,
				From:   g.ids[e.from],
				To:     g.ids[e.to],
			})
		}
	}
	return out
}

func buildCertificate(t *testing.T, g *Graph, y, w []*big.Rat, res *Result) cert.Certificate {
	t.Helper()
	xm := make(map[string]*big.Rat, g.N())
	for i := 0; i < g.N(); i++ {
		xm[g.ids[i]] = res.x[i]
	}
	lm := make(map[string]*big.Rat, len(g.edges))
	for k, e := range g.edges {
		for _, src := range e.sourceIDs {
			lm[src] = res.lambda[k]
		}
	}
	return cert.Certificate{
		NodeIDs: g.ids,
		Y:       y,
		W:       w,
		Edges:   rawEdges(g),
		X:       xm,
		Lambda:  lm,
		F:       res.f,
	}
}

func assertCertificateValid(t *testing.T, c cert.Certificate) {
	t.Helper()
	if err := cert.Verify(c); err != nil {
		t.Fatalf("certificate rejected: %v", err)
	}
}

func assertCertificateInvalid(t *testing.T, c cert.Certificate, want string) {
	t.Helper()
	err := cert.Verify(c)
	if err == nil {
		t.Fatalf("expected rejection containing %q, certificate was accepted", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q does not contain %q", err.Error(), want)
	}
}
