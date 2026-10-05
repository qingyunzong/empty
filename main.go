package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

var errInfeasible = errors.New("no feasible solution")

const usageText = `quorumcli - fault-domain aware quorum selection

Usage:
  quorumcli quorum -input nodes.json [-max-size 22] [-min-domains 2] [-verify]
  quorumcli pair   -input nodes.json [-max-size 18] [-min-domains 2] [-verify]

Input JSON: {"nodes":[{"id":"n1","domain":"zone-a","weight":3,"cost":5}, ...]}
(a bare array of node objects is also accepted). Output is a JSON
certificate on stdout.

Commands:
  quorum  minimum-cost single quorum: total weight strictly above half of
          the grand total, spanning at least -min-domains fault domains,
          at most -max-size nodes
  pair    read/write quorum pair: each quorum stays legal after any single
          node failure inside the pair, the two quorums still intersect
          after any such failure, and the union cost is minimised
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usageText)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "quorum":
		err = cmdQuorum(os.Args[2:])
	case "pair":
		err = cmdPair(os.Args[2:])
	case "help", "-h", "--help":
		fmt.Print(usageText)
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n%s", os.Args[1], usageText)
		os.Exit(2)
	}
	if errors.Is(err, errInfeasible) {
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func cmdQuorum(args []string) error {
	fs := flag.NewFlagSet("quorum", flag.ContinueOnError)
	input := fs.String("input", "", "instance JSON file path, or \"-\" for stdin")
	maxSize := fs.Int("max-size", 22, "maximum number of nodes in the quorum")
	minDomains := fs.Int("min-domains", 2, "minimum number of distinct fault domains")
	maxSteps := fs.Int64("max-steps", 0, "branch-and-bound step budget, 0 = unlimited")
	verify := fs.Bool("verify", false, "cross-check optimality by exhaustive subset enumeration (small instances)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in, err := loadInstance(*input)
	if err != nil {
		return err
	}
	cons := Constraints{MinDomains: *minDomains, MaxSize: *maxSize, MaxSteps: *maxSteps}
	res := SolveSingle(in, cons)
	out := SingleOutput{Feasible: res.Feasible, Constraints: cons, ProvedOptimal: !res.Aborted}
	if res.Feasible {
		cert := BuildQuorumCert(in, res.Mask)
		out.Quorum = &cert
	}
	if *verify {
		v := VerifySingle(in, cons, res)
		out.Verification = &v
	}
	if err := printJSON(out); err != nil {
		return err
	}
	if !res.Feasible {
		return errInfeasible
	}
	return nil
}

func cmdPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	input := fs.String("input", "", "instance JSON file path, or \"-\" for stdin")
	maxSize := fs.Int("max-size", 18, "maximum number of nodes per quorum")
	minDomains := fs.Int("min-domains", 2, "minimum number of distinct fault domains")
	maxSteps := fs.Int64("max-steps", 0, "branch-and-bound step budget, 0 = unlimited")
	verify := fs.Bool("verify", false, "cross-check optimality by exhaustive pair enumeration (small instances)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in, err := loadInstance(*input)
	if err != nil {
		return err
	}
	cons := Constraints{MinDomains: *minDomains, MaxSize: *maxSize, MaxSteps: *maxSteps}
	res := SolvePair(in, cons)
	out := PairOutput{Feasible: res.Feasible, Constraints: cons, ProvedOptimal: !res.Aborted}
	if res.Feasible {
		read := BuildQuorumCert(in, res.R)
		write := BuildQuorumCert(in, res.W)
		out.Read = &read
		out.Write = &write
		out.UnionNodes = in.Names(res.R | res.W)
		out.UnionCost = res.Cost
		out.LowerBound = res.LowerBound
		out.UpperBound = res.Cost
		out.Search = &SearchStats{FaultTolerantQuorums: res.FTQuorums, PairsChecked: res.Pairs}
		out.FaultCertificates = BuildFaultCerts(in, cons, res.R, res.W)
	}
	if *verify {
		v := VerifyPair(in, cons, res)
		out.Verification = &v
	}
	if err := printJSON(out); err != nil {
		return err
	}
	if !res.Feasible {
		return errInfeasible
	}
	return nil
}

func loadInstance(path string) (*Instance, error) {
	var data []byte
	var err error
	if path == "" || path == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		Nodes []Node `json:"nodes"`
	}
	if err := json.Unmarshal(data, &doc); err == nil && doc.Nodes != nil {
		return NewInstance(doc.Nodes)
	}
	var nodes []Node
	if err := json.Unmarshal(data, &nodes); err != nil {
		return nil, fmt.Errorf("cannot parse input JSON: %w", err)
	}
	return NewInstance(nodes)
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
