// Command histcli checks whether the delivery logs of three nodes are
// prefix-consistent in the same order. A crashed node may legitimately
// hold a shorter prefix; a node of unknown status is never counted as a
// fault. The earliest conflict is reported together with its two sources.
//
// Usage:
//
//	histcli init   -state FILE -node ID=STATUS -node ID=STATUS -node ID=STATUS
//	histcli append -state FILE -node ID -entry SEQ:VALUE [-entry SEQ:VALUE ...]
//	histcli check  -state FILE
//
// append updates the checker incrementally; every run cross-checks the
// incremental result against the full all-pairs comparison model.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"histcli/logcheck"
)

const wantNodes = 3

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type state struct {
	Nodes []*logcheck.Node `json:"nodes"`
}

func loadState(path string) (*state, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st state
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if len(st.Nodes) != wantNodes {
		return nil, fmt.Errorf("state holds %d nodes, want exactly %d", len(st.Nodes), wantNodes)
	}
	return &st, nil
}

func saveState(path string, st *state) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = cmdInit(os.Args[2:])
	case "append":
		err = cmdAppend(os.Args[2:])
	case "check":
		err = cmdCheck(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  histcli init   -state FILE -node ID=STATUS ... (exactly 3 nodes; STATUS is alive|crashed|unknown)
  histcli append -state FILE -node ID -entry SEQ:VALUE [-entry SEQ:VALUE ...]
  histcli check  -state FILE
`)
}

func cmdInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	statePath := fs.String("state", "", "state file path")
	var nodeSpecs stringList
	fs.Var(&nodeSpecs, "node", "ID=STATUS (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *statePath == "" {
		return errors.New("-state is required")
	}
	if len(nodeSpecs) != wantNodes {
		return fmt.Errorf("need exactly %d -node flags, got %d", wantNodes, len(nodeSpecs))
	}
	st := &state{}
	for _, spec := range nodeSpecs {
		id, statusText, ok := strings.Cut(spec, "=")
		if !ok || id == "" {
			return fmt.Errorf("bad -node %q, want ID=STATUS", spec)
		}
		status, err := logcheck.ParseStatus(statusText)
		if err != nil {
			return err
		}
		st.Nodes = append(st.Nodes, &logcheck.Node{ID: id, Status: status})
	}
	checker, err := logcheck.NewChecker(st.Nodes)
	if err != nil {
		return err
	}
	if err := saveState(*statePath, st); err != nil {
		return err
	}
	printReport(checker, st.Nodes)
	return nil
}

func cmdAppend(args []string) error {
	fs := flag.NewFlagSet("append", flag.ContinueOnError)
	statePath := fs.String("state", "", "state file path")
	nodeID := fs.String("node", "", "node ID to append to")
	var entrySpecs stringList
	fs.Var(&entrySpecs, "entry", "SEQ:VALUE (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *statePath == "" || *nodeID == "" {
		return errors.New("-state and -node are required")
	}
	if len(entrySpecs) == 0 {
		return errors.New("at least one -entry is required")
	}
	var entries []logcheck.Entry
	for _, spec := range entrySpecs {
		seqText, value, ok := strings.Cut(spec, ":")
		if !ok {
			return fmt.Errorf("bad -entry %q, want SEQ:VALUE", spec)
		}
		seq, err := strconv.ParseInt(seqText, 10, 64)
		if err != nil {
			return fmt.Errorf("bad -entry %q: %v", spec, err)
		}
		entries = append(entries, logcheck.Entry{Seq: seq, Value: value})
	}

	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	checker, err := logcheck.NewChecker(st.Nodes)
	if err != nil {
		return err
	}
	if err := checker.Append(*nodeID, entries...); err != nil {
		return err
	}
	if err := saveState(*statePath, st); err != nil {
		return err
	}
	printReport(checker, st.Nodes)
	return nil
}

func cmdCheck(args []string) error {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	statePath := fs.String("state", "", "state file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *statePath == "" {
		return errors.New("-state is required")
	}
	st, err := loadState(*statePath)
	if err != nil {
		return err
	}
	checker, err := logcheck.NewChecker(st.Nodes)
	if err != nil {
		return err
	}
	printReport(checker, st.Nodes)
	return nil
}

// printReport prints the incremental checker's report and cross-checks it
// against the full all-pairs comparison model.
func printReport(checker *logcheck.Checker, nodes []*logcheck.Node) {
	rep := checker.Report()
	full, err := logcheck.FullReport(nodes)
	switch {
	case err != nil:
		fmt.Println("cross-check: full model error:", err)
		os.Exit(1)
	case !sameReport(rep, full):
		fmt.Println("cross-check: MISMATCH between incremental checker and full model")
		fmt.Println("cross-check: incremental:", describe(rep))
		fmt.Println("cross-check: full model:", describe(full))
		os.Exit(1)
	default:
		fmt.Println("cross-check: incremental == full model")
	}
	fmt.Println(describe(rep))
}

func sameReport(a, b logcheck.Report) bool {
	if a.Verdict != b.Verdict || len(a.Short) != len(b.Short) {
		return false
	}
	if (a.Conflict == nil) != (b.Conflict == nil) {
		return false
	}
	if a.Conflict != nil && *a.Conflict != *b.Conflict {
		return false
	}
	for i := range a.Short {
		if a.Short[i] != b.Short[i] {
			return false
		}
	}
	return true
}

func describe(rep logcheck.Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "verdict: %s", rep.Verdict)
	if rep.Conflict != nil {
		c := rep.Conflict
		fmt.Fprintf(&b, "\nearliest conflict: index %d", c.Index)
		fmt.Fprintf(&b, "\nsources: %s, %s", c.SourceA, c.SourceB)
		fmt.Fprintf(&b, "\n  %s: seq=%d value=%q", c.SourceA, c.EntryA.Seq, c.EntryA.Value)
		fmt.Fprintf(&b, "\n  %s: seq=%d value=%q", c.SourceB, c.EntryB.Seq, c.EntryB.Value)
	}
	for _, n := range rep.Short {
		reason := "allowed (crashed)"
		switch n.Status {
		case logcheck.StatusUnknown:
			reason = "not counted as fault (status unknown)"
		case logcheck.StatusAlive:
			reason = "fault: alive node trailing"
		}
		fmt.Fprintf(&b, "\nshort prefix: node %s len=%d of %d, status=%s: %s",
			n.NodeID, n.Len, n.MaxLen, n.Status, reason)
	}
	return b.String()
}
