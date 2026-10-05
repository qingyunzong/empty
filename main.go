// Command testplan selects an optimal subset of tests covering all required
// public branches and pairwise interactions, subject to startup
// prerequisites and a total time limit.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"testplan/solver"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "solve":
		err = cmdSolve(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "example":
		err = cmdExample()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `testplan - optimal test selection planner

Usage:
  testplan solve [-json] [-exhaustive] [-max-nodes N] <instance.json>
      Solve an instance and print the coverage certificate and search bound.
  testplan verify <instance.json> <certificate.json>
      Check a certificate; re-proves optimality.
  testplan example
      Print a small example instance to stdout.
`)
}

func loadInstance(path string) (*solver.Instance, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var inst solver.Instance
	if err := json.Unmarshal(data, &inst); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return &inst, nil
}

func cmdSolve(args []string) error {
	fs := flag.NewFlagSet("solve", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "emit the certificate as JSON")
	exhaustive := fs.Bool("exhaustive", false, "cross-check with exhaustive enumeration")
	maxNodes := fs.Int("max-nodes", 0, "node budget for branch and bound (0 = unlimited)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("solve expects exactly one instance file")
	}
	inst, err := loadInstance(fs.Arg(0))
	if err != nil {
		return err
	}
	res, err := solver.Solve(inst, &solver.Options{MaxNodes: *maxNodes})
	if err != nil {
		return err
	}
	cert := solver.BuildCertificate(inst, res)

	if *exhaustive {
		ex, err := solver.SolveExhaustive(inst)
		if err != nil {
			return err
		}
		if res.Status == solver.Optimal || res.Status == solver.Infeasible {
			if ex.Status != res.Status {
				return fmt.Errorf("cross-check failed: branch&bound=%s exhaustive=%s", res.Status, ex.Status)
			}
			if res.Status == solver.Optimal && (ex.Cost != res.Cost || ex.Count != res.Count) {
				return fmt.Errorf("cross-check failed: branch&bound=(%d,%d) exhaustive=(%d,%d)",
					res.Cost, res.Count, ex.Cost, ex.Count)
			}
		}
		fmt.Fprintf(os.Stderr, "cross-check: exhaustive search agrees (nodes=%d)\n", ex.Stats.Nodes)
	}
	if err := solver.VerifyCertificate(inst, cert, res.Status == solver.Optimal); err != nil {
		return fmt.Errorf("self-verification failed: %w", err)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(cert)
	}
	printCertificate(inst, cert)
	return nil
}

func printCertificate(inst *solver.Instance, cert *solver.Certificate) {
	fmt.Printf("instance: %s (tests=%d branches=%d pairs=%d time-limit=%d)\n",
		inst.Name, len(inst.Tests), len(inst.Branches), len(inst.Pairs), inst.TimeLimit)
	fmt.Printf("status: %s\n", cert.Status)
	if cert.Status == solver.Infeasible {
		fmt.Println("no selection covers all requirements within the time limit")
		return
	}
	fmt.Printf("objective: cost=%d tests=%d time=%d/%d\n", cert.Cost, cert.Count, cert.Time, cert.TimeLimit)
	fmt.Printf("selected: %v\n", cert.Selected)
	fmt.Println("coverage certificate:")
	for _, e := range cert.Coverage {
		fmt.Printf("  %-6s %-24s <- %s\n", e.Kind, e.Name, e.Test)
	}
	if cert.Status == solver.Optimal {
		fmt.Printf("optimality bound: cost>=%d tests>=%d (matches objective, proven)\n",
			cert.BoundCost, cert.BoundCount)
	} else {
		fmt.Printf("search bound: cost>=%d tests>=%d (gap to objective remains)\n",
			cert.BoundCost, cert.BoundCount)
	}
	fmt.Printf("search: nodes=%d pruned=%d\n", cert.Nodes, cert.Pruned)
}

func cmdVerify(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("verify expects <instance.json> <certificate.json>")
	}
	inst, err := loadInstance(args[0])
	if err != nil {
		return err
	}
	data, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	var cert solver.Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		return fmt.Errorf("parsing %s: %w", args[1], err)
	}
	if err := solver.VerifyCertificate(inst, &cert, true); err != nil {
		return err
	}
	fmt.Printf("certificate valid: status=%s cost=%d tests=%d bound=(%d,%d)\n",
		cert.Status, cert.Cost, cert.Count, cert.BoundCost, cert.BoundCount)
	return nil
}

func cmdExample() error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(exampleInstance())
}

func exampleInstance() solver.Instance {
	return solver.Instance{
		Name:      "example",
		Branches:  []string{"login/ok", "login/fail", "cart/add", "cart/remove", "checkout/pay", "checkout/cancel"},
		Pairs:     []string{"os=linux,browser=firefox", "os=mac,browser=safari", "os=windows,browser=edge"},
		TimeLimit: 40,
		Tests: []solver.Test{
			{ID: "smoke", Cost: 4, Time: 6, Branches: []string{"login/ok"}, Pairs: []string{"os=linux,browser=firefox"}},
			{ID: "login-negative", Cost: 3, Time: 5, Requires: []string{"smoke"}, Branches: []string{"login/fail"}},
			{ID: "cart", Cost: 6, Time: 9, Branches: []string{"cart/add", "cart/remove"}, Pairs: []string{"os=mac,browser=safari"}},
			{ID: "checkout", Cost: 8, Time: 12, Requires: []string{"cart"}, Branches: []string{"checkout/pay", "checkout/cancel"}},
			{ID: "checkout-full", Cost: 15, Time: 20, Branches: []string{"cart/add", "checkout/pay", "checkout/cancel"}, Pairs: []string{"os=windows,browser=edge"}},
			{ID: "edge-matrix", Cost: 5, Time: 8, Pairs: []string{"os=windows,browser=edge"}},
		},
	}
}
