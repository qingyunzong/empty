package main

import (
	"fmt"
	"os"
)

func usage() {
	fmt.Fprintf(os.Stderr, `auditcli - hash chain segment auditor

usage:
  auditcli check <file.jsonl>          full-graph check: corrupted payloads, conflicts, missing refs
  auditcli path  <file.jsonl> <digest> print the full path from a head digest to genesis
  auditcli heads <file.jsonl>          list head digests (segments with no successor)
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	cmd, file := os.Args[1], os.Args[2]
	g, err := LoadFile(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load:", err)
		os.Exit(1)
	}
	switch cmd {
	case "check":
		os.Exit(runCheck(g))
	case "path":
		if len(os.Args) < 4 {
			usage()
		}
		os.Exit(runPath(g, os.Args[3]))
	case "heads":
		for _, h := range g.Heads() {
			fmt.Println(h)
		}
	default:
		usage()
	}
}

func runCheck(g *Graph) int {
	res := g.Verify()
	fmt.Printf("segments: %d, duplicates ignored: %d\n", res.Total, res.Duplicates)
	for _, c := range res.Corrupted {
		fmt.Printf("CORRUPT digest=%s line=%d recomputed=%s payload=%q\n", c.Digest, c.Line, c.Recomputed, c.Payload)
	}
	for _, c := range res.Conflicts {
		fmt.Printf("CONFLICT digest=%s kept-line=%d rejected-line=%d\n", c.Digest, c.Kept.Line, c.Rejected.Line)
	}
	for _, m := range res.MissingRefs {
		fmt.Printf("MISSING-REF prev=%s\n", m)
	}
	if res.OK() {
		fmt.Println("OK")
		return 0
	}
	return 1
}

func runPath(g *Graph, head string) int {
	res := g.Path(head)
	switch res.Status {
	case PathOK:
		for i, seg := range res.Path {
			fmt.Printf("%d digest=%s payload=%q\n", i, seg.Digest, seg.Payload)
		}
		fmt.Printf("OK depth=%d\n", len(res.Path))
		return 0
	case PathMissingAncestor:
		fmt.Printf("MISSING-ANCESTOR digest=%s after %d resolved segment(s)\n", res.Missing, len(res.Path))
		return 1
	case PathCycle:
		fmt.Printf("CYCLE at digest=%s after %d resolved segment(s)\n", res.CycleAt, len(res.Path))
		return 1
	}
	return 1
}
