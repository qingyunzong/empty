package quorum

import (
	"math"
	"math/bits"
	"math/rand"
	"testing"
)

func pairExampleInput() *Input {
	return &Input{Nodes: []Node{
		{ID: "a", Weight: 5, Cost: costPtr(5), Domain: "d1", Voter: true},
		{ID: "b", Weight: 1, Cost: costPtr(1), Domain: "d1", Voter: true},
		{ID: "c", Weight: 5, Cost: costPtr(5), Domain: "d2", Voter: true},
		{ID: "d", Weight: 1, Cost: costPtr(1), Domain: "d2", Voter: true},
		{ID: "e", Weight: 2, Cost: costPtr(2), Domain: "d3", Voter: true},
		{ID: "f", Weight: 1, Cost: costPtr(1), Domain: "d3", Voter: true},
	}}
}

func TestSolvePairExample(t *testing.T) {
	in := pairExampleInput()
	cert, err := SolvePair(in)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "optimal" {
		t.Fatalf("status = %q, want optimal", cert.Status)
	}
	// Total weight 15. A resilient quorum must survive every single-domain
	// fault with weight >= 8 and >= 2 domains, forcing >= 3 domains and
	// pairwise domain sums >= 8. Cheapest resilient quorums cost 13 and 14.
	if cert.Cost != 27 {
		t.Fatalf("cost = %d, want 27 (read %v write %v)", cert.Cost, cert.Read, cert.Write)
	}
	if cert.LowerBound != 27 || cert.UpperBound != 27 {
		t.Fatalf("bounds = [%d, %d], want [27, 27]", cert.LowerBound, cert.UpperBound)
	}
	if len(cert.Faults) != 3 {
		t.Fatalf("fault certificates = %d, want 3", len(cert.Faults))
	}
	for _, fc := range cert.Faults {
		if !fc.ReadPasses || !fc.WritePasses || !fc.Intersects {
			t.Fatalf("fault %q not certified: %+v", fc.Fault, fc)
		}
		if len(fc.Intersection) == 0 {
			t.Fatalf("fault %q: empty intersection certificate", fc.Fault)
		}
	}
	if err := VerifyPair(in, cert); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestSolvePairInfeasibleUniqueResilientQuorum(t *testing.T) {
	// Every resilient quorum must contain all five voters, so no distinct
	// read/write pair exists.
	in := &Input{Nodes: []Node{
		{ID: "a", Weight: 3, Domain: "d1", Voter: true},
		{ID: "b", Weight: 3, Domain: "d1", Voter: true},
		{ID: "c", Weight: 3, Domain: "d2", Voter: true},
		{ID: "d", Weight: 3, Domain: "d2", Voter: true},
		{ID: "e", Weight: 3, Domain: "d3", Voter: true},
	}}
	cert, err := SolvePair(in)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "infeasible" {
		t.Fatalf("status = %q, want infeasible", cert.Status)
	}
	if err := VerifyPair(in, cert); err != nil {
		t.Fatalf("verify infeasible: %v", err)
	}
}

func TestSolvePairTooManyVoters(t *testing.T) {
	in := &Input{}
	for i := 0; i < MaxPairVoters+1; i++ {
		in.Nodes = append(in.Nodes, Node{ID: "n" + itoa(i), Weight: 1, Domain: "d1", Voter: true})
	}
	if _, err := SolvePair(in); err == nil {
		t.Fatal("expected limit error for 19 candidate voters")
	}
}

func TestSolvePairAllowedFaultsSubset(t *testing.T) {
	in := pairExampleInput()
	in.AllowedFaults = []string{"d3"}
	cert, err := SolvePair(in)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "optimal" {
		t.Fatalf("status = %q, want optimal", cert.Status)
	}
	if len(cert.Faults) != 1 || cert.Faults[0].Fault != "d3" {
		t.Fatalf("fault certificates = %+v, want exactly d3", cert.Faults)
	}
	if err := VerifyPair(in, cert); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

// bruteForcePair is an independent oracle: enumerate every subset, keep
// resilient ones, then scan all unordered distinct pairs.
func bruteForcePair(vs []voter, total int64, faults []faultDomain) (best int64, ok bool) {
	best = math.MaxInt64
	n := len(vs)
	type cand struct {
		mask uint64
		cost int64
	}
	var cands []cand
	for s := 1; s < 1<<uint(n); s++ {
		var weight, cost int64
		var domMask uint64
		for i := 0; i < n; i++ {
			if s>>uint(i)&1 == 1 {
				weight += vs[i].weight
				cost += vs[i].cost
				domMask |= 1 << uint(vs[i].domain)
			}
		}
		resilient := true
		for _, f := range faults {
			var fw int64
			for i := 0; i < n; i++ {
				if s>>uint(i)&1 == 1 && f.mask>>uint(i)&1 == 1 {
					fw += vs[i].weight
				}
			}
			if 2*(weight-fw) <= total || bits.OnesCount64(domMask&^f.domBit) < MinDomains {
				resilient = false
				break
			}
		}
		if resilient {
			cands = append(cands, cand{mask: uint64(s), cost: cost})
		}
	}
	for i := 0; i < len(cands); i++ {
		for j := i + 1; j < len(cands); j++ {
			good := true
			for _, f := range faults {
				if cands[i].mask&cands[j].mask&^f.mask == 0 {
					good = false
					break
				}
			}
			if good && cands[i].cost+cands[j].cost < best {
				best, ok = cands[i].cost+cands[j].cost, true
			}
		}
	}
	return best, ok
}

func TestSolvePairAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 300; trial++ {
		in := randomInput(rng, 1+rng.Intn(10), 2+rng.Intn(3))
		if rng.Intn(3) == 0 {
			// Restrict allowed faults to a random subset of domains.
			seen := map[string]bool{}
			for _, n := range in.Nodes {
				if n.Voter && !seen[n.Domain] && rng.Intn(2) == 0 {
					seen[n.Domain] = true
					in.AllowedFaults = append(in.AllowedFaults, n.Domain)
				}
			}
		}
		cert, err := SolvePair(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		vs, domNames := voters(in)
		faultNames, err := faultList(in, domNames)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		domIndex := map[string]int{}
		for i, name := range domNames {
			domIndex[name] = i
		}
		var faults []faultDomain
		for _, name := range faultNames {
			f := faultDomain{name: name, domBit: 1 << uint(domIndex[name])}
			for i, v := range vs {
				if v.domain == domIndex[name] {
					f.mask |= 1 << uint(i)
				}
			}
			faults = append(faults, f)
		}
		best, ok := bruteForcePair(vs, totalWeight(vs), faults)
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
		if err := VerifyPair(in, cert); err != nil {
			t.Fatalf("trial %d: verify: %v", trial, err)
		}
	}
}

func TestVerifyPairRejectsTampering(t *testing.T) {
	in := pairExampleInput()
	cert, err := SolvePair(in)
	if err != nil {
		t.Fatal(err)
	}

	bad := *cert
	bad.Write = cert.Read // read == write
	if err := VerifyPair(in, &bad); err == nil {
		t.Fatal("identical read/write quorums accepted")
	}

	bad = *cert
	bad.Cost--
	if err := VerifyPair(in, &bad); err == nil {
		t.Fatal("tampered cost accepted")
	}

	bad = *cert
	bad.Faults = append([]FaultCertificate(nil), cert.Faults...)
	bad.Faults[0].Intersection = nil
	if err := VerifyPair(in, &bad); err == nil {
		t.Fatal("tampered intersection certificate accepted")
	}

	bad = *cert
	bad.Faults = append([]FaultCertificate(nil), cert.Faults...)
	bad.Faults[0].ReadSurvivingWeight++
	if err := VerifyPair(in, &bad); err == nil {
		t.Fatal("tampered surviving weight accepted")
	}
}
