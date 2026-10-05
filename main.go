package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

const usage = `testmatrix - pairwise test-matrix generator with legality/coverage certificates

Usage:
  testmatrix solve  -spec spec.json [-max 30] [-exact-limit 20] [-cert cert.json]
  testmatrix verify -spec spec.json -cert cert.json [-exact-limit 20]

Spec format (JSON):
  {
    "dimensions": [{"name": "os", "values": ["linux", "win"]}, ...],
    "forbidden": [{"os": "win", "browser": "safari"}],
    "preconditions": [{"when": {"db": "mysql"}, "require": {"os": "linux"}}]
  }
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "solve":
		os.Exit(runSolve(os.Args[2:]))
	case "verify":
		os.Exit(runVerify(os.Args[2:]))
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func loadSpec(path string) (*Spec, error) {
	var r io.Reader
	if path == "-" {
		r = os.Stdin
	} else {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	var s Spec
	if err := json.NewDecoder(r).Decode(&s); err != nil {
		return nil, fmt.Errorf("decoding spec: %w", err)
	}
	if err := s.Validate(); err != nil {
		return nil, fmt.Errorf("invalid spec: %w", err)
	}
	return &s, nil
}

func runSolve(args []string) int {
	fs := flag.NewFlagSet("solve", flag.ContinueOnError)
	specPath := fs.String("spec", "-", "spec JSON file ('-' for stdin)")
	maxConfigs := fs.Int("max", 30, "maximum number of candidate configurations")
	exactLimit := fs.Int("exact-limit", 20, "max legal-config universe size for exhaustive subset-enumeration minimality check (0 disables)")
	certPath := fs.String("cert", "-", "certificate output file ('-' for stdout)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	spec, err := loadSpec(*specPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	cert, err := BuildCertificate(spec, *maxConfigs, *exactLimit)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	// Self-check before emitting.
	if bad := VerifyCertificate(spec, cert, *exactLimit); len(bad) > 0 {
		for _, b := range bad {
			fmt.Fprintln(os.Stderr, "self-verification failed:", b)
		}
		return 1
	}
	out, err := json.MarshalIndent(cert, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if *certPath == "-" {
		fmt.Println(string(out))
	} else {
		if err := os.WriteFile(*certPath, append(out, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			return 1
		}
	}
	printSummary(os.Stderr, cert)
	return 0
}

func printSummary(w io.Writer, cert *Certificate) {
	fmt.Fprintf(w, "configs: %d (cap %d)\n", cert.ConfigCount, cert.MaxConfigs)
	fmt.Fprintf(w, "pairs covered: %d, uncoverable: %d, uncovered-due-to-cap: %d\n",
		len(cert.Coverage), len(cert.UncoverablePairs), len(cert.UncoveredPairs))
	if cert.Minimality != nil {
		fmt.Fprintf(w, "minimality: %s over %d legal configs, optimal=%d solution=%d verified=%v\n",
			cert.Minimality.Method, cert.Minimality.LegalConfigCount,
			cert.Minimality.OptimalSize, cert.Minimality.SolutionSize, cert.Minimality.Verified)
	} else {
		fmt.Fprintln(w, "minimality: not checked (legal universe too large or disabled)")
	}
}

func runVerify(args []string) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	specPath := fs.String("spec", "-", "spec JSON file ('-' for stdin)")
	certPath := fs.String("cert", "", "certificate JSON file (required)")
	exactLimit := fs.Int("exact-limit", 20, "max legal-config universe size for re-checking minimality (0 disables)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *certPath == "" {
		fmt.Fprintln(os.Stderr, "error: -cert is required")
		return 2
	}
	spec, err := loadSpec(*specPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	data, err := os.ReadFile(*certPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	var cert Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		fmt.Fprintln(os.Stderr, "error: decoding certificate:", err)
		return 1
	}
	bad := VerifyCertificate(spec, &cert, *exactLimit)
	if len(bad) > 0 {
		for _, b := range bad {
			fmt.Fprintln(os.Stderr, "INVALID:", b)
		}
		return 1
	}
	fmt.Printf("certificate valid: %d configs, %d pairs covered, %d uncoverable pairs\n",
		cert.ConfigCount, len(cert.Coverage), len(cert.UncoverablePairs))
	return 0
}
