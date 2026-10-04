// Command joinopt finds the minimum-cost binary join tree over explicitly
// defined join edges for up to 12 tables, prints the canonical tree order,
// and emits a per-subtree estimation certificate.
//
// Input format on stdin:
//
//	<n>                 number of tables, 1..12
//	<name> <card>       n lines: table name and positive integer cardinality
//	<m>                 number of join edges
//	<name> <name> <d>   m lines: edge endpoints and integer divisor d >= 1
//
// Cost model (integer rules): for a subset S, the estimated cardinality is
// estCard(S) = max(1, floor(prod cards / prod divisors of internal edges)).
// The cost of a join tree is the sum of estCard over all its internal nodes
// (the root included). Only binary trees in which every join crosses at
// least one defined edge are allowed.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

func readProblem(r io.Reader) (*Problem, error) {
	in := bufio.NewReader(r)
	var n int
	if _, err := fmt.Fscan(in, &n); err != nil {
		return nil, fmt.Errorf("reading table count: %w", err)
	}
	if n < 1 || n > MaxTables {
		return nil, fmt.Errorf("table count must be in [1,%d], got %d", MaxTables, n)
	}
	p := &Problem{Names: make([]string, n), Card: make([]int64, n)}
	index := map[string]int{}
	for i := 0; i < n; i++ {
		var name string
		var card int64
		if _, err := fmt.Fscan(in, &name, &card); err != nil {
			return nil, fmt.Errorf("reading table %d: %w", i+1, err)
		}
		if strings.ContainsAny(name, "(){}, \t") || name == "" {
			return nil, fmt.Errorf("invalid table name %q", name)
		}
		if _, dup := index[name]; dup {
			return nil, fmt.Errorf("duplicate table name %q", name)
		}
		if card < 1 {
			return nil, fmt.Errorf("table %q: cardinality must be >= 1, got %d", name, card)
		}
		index[name] = i
		p.Names[i] = name
		p.Card[i] = card
	}
	var m int
	if _, err := fmt.Fscan(in, &m); err != nil {
		return nil, fmt.Errorf("reading edge count: %w", err)
	}
	if m < 0 {
		return nil, fmt.Errorf("edge count must be >= 0, got %d", m)
	}
	seen := map[[2]int]bool{}
	for i := 0; i < m; i++ {
		var a, b string
		var d int64
		if _, err := fmt.Fscan(in, &a, &b, &d); err != nil {
			return nil, fmt.Errorf("reading edge %d: %w", i+1, err)
		}
		u, ok := index[a]
		if !ok {
			return nil, fmt.Errorf("edge %d: unknown table %q", i+1, a)
		}
		v, ok := index[b]
		if !ok {
			return nil, fmt.Errorf("edge %d: unknown table %q", i+1, b)
		}
		if u == v {
			return nil, fmt.Errorf("edge %d: self edge on %q", i+1, a)
		}
		if d < 1 {
			return nil, fmt.Errorf("edge %d: divisor must be >= 1, got %d", i+1, d)
		}
		key := [2]int{u, v}
		if u > v {
			key = [2]int{v, u}
		}
		if seen[key] {
			return nil, fmt.Errorf("edge %d: duplicate edge %q-%q", i+1, a, b)
		}
		seen[key] = true
		p.Edges = append(p.Edges, Edge{U: u, V: v, D: d})
	}
	return p, nil
}

func printCertificate(sol *Solution) {
	fmt.Println("Per-subtree estimation certificate:")
	fmt.Printf("  %-24s %-14s %-14s %s\n", "subset", "est-card", "min-cost", "split")
	for _, c := range sol.Certs {
		splitStr := "-"
		if c.Split != 0 {
			splitStr = sol.Prob.MaskString(c.Split) + " | " +
				sol.Prob.MaskString(c.Mask^c.Split)
		}
		fmt.Printf("  %-24s %-14s %-14s %s\n",
			sol.Prob.MaskString(c.Mask), c.EstCard, c.Cost, splitStr)
	}
}

func main() {
	verify := flag.Bool("verify", false,
		"cross-check the DP optimum by exhaustively enumerating all join trees (n <= 8)")
	flag.Parse()

	p, err := readProblem(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "joinopt: input error:", err)
		os.Exit(2)
	}
	sol, err := Solve(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, "joinopt:", err)
		os.Exit(2)
	}
	if !sol.OK {
		fmt.Fprintln(os.Stderr, "joinopt: no legal join tree: join graph is disconnected")
		os.Exit(1)
	}

	fmt.Println("Optimal total cost:", sol.Full.Cost)
	fmt.Println("Canonical tree order:", sol.Full.Tree)
	printCertificate(sol)

	if *verify {
		cost, tree, err := BruteForce(p)
		if err != nil {
			fmt.Fprintln(os.Stderr, "joinopt: verify:", err)
			os.Exit(2)
		}
		if cost.Cmp(sol.Full.Cost) != 0 || tree != sol.Full.Tree {
			fmt.Fprintf(os.Stderr,
				"joinopt: MISMATCH dp=(%s %s) brute=(%s %s)\n",
				sol.Full.Cost, sol.Full.Tree, cost, tree)
			os.Exit(1)
		}
		fmt.Println("Verify: exhaustive enumeration agrees (cost", cost, ", tree", tree+")")
	}
}
