package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run is the CLI entry: backup-verify -manifest full.json pkg1.json pkg2.json ...
// Packages may be listed in any order; the chain is resolved by parent digest.
// Exit 0 prints the restored state; any invalidation exits 1 with the earliest
// failing edge and prints no partial result.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("backup-verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	manifestPath := fs.String("manifest", "", "path to the full manifest JSON (全量清单)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *manifestPath == "" {
		fmt.Fprintln(stderr, "usage: backup-verify -manifest full.json pkg1.json [pkg2.json ...]")
		return 2
	}

	var m Manifest
	if err := loadJSON(*manifestPath, &m); err != nil {
		fmt.Fprintf(stderr, "manifest: %v\n", err)
		return 2
	}
	pkgs := make([]*Package, 0, len(fs.Args()))
	for _, path := range fs.Args() {
		var p Package
		if err := loadJSON(path, &p); err != nil {
			fmt.Fprintf(stderr, "package %s: %v\n", path, err)
			return 2
		}
		pkgs = append(pkgs, &p)
	}

	state, digest, err := Restore(&m, pkgs)
	if err != nil {
		var inv *Invalidation
		if errors.As(err, &inv) {
			fmt.Fprintf(stderr, "INVALID: %v\n", inv)
		} else {
			fmt.Fprintf(stderr, "INVALID: %v\n", err)
		}
		return 1
	}

	fmt.Fprintf(stdout, "digest: %s\n", digest)
	names := make([]string, 0, len(state.Objects))
	for n := range state.Objects {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		o := state.Objects[n]
		fmt.Fprintf(stdout, "object: %s version=%d blocks=%v\n", n, o.Version, o.Blocks)
	}
	return 0
}

func loadJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
