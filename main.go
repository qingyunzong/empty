package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "assertplan: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("assertplan", flag.ContinueOnError)
	specPath := fs.String("spec", "", "path to a JSON spec; defaults to the built-in 18x12 instance")
	outPath := fs.String("o", "", "write the coverage certificate to this file instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var spec Spec
	if *specPath == "" {
		spec = DefaultSpec()
	} else {
		data, err := os.ReadFile(*specPath)
		if err != nil {
			return fmt.Errorf("read spec: %w", err)
		}
		if err := json.Unmarshal(data, &spec); err != nil {
			return fmt.Errorf("parse spec %s: %w", *specPath, err)
		}
	}

	inst, err := NewInstance(spec)
	if err != nil {
		return err
	}
	cert := Solve(inst)

	if *outPath == "" {
		fmt.Fprint(stdout, cert.String())
		return nil
	}
	if err := os.WriteFile(*outPath, []byte(cert.String()), 0o644); err != nil {
		return fmt.Errorf("write certificate: %w", err)
	}
	fmt.Fprintf(stdout, "certificate written to %s\n", *outPath)
	return nil
}
