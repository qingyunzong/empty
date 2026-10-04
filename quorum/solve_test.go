package quorum

import (
	"math"
	"math/bits"
	"math/rand"
	"testing"
)

func costPtr(v int64) *int64 { return &v }

func exampleInput() *Input {
	return &Input{Nodes: []Node{
		{ID: "a", Weight: 5, Cost: costPtr(4), Domain: "d1", Voter: true},
		{ID: "b", Weight: 4, Cost: costPtr(3), Domain: "d1", Voter: true},
		{ID: "c", Weight: 3, Cost: costPtr(3), Domain: "d2", Voter: true},
		{ID: "d", Weight: 2, Cost: costPtr(2), Domain: "d2", Voter: true},
		{ID: "e", Weight: 1, Cost: costPtr(1), Domain: "d3", Voter: true},
		{ID: "x", Weight: 9, Domain: "d9", Voter: false}, // non-voter: excluded
	}}
}

func TestSolveQuorumExample(t *testing.T) {
	cert, err := SolveQuorum(exampleInput())
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "optimal" {
		t.Fatalf("status = %q, want optimal", cert.Status)
	}
	// Total voter weight is 15, so a legal quorum needs weight >= 8 and
	// >= 2 domains; the cheapest such set costs 7.
	if cert.Cost != 7 {
		t.Fatalf("cost = %d, want 7 (members %v)", cert.Cost, cert.Members)
	}
	if cert.LowerBound != 7 || cert.UpperBound != 7 {
		t.Fatalf("bounds = [%d, %d], want [7, 7]", cert.LowerBound, cert.UpperBound)
	}
	if !cert.Weight.Passes || cert.Weight.QuorumWeight*2 <= cert.Weight.TotalWeight {
		t.Fatalf("weight certificate invalid: %+v", cert.Weight)
	}
	if !cert.Domains.Passes || cert.Domains.Count < 2 {
		t.Fatalf("domain certificate invalid: %+v", cert.Domains)
	}
	if err := VerifyQuorum(exampleInput(), cert); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestSolveQuorumInfeasibleSingleDomain(t *testing.T) {
	in := &Input{Nodes: []Node{
		{ID: "a", Weight: 3, Domain: "d1", Voter: true},
		{ID: "b", Weight: 2, Domain: "d1", Voter: true},
	}}
	cert, err := SolveQuorum(in)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "infeasible" {
		t.Fatalf("status = %q, want infeasible", cert.Status)
	}
	if err := VerifyQuorum(in, cert); err != nil {
		t.Fatalf("verify infeasible: %v", err)
	}
}

func TestSolveQuorumTooManyVoters(t *testing.T) {
	in := &Input{}
	for i := 0; i < MaxQuorumVoters+1; i++ {
		in.Nodes = append(in.Nodes, Node{ID: string(rune('a' + i)), Weight: 1, Domain: "d1", Voter: true})
	}
	if _, err := SolveQuorum(in); err == nil {
		t.Fatal("expected limit error for 23 candidate voters")
	}
}

// bruteForceQuorum is the acceptance oracle: an independent exhaustive
// subset enumeration used to check the branch-and-bound solver.
func bruteForceQuorum(vs []voter, total int64) (best int64, ok bool) {
	best = math.MaxInt64
	var rec func(i int, weight, cost int64, domMask uint64)
	rec = func(i int, weight, cost int64, domMask uint64) {
		if 2*weight > total && bits.OnesCount64(domMask) >= MinDomains {
			if cost < best {
				best, ok = cost, true
			}
			return // costs are non-negative
		}
		if i == len(vs) {
			return
		}
		v := vs[i]
		rec(i+1, weight+v.weight, cost+v.cost, domMask|1<<uint(v.domain))
		rec(i+1, weight, cost, domMask)
	}
	rec(0, 0, 0, 0)
	return best, ok
}

func randomInput(rng *rand.Rand, nVoters, nDomains int) *Input {
	in := &Input{}
	for i := 0; i < nVoters; i++ {
		n := Node{
			ID:     "v" + itoa(i),
			Weight: int64(1 + rng.Intn(8)),
			Domain: "d" + itoa(rng.Intn(nDomains)),
			Voter:  true,
		}
		if rng.Intn(2) == 0 {
			n.Cost = costPtr(int64(rng.Intn(7)))
		}
		in.Nodes = append(in.Nodes, n)
	}
	for i := 0; i < rng.Intn(3); i++ {
		in.Nodes = append(in.Nodes, Node{
			ID:     "nv" + itoa(i),
			Weight: int64(1 + rng.Intn(8)),
			Domain: "d" + itoa(rng.Intn(nDomains)),
		})
	}
	return in
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [8]byte
	p := len(buf)
	for i > 0 {
		p--
		buf[p] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[p:])
}

func TestSolveQuorumAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		in := randomInput(rng, 1+rng.Intn(12), 1+rng.Intn(4))
		cert, err := SolveQuorum(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		vs, _ := voters(in)
		best, ok := bruteForceQuorum(vs, totalWeight(vs))
		if !ok {
			if cert.Status != "infeasible" {
				t.Fatalf("trial %d: status = %q, oracle says infeasible", trial, cert.Status)
			}
			continue
		}
		if cert.Status != "optimal" {
			t.Fatalf("trial %d: status = %q, oracle optimum %d", trial, cert.Status, best)
		}
		if cert.Cost != best {
			t.Fatalf("trial %d: cost = %d, oracle optimum %d", trial, cert.Cost, best)
		}
		if cert.LowerBound != best || cert.UpperBound != best {
			t.Fatalf("trial %d: bounds = [%d, %d], want [%d, %d]", trial, cert.LowerBound, cert.UpperBound, best, best)
		}
		if err := VerifyQuorum(in, cert); err != nil {
			t.Fatalf("trial %d: verify: %v", trial, err)
		}
	}
}

func TestVerifyQuorumRejectsTampering(t *testing.T) {
	in := exampleInput()
	cert, err := SolveQuorum(in)
	if err != nil {
		t.Fatal(err)
	}

	bad := *cert
	bad.Cost--
	if err := VerifyQuorum(in, &bad); err == nil {
		t.Fatal("tampered cost accepted")
	}

	bad = *cert
	bad.Members = append([]string(nil), cert.Members...)
	bad.Members[0] = "x" // non-voter
	if err := VerifyQuorum(in, &bad); err == nil {
		t.Fatal("non-voter member accepted")
	}

	bad = *cert
	w := *cert.Weight
	w.QuorumWeight++
	bad.Weight = &w
	if err := VerifyQuorum(in, &bad); err == nil {
		t.Fatal("tampered weight certificate accepted")
	}
}
