package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

const usage = `replplan - replica placement planner

Usage:
  replplan solve  [-i input.json] [-o plan.json]   min-cost plan + certificate
  replplan brute  [-i input.json]                  brute-force optimum (tiny inputs)
  replplan verify [-i input.json] [-p plan.json]   re-check a plan's certificate

Input JSON:
  {"budget": 100,
   "sites":  [{"id":"dc1","domain":"fdA","capacity":2,"cost":5}, ...],
   "shards": [{"id":"s0","replicas":2}, ...]}

Limits: at most 20 sites and 8 shards. Exit codes: 0 ok, 1 infeasible
or verification failed, 2 usage/IO error.`

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) < 1 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	cmd, rest := args[0], args[1:]
	inPath, outPath, planPath := "-", "-", "-"
	for i := 0; i < len(rest); i++ {
		if i+1 >= len(rest) {
			fmt.Fprintf(stderr, "missing value for %s\n", rest[i])
			return 2
		}
		switch rest[i] {
		case "-i":
			inPath = rest[i+1]
		case "-o":
			outPath = rest[i+1]
		case "-p":
			planPath = rest[i+1]
		default:
			fmt.Fprintf(stderr, "unknown flag %s\n", rest[i])
			return 2
		}
		i++
	}

	readJSON := func(path string, v any) error {
		var data []byte
		var err error
		if path == "-" {
			data, err = io.ReadAll(stdin)
		} else {
			data, err = os.ReadFile(path)
		}
		if err != nil {
			return err
		}
		return json.Unmarshal(data, v)
	}
	writeJSON := func(path string, v any) error {
		data, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		data = append(data, '\n')
		if path == "-" {
			_, err = stdout.Write(data)
			return err
		}
		return os.WriteFile(path, data, 0o644)
	}

	var prob Problem
	if err := readJSON(inPath, &prob); err != nil {
		fmt.Fprintf(stderr, "reading problem: %v\n", err)
		return 2
	}

	switch cmd {
	case "solve":
		plan, err := Solve(&prob)
		if err != nil {
			fmt.Fprintf(stderr, "invalid input: %v\n", err)
			return 2
		}
		if err := writeJSON(outPath, plan); err != nil {
			fmt.Fprintf(stderr, "writing plan: %v\n", err)
			return 2
		}
		if plan.Status != "optimal" {
			return 1
		}
		return 0
	case "brute":
		if err := prob.Validate(); err != nil {
			fmt.Fprintf(stderr, "invalid input: %v\n", err)
			return 2
		}
		cost, ok := bruteForceCost(&prob, true)
		res := map[string]any{"budget": prob.Budget}
		if ok {
			res["status"] = "optimal"
			res["total_cost"] = cost
		} else {
			res["status"] = "infeasible"
		}
		if err := writeJSON(outPath, res); err != nil {
			fmt.Fprintf(stderr, "writing result: %v\n", err)
			return 2
		}
		if !ok {
			return 1
		}
		return 0
	case "verify":
		var plan Plan
		if err := readJSON(planPath, &plan); err != nil {
			fmt.Fprintf(stderr, "reading plan: %v\n", err)
			return 2
		}
		if err := Verify(&prob, &plan); err != nil {
			fmt.Fprintf(stderr, "verification failed: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, "certificate OK")
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n%s", cmd, usage)
		return 2
	}
}
