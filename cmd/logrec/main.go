// Command logrec assembles log records from files or standard input and
// prints records and diagnostics as JSON lines, ordered by byte offset.
//
//	logrec [-max-line N] [-rule start:PREFIX] [-rule cont:PREFIX] [file...]
//
// With no -rule flags, indented lines (space or tab) continue a record and
// all others start one. Exit status is 1 when diagnostics were reported,
// 2 on usage or I/O errors.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"logrec"
)

type ruleFlag []logrec.Rule

func (f *ruleFlag) String() string {
	var b strings.Builder
	for i, r := range *f {
		if i > 0 {
			b.WriteByte(',')
		}
		kind := "start"
		if r.Kind == logrec.Continuation {
			kind = "cont"
		}
		fmt.Fprintf(&b, "%s:%s", kind, r.Prefix)
	}
	return b.String()
}

func (f *ruleFlag) Set(s string) error {
	kind, prefix, found := strings.Cut(s, ":")
	if !found {
		return fmt.Errorf("rule %q: want start:PREFIX or cont:PREFIX", s)
	}
	switch kind {
	case "start":
		*f = append(*f, logrec.Rule{Prefix: prefix, Kind: logrec.Start})
	case "cont":
		*f = append(*f, logrec.Rule{Prefix: prefix, Kind: logrec.Continuation})
	default:
		return fmt.Errorf("rule %q: unknown kind %q", s, kind)
	}
	return nil
}

type event struct {
	File   string   `json:"file,omitempty"`
	Type   string   `json:"type"`
	Kind   string   `json:"kind,omitempty"`
	Offset int64    `json:"offset"`
	End    int64    `json:"end,omitempty"`
	Line   int      `json:"line"`
	Lines  []string `json:"lines,omitempty"`
}

type writer struct{ p *logrec.Parser }

func (w writer) Write(b []byte) (int, error) { w.p.Write(b); return len(b), nil }

func process(name string, src io.Reader, cfg logrec.Config, showFile bool, enc *json.Encoder) (int, error) {
	p, err := logrec.New(cfg)
	if err != nil {
		return 0, err
	}
	if _, err := io.Copy(writer{p}, src); err != nil {
		return 0, err
	}
	p.Close()

	var events []event
	for _, rec := range p.Records() {
		events = append(events, event{Type: "record", Offset: rec.Offset, Line: rec.Line, Lines: rec.Lines})
	}
	for _, d := range p.Diagnostics() {
		events = append(events, event{Type: "diagnostic", Kind: d.Kind.String(), Offset: d.Start, End: d.End, Line: d.Line})
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Offset < events[j].Offset })

	diags := 0
	for i := range events {
		if showFile {
			events[i].File = name
		}
		if events[i].Type == "diagnostic" {
			diags++
		}
		if err := enc.Encode(events[i]); err != nil {
			return diags, err
		}
	}
	return diags, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "logrec:", err)
	os.Exit(2)
}

func main() {
	var rules ruleFlag
	maxLine := flag.Int("max-line", 1<<20, "maximum line length in bytes before the line and following continuation lines are discarded; 0 disables the limit")
	flag.Var(&rules, "rule", "classification rule as start:PREFIX or cont:PREFIX; repeatable, first match wins; with no rules, indented lines continue a record")
	flag.Parse()

	cfg := logrec.Config{Rules: []logrec.Rule(rules), MaxLineBytes: *maxLine}
	enc := json.NewEncoder(os.Stdout)

	diags := 0
	args := flag.Args()
	if len(args) == 0 {
		n, err := process("", os.Stdin, cfg, false, enc)
		if err != nil {
			fatal(err)
		}
		diags += n
	} else {
		for _, name := range args {
			f, err := os.Open(name)
			if err != nil {
				fatal(err)
			}
			n, perr := process(name, f, cfg, len(args) > 1, enc)
			f.Close()
			if perr != nil {
				fatal(perr)
			}
			diags += n
		}
	}
	if diags > 0 {
		os.Exit(1)
	}
}
