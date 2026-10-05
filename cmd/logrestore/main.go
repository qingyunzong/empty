// Command logrestore rebuilds a log from a checkpoint version and several
// overlapping segment files.
//
// Usage:
//
//	logrestore -checkpoint N seg1.log seg2.log ...
//	logrestore -checkpoint-file state.txt seg1.log seg2.log ...
//
// Each segment file holds one entry per line: "<seq> <content>".
// Applied entries are printed as "<seq>\t<content>" (source segment on
// stderr with -v). A gap or a content conflict rejects the restore with a
// non-zero exit code.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"logrestore/restore"
)

func main() {
	checkpoint := flag.Int("checkpoint", -1, "checkpoint version: last applied sequence number")
	checkpointFile := flag.String("checkpoint-file", "", "file holding the checkpoint version")
	verbose := flag.Bool("v", false, "print the source segment of each applied entry to stderr")
	flag.Parse()
	segments := flag.Args()
	if len(segments) == 0 {
		fmt.Fprintln(os.Stderr, "usage: logrestore [-checkpoint N | -checkpoint-file F] [-v] seg1.log seg2.log ...")
		os.Exit(64)
	}

	cp := *checkpoint
	if *checkpointFile != "" {
		v, err := readCheckpoint(*checkpointFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "logrestore:", err)
			os.Exit(65)
		}
		cp = v
	}
	if cp < 0 {
		fmt.Fprintln(os.Stderr, "logrestore: checkpoint version required (-checkpoint or -checkpoint-file)")
		os.Exit(64)
	}

	segs := make([]restore.Segment, 0, len(segments))
	for _, path := range segments {
		seg, err := readSegment(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, "logrestore:", err)
			os.Exit(66)
		}
		segs = append(segs, seg)
	}

	res, err := restore.Restore(cp, segs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "logrestore: restore rejected:", err)
		os.Exit(2)
	}
	for _, a := range res.Applied {
		fmt.Printf("%d\t%s\n", a.Seq, a.Data)
		if *verbose {
			fmt.Fprintf(os.Stderr, "applied seq %d from segment %s\n", a.Seq, a.Source)
		}
	}
	fmt.Fprintf(os.Stderr, "checkpoint %d: applied %d entries (up to seq %d)\n",
		cp, len(res.Applied), cp+len(res.Applied))
	if res.Gap != nil {
		fmt.Fprintln(os.Stderr, "logrestore: restore rejected:", res.Gap)
		os.Exit(1)
	}
}

func readCheckpoint(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read checkpoint: %w", err)
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, fmt.Errorf("parse checkpoint %q: %w", path, err)
	}
	return v, nil
}

func readSegment(path string) (restore.Segment, error) {
	f, err := os.Open(path)
	if err != nil {
		return restore.Segment{}, fmt.Errorf("open segment: %w", err)
	}
	defer f.Close()

	seg := restore.Segment{Name: path}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		head, rest, found := strings.Cut(text, " ")
		if !found {
			return restore.Segment{}, fmt.Errorf("%s:%d: want \"<seq> <content>\", got %q", path, line, text)
		}
		seq, err := strconv.Atoi(head)
		if err != nil {
			return restore.Segment{}, fmt.Errorf("%s:%d: bad seq: %w", path, line, err)
		}
		seg.Entries = append(seg.Entries, restore.Entry{Seq: seq, Data: rest})
	}
	if err := sc.Err(); err != nil {
		return restore.Segment{}, fmt.Errorf("read segment %s: %w", path, err)
	}
	return seg, nil
}
