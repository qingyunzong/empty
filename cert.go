package main

import "math/bits"

// QuorumCert is the weight/domain certificate for one quorum.
type QuorumCert struct {
	Nodes       []string `json:"nodes"`
	Size        int      `json:"size"`
	Weight      int64    `json:"weight"`
	TotalWeight int64    `json:"totalWeight"`
	Majority    bool     `json:"majority"`
	Domains     []string `json:"domains"`
	DomainCount int      `json:"domainCount"`
	Cost        int64    `json:"cost"`
}

// BuildQuorumCert summarises a quorum mask as a certificate.
func BuildQuorumCert(in *Instance, mask uint64) QuorumCert {
	w := in.Weight(mask)
	return QuorumCert{
		Nodes:       in.Names(mask),
		Size:        in.Size(mask),
		Weight:      w,
		TotalWeight: in.TotalWeight,
		Majority:    w*2 > in.TotalWeight,
		Domains:     in.DomainNames(in.Domains(mask)),
		DomainCount: in.DomainCount(mask),
		Cost:        in.Cost(mask),
	}
}

// FaultCert certifies one failure scenario for a quorum pair: after the
// named node fails, both quorums remain legal and still intersect.
type FaultCert struct {
	Fault                 string   `json:"faultNode"`
	SurvivingIntersection []string `json:"survivingIntersection"`
	Intersect             bool     `json:"intersect"`
	ReadWeight            int64    `json:"readWeight"`
	ReadDomains           int      `json:"readDomains"`
	ReadLegal             bool     `json:"readLegal"`
	WriteWeight           int64    `json:"writeWeight"`
	WriteDomains          int      `json:"writeDomains"`
	WriteLegal            bool     `json:"writeLegal"`
}

// BuildFaultCerts emits one certificate for the no-failure scenario plus
// one per node in R ∪ W.
func BuildFaultCerts(in *Instance, cons Constraints, r, w uint64) []FaultCert {
	certs := []FaultCert{faultCertFor(in, cons, r, w, 0, "none")}
	for m := r | w; m != 0; m &= m - 1 {
		f := m & -m
		certs = append(certs, faultCertFor(in, cons, r, w, f, in.Nodes[bits.TrailingZeros64(f)].ID))
	}
	return certs
}

func faultCertFor(in *Instance, cons Constraints, r, w, fault uint64, name string) FaultCert {
	rs := r &^ fault
	ws := w &^ fault
	inter := rs & ws
	return FaultCert{
		Fault:                 name,
		SurvivingIntersection: in.Names(inter),
		Intersect:             inter != 0,
		ReadWeight:            in.Weight(rs),
		ReadDomains:           in.DomainCount(rs),
		ReadLegal:             in.Legal(rs, cons),
		WriteWeight:           in.Weight(ws),
		WriteDomains:          in.DomainCount(ws),
		WriteLegal:            in.Legal(ws, cons),
	}
}

// Verification records an exhaustive-enumeration cross-check.
type Verification struct {
	Method               string `json:"method"`
	Skipped              bool   `json:"skipped,omitempty"`
	SubsetsChecked       int64  `json:"subsetsChecked,omitempty"`
	FaultTolerantQuorums int    `json:"faultTolerantQuorums,omitempty"`
	PairsChecked         int64  `json:"pairsChecked,omitempty"`
	EnumerationFeasible  bool   `json:"enumerationFeasible"`
	EnumerationCost      int64  `json:"enumerationCost"`
	SolverCost           int64  `json:"solverCost"`
	Match                bool   `json:"match"`
}

// VerifySingle cross-checks SolveSingle by exhaustive subset enumeration.
func VerifySingle(in *Instance, cons Constraints, res SingleResult) Verification {
	v := Verification{Method: "exhaustive-subset-enumeration", SolverCost: res.Cost}
	if len(in.Nodes) > 24 {
		v.Method = "exhaustive-subset-enumeration (skipped: more than 24 nodes)"
		v.Skipped = true
		v.EnumerationFeasible = res.Feasible
		return v
	}
	bf := BruteForceSingle(in, cons)
	v.SubsetsChecked = bf.Subsets
	v.EnumerationFeasible = bf.Feasible
	v.EnumerationCost = bf.Cost
	v.Match = bf.Feasible == res.Feasible && (!bf.Feasible || bf.Cost == res.Cost)
	return v
}

// VerifyPair cross-checks SolvePair by exhaustive pair enumeration.
func VerifyPair(in *Instance, cons Constraints, res PairResult) Verification {
	v := Verification{Method: "exhaustive-subset-enumeration", SolverCost: res.Cost}
	if len(in.Nodes) > 18 {
		v.Method = "exhaustive-subset-enumeration (skipped: more than 18 nodes)"
		v.Skipped = true
		v.EnumerationFeasible = res.Feasible
		return v
	}
	bf := BruteForcePair(in, cons)
	v.SubsetsChecked = bf.Subsets
	v.FaultTolerantQuorums = bf.FTQuorums
	v.PairsChecked = bf.Pairs
	v.EnumerationFeasible = bf.Feasible
	v.EnumerationCost = bf.Cost
	v.Match = bf.Feasible == res.Feasible && (!bf.Feasible || bf.Cost == res.Cost)
	return v
}

// SingleOutput is the JSON document printed by the quorum subcommand.
type SingleOutput struct {
	Feasible      bool          `json:"feasible"`
	ProvedOptimal bool          `json:"provedOptimal"`
	Constraints   Constraints   `json:"constraints"`
	Quorum        *QuorumCert   `json:"quorum,omitempty"`
	Verification  *Verification `json:"verification,omitempty"`
}

// SearchStats summarises the pair search effort.
type SearchStats struct {
	FaultTolerantQuorums int   `json:"faultTolerantQuorums"`
	PairsChecked         int64 `json:"pairsChecked"`
}

// PairOutput is the JSON document printed by the pair subcommand.
type PairOutput struct {
	Feasible          bool          `json:"feasible"`
	ProvedOptimal     bool          `json:"provedOptimal"`
	Constraints       Constraints   `json:"constraints"`
	Read              *QuorumCert   `json:"read,omitempty"`
	Write             *QuorumCert   `json:"write,omitempty"`
	UnionNodes        []string      `json:"unionNodes,omitempty"`
	UnionCost         int64         `json:"unionCost,omitempty"`
	LowerBound        int64         `json:"lowerBound,omitempty"`
	UpperBound        int64         `json:"upperBound,omitempty"`
	Search            *SearchStats  `json:"search,omitempty"`
	FaultCertificates []FaultCert   `json:"faultCertificates,omitempty"`
	Verification      *Verification `json:"verification,omitempty"`
}
