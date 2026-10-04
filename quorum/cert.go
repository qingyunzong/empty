package quorum

import (
	"fmt"
	"sort"
)

// VerifyQuorum independently checks every claim in a quorum certificate,
// including optimality (by re-solving).
func VerifyQuorum(in *Input, cert *QuorumCertificate) error {
	if cert.Status != "optimal" && cert.Status != "infeasible" {
		return fmt.Errorf("quorum certificate: unknown status %q", cert.Status)
	}
	want, err := SolveQuorum(in)
	if err != nil {
		return err
	}
	if cert.Status != want.Status {
		return fmt.Errorf("quorum certificate: status %q, recomputed %q", cert.Status, want.Status)
	}
	if cert.Status == "infeasible" {
		return nil
	}
	if cert.Weight == nil || cert.Domains == nil {
		return fmt.Errorf("quorum certificate: missing weight or domain certificate")
	}
	vs, domNames := voters(in)
	total := totalWeight(vs)
	mask, cost, err := memberMask(vs, cert.Members)
	if err != nil {
		return fmt.Errorf("quorum certificate: %w", err)
	}
	var weightSum int64
	var domMask uint64
	for i, v := range vs {
		if mask>>uint(i)&1 == 1 {
			weightSum += v.weight
			domMask |= 1 << uint(v.domain)
		}
	}
	if cert.Weight.QuorumWeight != weightSum {
		return fmt.Errorf("quorum certificate: quorum weight %d, recomputed %d", cert.Weight.QuorumWeight, weightSum)
	}
	if cert.Weight.TotalWeight != total {
		return fmt.Errorf("quorum certificate: total weight %d, recomputed %d", cert.Weight.TotalWeight, total)
	}
	if pass := 2*weightSum > total; pass != cert.Weight.Passes {
		return fmt.Errorf("quorum certificate: weight passes=%t, recomputed %t", cert.Weight.Passes, pass)
	}
	if !cert.Weight.Passes {
		return fmt.Errorf("quorum certificate: weight rule not satisfied")
	}
	wantDomains := domainNamesOf(domNames, domMask)
	if !equalStrings(cert.Domains.Domains, wantDomains) {
		return fmt.Errorf("quorum certificate: domains %v, recomputed %v", cert.Domains.Domains, wantDomains)
	}
	if cert.Domains.Count != len(wantDomains) {
		return fmt.Errorf("quorum certificate: domain count %d, recomputed %d", cert.Domains.Count, len(wantDomains))
	}
	if pass := len(wantDomains) >= MinDomains; pass != cert.Domains.Passes {
		return fmt.Errorf("quorum certificate: domain passes=%t, recomputed %t", cert.Domains.Passes, pass)
	}
	if !cert.Domains.Passes {
		return fmt.Errorf("quorum certificate: domain rule not satisfied")
	}
	if cert.Cost != cost {
		return fmt.Errorf("quorum certificate: cost %d, recomputed %d", cert.Cost, cost)
	}
	if cert.Cost != want.Cost {
		return fmt.Errorf("quorum certificate: cost %d is not optimal (optimum %d)", cert.Cost, want.Cost)
	}
	if cert.LowerBound != cert.Cost || cert.UpperBound != cert.Cost {
		return fmt.Errorf("quorum certificate: bounds [%d, %d] do not match cost %d", cert.LowerBound, cert.UpperBound, cert.Cost)
	}
	return nil
}

// VerifyPair independently checks every claim in a pair certificate,
// including per-fault intersection certificates and optimality.
func VerifyPair(in *Input, cert *PairCertificate) error {
	if cert.Status != "optimal" && cert.Status != "infeasible" {
		return fmt.Errorf("pair certificate: unknown status %q", cert.Status)
	}
	want, err := SolvePair(in)
	if err != nil {
		return err
	}
	if cert.Status != want.Status {
		return fmt.Errorf("pair certificate: status %q, recomputed %q", cert.Status, want.Status)
	}
	if cert.Status == "infeasible" {
		return nil
	}
	vs, domNames := voters(in)
	total := totalWeight(vs)
	if cert.TotalWeight != total {
		return fmt.Errorf("pair certificate: total weight %d, recomputed %d", cert.TotalWeight, total)
	}
	rMask, rCost, err := memberMask(vs, cert.Read)
	if err != nil {
		return fmt.Errorf("pair certificate: read quorum: %w", err)
	}
	wMask, wCost, err := memberMask(vs, cert.Write)
	if err != nil {
		return fmt.Errorf("pair certificate: write quorum: %w", err)
	}
	if rMask == wMask {
		return fmt.Errorf("pair certificate: read and write quorums must be distinct")
	}
	faultNames, err := faultList(in, domNames)
	if err != nil {
		return err
	}
	if len(cert.Faults) != len(faultNames) {
		return fmt.Errorf("pair certificate: %d fault certificates, expected %d", len(cert.Faults), len(faultNames))
	}
	domIndex := map[string]int{}
	for i, name := range domNames {
		domIndex[name] = i
	}
	domOf := make([]uint64, len(vs))
	for i, v := range vs {
		domOf[i] = 1 << uint(v.domain)
	}
	maskWeight := func(mask uint64) int64 {
		var sum int64
		for i, v := range vs {
			if mask>>uint(i)&1 == 1 {
				sum += v.weight
			}
		}
		return sum
	}
	maskDomains := func(mask uint64) uint64 {
		var dm uint64
		for i := range vs {
			if mask>>uint(i)&1 == 1 {
				dm |= domOf[i]
			}
		}
		return dm
	}
	for k, name := range faultNames {
		fc := cert.Faults[k]
		if fc.Fault != name {
			return fmt.Errorf("pair certificate: fault %d is %q, expected %q", k, fc.Fault, name)
		}
		var fMask uint64
		if di, ok := domIndex[name]; ok {
			for i, v := range vs {
				if v.domain == di {
					fMask |= 1 << uint(i)
				}
			}
		}
		rSurv := rMask &^ fMask
		wSurv := wMask &^ fMask
		rWeight, wWeight := maskWeight(rSurv), maskWeight(wSurv)
		rDoms := domainNamesOf(domNames, maskDomains(rSurv))
		wDoms := domainNamesOf(domNames, maskDomains(wSurv))
		if fc.ReadSurvivingWeight != rWeight {
			return fmt.Errorf("pair certificate: fault %q: read surviving weight %d, recomputed %d", name, fc.ReadSurvivingWeight, rWeight)
		}
		if !equalStrings(fc.ReadSurvivingDomains, rDoms) {
			return fmt.Errorf("pair certificate: fault %q: read surviving domains %v, recomputed %v", name, fc.ReadSurvivingDomains, rDoms)
		}
		if pass := 2*rWeight > total && len(rDoms) >= MinDomains; pass != fc.ReadPasses || !pass {
			return fmt.Errorf("pair certificate: fault %q: read passes=%t, recomputed %t", name, fc.ReadPasses, pass)
		}
		if fc.WriteSurvivingWeight != wWeight {
			return fmt.Errorf("pair certificate: fault %q: write surviving weight %d, recomputed %d", name, fc.WriteSurvivingWeight, wWeight)
		}
		if !equalStrings(fc.WriteSurvivingDomains, wDoms) {
			return fmt.Errorf("pair certificate: fault %q: write surviving domains %v, recomputed %v", name, fc.WriteSurvivingDomains, wDoms)
		}
		if pass := 2*wWeight > total && len(wDoms) >= MinDomains; pass != fc.WritePasses || !pass {
			return fmt.Errorf("pair certificate: fault %q: write passes=%t, recomputed %t", name, fc.WritePasses, pass)
		}
		inter := rMask & wMask &^ fMask
		if !equalStrings(fc.Intersection, memberIDs(vs, inter)) {
			return fmt.Errorf("pair certificate: fault %q: intersection mismatch", name)
		}
		if fc.Intersects != (inter != 0) || inter == 0 {
			return fmt.Errorf("pair certificate: fault %q: intersects=%t, recomputed %t", name, fc.Intersects, inter != 0)
		}
	}
	if cert.Cost != rCost+wCost {
		return fmt.Errorf("pair certificate: cost %d, recomputed %d", cert.Cost, rCost+wCost)
	}
	if cert.Cost != want.Cost {
		return fmt.Errorf("pair certificate: cost %d is not optimal (optimum %d)", cert.Cost, want.Cost)
	}
	if cert.LowerBound != cert.Cost || cert.UpperBound != cert.Cost {
		return fmt.Errorf("pair certificate: bounds [%d, %d] do not match cost %d", cert.LowerBound, cert.UpperBound, cert.Cost)
	}
	return nil
}

// memberMask converts a member ID list into a voter bitmask plus cost.
func memberMask(vs []voter, members []string) (uint64, int64, error) {
	if len(members) == 0 {
		return 0, 0, fmt.Errorf("empty member list")
	}
	index := map[string]int{}
	for i, v := range vs {
		index[v.id] = i
	}
	var mask uint64
	var cost int64
	seen := map[string]bool{}
	for _, id := range members {
		i, ok := index[id]
		if !ok {
			return 0, 0, fmt.Errorf("member %q is not a candidate voter", id)
		}
		if seen[id] {
			return 0, 0, fmt.Errorf("duplicate member %q", id)
		}
		seen[id] = true
		mask |= 1 << uint(i)
		cost += vs[i].cost
	}
	return mask, cost, nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	as, bs := append([]string(nil), a...), append([]string(nil), b...)
	sort.Strings(as)
	sort.Strings(bs)
	for i := range as {
		if as[i] != bs[i] {
			return false
		}
	}
	return true
}
