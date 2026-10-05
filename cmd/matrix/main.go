// Command matrix builds a minimal test-configuration matrix covering all
// legal value pairs of a spec, and emits a verifiable certificate.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"matrix/matrix"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	var specPath, certPath string
	var maxConfigs int
	rest := args
	for len(rest) > 0 {
		switch rest[0] {
		case "-spec":
			if len(rest) < 2 {
				fmt.Fprintln(stderr, "missing value for -spec")
				return 2
			}
			specPath = rest[1]
			rest = rest[2:]
		case "-cert":
			if len(rest) < 2 {
				fmt.Fprintln(stderr, "missing value for -cert")
				return 2
			}
			certPath = rest[1]
			rest = rest[2:]
		case "-max":
			if len(rest) < 2 {
				fmt.Fprintln(stderr, "missing value for -max")
				return 2
			}
			if _, err := fmt.Sscanf(rest[1], "%d", &maxConfigs); err != nil {
				fmt.Fprintf(stderr, "invalid -max value: %v\n", err)
				return 2
			}
			rest = rest[2:]
		case "-h", "--help":
			fmt.Fprintln(stderr, "usage: matrix [-spec spec.json|-] [-cert cert.json|-] [-max N]")
			return 0
		default:
			fmt.Fprintf(stderr, "unknown argument %q\n", rest[0])
			return 2
		}
	}
	if specPath == "" {
		specPath = "-"
	}
	if certPath == "" {
		certPath = "-"
	}
	if maxConfigs == 0 {
		maxConfigs = 30
	}

	var specReader io.Reader
	if specPath == "-" {
		specReader = os.Stdin
	} else {
		f, err := os.Open(specPath)
		if err != nil {
			fmt.Fprintf(stderr, "open spec: %v\n", err)
			return 1
		}
		defer f.Close()
		specReader = f
	}
	spec, err := matrix.LoadSpec(specReader)
	if err != nil {
		fmt.Fprintf(stderr, "invalid spec: %v\n", err)
		return 1
	}

	cert, err := matrix.Solve(spec, maxConfigs)
	if err != nil {
		var limit *matrix.ErrLimit
		if errors.As(err, &limit) {
			fmt.Fprintf(stderr, "infeasible: %v\n", err)
			return 1
		}
		fmt.Fprintf(stderr, "solve: %v\n", err)
		return 1
	}

	data, err := json.MarshalIndent(cert, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "encode certificate: %v\n", err)
		return 1
	}
	data = append(data, '\n')
	if certPath == "-" {
		if _, err := stdout.Write(data); err != nil {
			fmt.Fprintf(stderr, "write certificate: %v\n", err)
			return 1
		}
	} else {
		if err := os.WriteFile(certPath, data, 0o644); err != nil {
			fmt.Fprintf(stderr, "write certificate: %v\n", err)
			return 1
		}
	}

	fmt.Fprintf(stderr, "configs: %d (minimality: %s), pairs covered: %d, uncoverable pairs: %d, certificate verified\n",
		len(cert.Configs), cert.Minimality, len(cert.Coverage), len(cert.Uncoverable))
	return 0
}
