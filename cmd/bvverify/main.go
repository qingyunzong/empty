// Command bvverify verifies a backup chain (full manifest plus incremental
// packages) and reports the earliest invalid edge, if any.
//
// Usage:
//
//	bvverify -manifest full.json -chunks <dir> [-reorder] pkg1.json pkg2.json ...
//
// Exit codes: 0 chain valid, 1 chain invalid (no partial restore possible),
// 2 usage or I/O error.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"backupverify"
)

type report struct {
	OK          bool               `json:"ok"`
	Edge        *backupverify.Edge `json:"edge,omitempty"`
	StateDigest string             `json:"stateDigest,omitempty"`
	Objects     int                `json:"objects,omitempty"`
	CrossCheck  *crossCheckReport  `json:"crossCheck,omitempty"`
}

// crossCheckReport compares the serial manifest interpreter run on the
// packages exactly as given against the run on the reordered chain.
type crossCheckReport struct {
	Agree      bool               `json:"agree"` // both runs reached the same outcome
	ReorderErr string             `json:"reorderError,omitempty"`
	SerialEdge *backupverify.Edge `json:"serialEdge,omitempty"`
}

func main() {
	manifestPath := flag.String("manifest", "", "path to the full manifest JSON file")
	chunksDir := flag.String("chunks", "", "directory containing chunk files named by hex sha256")
	reorder := flag.Bool("reorder", false, "cross-check by reordering packages via parent links")
	flag.Parse()
	if *manifestPath == "" || *chunksDir == "" || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: bvverify -manifest full.json -chunks <dir> [-reorder] pkg1.json pkg2.json ...")
		os.Exit(2)
	}

	var m backupverify.Manifest
	if err := readJSON(*manifestPath, &m); err != nil {
		fmt.Fprintf(os.Stderr, "bvverify: manifest: %v\n", err)
		os.Exit(2)
	}
	pkgs := make([]*backupverify.Package, 0, flag.NArg())
	for _, path := range flag.Args() {
		var p backupverify.Package
		if err := readJSON(path, &p); err != nil {
			fmt.Fprintf(os.Stderr, "bvverify: %s: %v\n", path, err)
			os.Exit(2)
		}
		pkgs = append(pkgs, &p)
	}

	chunks := backupverify.DirChunkStore(*chunksDir)
	rep := report{}
	if *reorder {
		serial, reordered, agree, err := backupverify.CrossCheck(&m, pkgs, chunks)
		rep.CrossCheck = &crossCheckReport{Agree: agree, SerialEdge: serial.Edge}
		if err != nil {
			// Input is not a permutation of a single chain; the serial
			// result on the given order is the verdict.
			rep.CrossCheck.ReorderErr = err.Error()
			applyResult(&rep, serial)
		} else {
			applyResult(&rep, reordered)
		}
	} else {
		applyResult(&rep, backupverify.Verify(&m, pkgs, chunks))
	}

	out, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(out))
	if !rep.OK {
		os.Exit(1)
	}
}

func applyResult(rep *report, r backupverify.Result) {
	rep.OK = r.OK()
	rep.Edge = r.Edge
	rep.StateDigest = r.StateDigest
	rep.Objects = len(r.State)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
