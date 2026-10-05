// Command imgdiff compares two sparse-image manifests and prints the
// maximal half-open intervals where their content and their layout
// differ, and computes block-granular migration plans that rewrite an
// old image into a new one.
//
// Usage:
//
//	imgdiff diff old.json new.json
//	imgdiff plan -block 4096 old.json new.json
//
// A manifest is JSON: {"size": N, "parent": {...}, "extents": [...]}.
// Each extent is {"start": S, "end": E, "kind": "data"|"hole",
// "digest": "...", "zero": true|false}. Holes read as zero; a zero
// data extent reads the same bytes as a hole but differs in layout.
// Extents not listed are holes. Extents of a child manifest override
// the inherited parent extents in their range.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"imgdiff/imgdiff"
)

func main() {
	os.Exit(run(os.Stdout, os.Args[1:]))
}

func run(w io.Writer, args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, `usage:
  imgdiff diff old.json new.json
  imgdiff plan -block 4096 old.json new.json`)
		return 2
	}
	var err error
	switch args[0] {
	case "diff":
		err = cmdDiff(w, args[1:])
	case "plan":
		err = cmdPlan(w, args[1:])
	default:
		fmt.Fprintf(os.Stderr, "imgdiff: unknown command %q\n", args[0])
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "imgdiff:", err)
		return 1
	}
	return 0
}

func load(path string) (*imgdiff.Manifest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return imgdiff.LoadManifest(f)
}

func cmdDiff(w io.Writer, args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return fmt.Errorf("diff needs exactly two manifest files")
	}
	oldM, err := load(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("old manifest: %w", err)
	}
	newM, err := load(fs.Arg(1))
	if err != nil {
		return fmt.Errorf("new manifest: %w", err)
	}
	oldFlat, err := oldM.Flatten()
	if err != nil {
		return fmt.Errorf("old manifest: %w", err)
	}
	newFlat, err := newM.Flatten()
	if err != nil {
		return fmt.Errorf("new manifest: %w", err)
	}
	content, layout := imgdiff.Diff(oldFlat, oldM.Size, newFlat, newM.Size)
	out := struct {
		Content []imgdiff.Interval `json:"content"`
		Layout  []imgdiff.Interval `json:"layout"`
	}{content, layout}
	if out.Content == nil {
		out.Content = []imgdiff.Interval{}
	}
	if out.Layout == nil {
		out.Layout = []imgdiff.Interval{}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func cmdPlan(w io.Writer, args []string) error {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	block := fs.Uint64("block", 4096, "migration block size in bytes")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return fmt.Errorf("plan needs exactly two manifest files")
	}
	oldM, err := load(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("old manifest: %w", err)
	}
	newM, err := load(fs.Arg(1))
	if err != nil {
		return fmt.Errorf("new manifest: %w", err)
	}
	plan, err := imgdiff.MakePlan(oldM, newM, *block)
	if err != nil {
		return err
	}
	if err := imgdiff.VerifyPlan(oldM, newM, plan); err != nil {
		return fmt.Errorf("generated plan failed verification: %w", err)
	}
	if plan.Steps == nil {
		plan.Steps = []imgdiff.Op{}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(plan)
}
