// Package cli wires the JSON command-line interface of travelcli.
package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"travelcli/internal/solver"
)

const usage = `travelcli - travel fare optimizer

Usage:
  travelcli cover    [-i input.json] [-o output.json] [-verify]
  travelcli activate [-i input.json] [-o output.json] [-verify]

Input is JSON on stdin (or -i file):

  cover:    {"days":[1,2,3],"tickets":[{"id":"A","cost":5,"days":[1,2]}]}
  activate: {"days":[1,2,3],
             "tickets":[{"id":"P","kind":"pass","cost":10,"validity":3,"cap":3}]}

Ticket kinds for activate: "single" (validity=1, cap=1), "interval",
"pass" (cap defaults to validity). Objective: minimum cost, then fewest
tickets, then lexicographically smallest sorted ticket-id sequence.
`

// Main runs the CLI and returns the process exit code.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) < 2 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[1] {
	case "cover":
		err = run(args[2:], stdin, stdout, solveCover)
	case "activate":
		err = run(args[2:], stdin, stdout, solveActivate)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n%s", args[1], usage)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "travelcli: %v\n", err)
		return 1
	}
	return 0
}

// solveFunc decodes in, solves, and returns the output object.
type solveFunc func(in json.RawMessage, verify bool) (any, error)

func run(args []string, stdin io.Reader, stdout io.Writer, fn solveFunc) error {
	fs := flag.NewFlagSet("travelcli", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	inPath := fs.String("i", "-", "input file (- for stdin)")
	outPath := fs.String("o", "-", "output file (- for stdout)")
	verify := fs.Bool("verify", false, "verify the certificate and brute-force the optimum")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var raw []byte
	var err error
	if *inPath == "-" {
		raw, err = io.ReadAll(stdin)
	} else {
		raw, err = os.ReadFile(*inPath)
	}
	if err != nil {
		return err
	}
	out, err := fn(raw, *verify)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if *outPath == "-" {
		_, err = stdout.Write(data)
	} else {
		err = os.WriteFile(*outPath, data, 0o644)
	}
	return err
}

type coverTicketJSON struct {
	ID   string `json:"id"`
	Cost int    `json:"cost"`
	Days []int  `json:"days"`
}

type coverInput struct {
	Days    []int             `json:"days"`
	Tickets []coverTicketJSON `json:"tickets"`
}

type coverOutput struct {
	*solver.CoverSolution
	Verified         *bool  `json:"verified,omitempty"`
	VerificationNote string `json:"verificationNote,omitempty"`
}

func solveCover(raw json.RawMessage, verify bool) (any, error) {
	var in coverInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, fmt.Errorf("invalid input: %w", err)
	}
	tickets := make([]solver.CoverTicket, len(in.Tickets))
	for i, t := range in.Tickets {
		tickets[i] = solver.CoverTicket{ID: t.ID, Cost: t.Cost, Days: t.Days}
	}
	sol, err := solver.SolveCover(in.Days, tickets)
	if err != nil {
		return nil, err
	}
	out := &coverOutput{CoverSolution: sol}
	if verify {
		ok, note := verifyCover(in.Days, tickets, sol)
		out.Verified = &ok
		out.VerificationNote = note
		if !ok {
			return out, errors.New("verification failed: " + note)
		}
	}
	return out, nil
}

func verifyCover(days []int, tickets []solver.CoverTicket, sol *solver.CoverSolution) (bool, string) {
	if err := solver.CheckCoverCertificate(days, tickets, sol); err != nil {
		return false, "certificate invalid: " + err.Error()
	}
	bf, err := solver.BruteForceCover(days, tickets)
	if err != nil {
		return false, "brute force: " + err.Error()
	}
	if !solver.SameOptimum(sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs) {
		return false, fmt.Sprintf("solver optimum (%d,%d,%v) != brute force (%d,%d,%v)",
			sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs)
	}
	return true, "certificate valid; optimum confirmed by exhaustive search"
}

type actTicketJSON struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Cost     int    `json:"cost"`
	Validity int    `json:"validity"`
	Cap      int    `json:"cap"`
}

type actInput struct {
	Days    []int           `json:"days"`
	Tickets []actTicketJSON `json:"tickets"`
}

type actOutput struct {
	*solver.ActSolution
	Verified         *bool  `json:"verified,omitempty"`
	VerificationNote string `json:"verificationNote,omitempty"`
}

func solveActivate(raw json.RawMessage, verify bool) (any, error) {
	var in actInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, fmt.Errorf("invalid input: %w", err)
	}
	tickets := make([]solver.ActTicket, len(in.Tickets))
	for i, t := range in.Tickets {
		tk, err := normalizeKind(t)
		if err != nil {
			return nil, err
		}
		tickets[i] = tk
	}
	sol, err := solver.SolveActivate(in.Days, tickets)
	if err != nil {
		return nil, err
	}
	out := &actOutput{ActSolution: sol}
	if verify {
		ok, note := verifyActivate(in.Days, tickets, sol)
		out.Verified = &ok
		out.VerificationNote = note
		if !ok {
			return out, errors.New("verification failed: " + note)
		}
	}
	return out, nil
}

// normalizeKind applies ticket-kind presets: "single" is a one-day one-ride
// ticket, "pass" defaults its cap to its validity, "interval" uses the
// explicit validity and cap.
func normalizeKind(t actTicketJSON) (solver.ActTicket, error) {
	tk := solver.ActTicket{ID: t.ID, Cost: t.Cost, Validity: t.Validity, Cap: t.Cap}
	switch t.Kind {
	case "single":
		tk.Validity, tk.Cap = 1, 1
	case "pass", "interval", "":
		if tk.Validity < 1 {
			return tk, fmt.Errorf("ticket %q: validity must be >= 1", t.ID)
		}
		if tk.Cap < 1 {
			tk.Cap = tk.Validity
		}
	default:
		return tk, fmt.Errorf("ticket %q: unknown kind %q", t.ID, t.Kind)
	}
	return tk, nil
}

func verifyActivate(days []int, tickets []solver.ActTicket, sol *solver.ActSolution) (bool, string) {
	if err := solver.CheckActCertificate(days, tickets, sol); err != nil {
		return false, "certificate invalid: " + err.Error()
	}
	bf, err := solver.BruteForceActivate(days, tickets)
	if errors.Is(err, solver.ErrTooLarge) {
		return true, "certificate valid; instance too large for brute-force optimum check"
	}
	if err != nil {
		return false, "brute force: " + err.Error()
	}
	if !solver.SameOptimum(sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs) {
		return false, fmt.Sprintf("solver optimum (%d,%d,%v) != brute force (%d,%d,%v)",
			sol.Cost, sol.Count, sol.IDs, bf.Cost, bf.Count, bf.IDs)
	}
	return true, "certificate valid; optimum confirmed by exhaustive search"
}
