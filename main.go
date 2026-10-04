package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	inputPath := flag.String("input", "", "path to input JSON (default: read stdin)")
	flag.Parse()

	var data []byte
	var err error
	if *inputPath == "" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(*inputPath)
	}
	if err != nil {
		fatal("read input: %v", err)
	}

	var in Input
	if err := json.Unmarshal(data, &in); err != nil {
		fatal("parse input JSON: %v", err)
	}

	plan, err := Solve(&in)
	if err != nil {
		fatal("%v", err)
	}
	if err := Verify(&in, plan); err != nil {
		fatal("internal error: solver produced invalid plan: %v", err)
	}

	out := struct {
		*Plan
		Verified    bool     `json:"verified"`
		Certificate []string `json:"certificate"`
	}{Plan: plan, Verified: true, Certificate: Certificate(&in, plan)}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fatal("write output: %v", err)
	}
}

func fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	json.NewEncoder(os.Stderr).Encode(map[string]string{"error": msg})
	os.Exit(1)
}
