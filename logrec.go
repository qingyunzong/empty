// Package logrec reconstructs a replicated log from a checkpoint version
// and multiple overlapping log segments.
//
// Merge rules:
//   - Entries with the same sequence number and identical content are
//     deduplicated.
//   - Entries with the same sequence number but different content are
//     rejected as a conflict.
//   - Gaps in the sequence (a missing sequence number with higher-numbered
//     entries present) are rejected, reporting the first missing sequence
//     number and the source segments bordering the gap.
//   - Only the contiguous prefix immediately following the checkpoint
//     version is applied.
package logrec

import (
	"bufio"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Entry is a single log record read from a segment.
type Entry struct {
	Seq     uint64
	Content string
	Source  string // name of the segment the entry was read from
	Line    int    // 1-based line number within the segment
}

// Segment is a named, ordered list of log entries.
type Segment struct {
	Name    string
	Entries []Entry
}

// ParseSegment reads a segment from r. Each non-empty line has the form
// "<seq> <content>", where <seq> is an unsigned integer and <content> is
// the remainder of the line (which may be empty or contain spaces).
// Lines that are empty or start with '#' are ignored.
func ParseSegment(name string, r io.Reader) (Segment, error) {
	seg := Segment{Name: name}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimRight(scanner.Text(), "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		seqField, content, _ := strings.Cut(trimmed, " ")
		seq, err := strconv.ParseUint(seqField, 10, 64)
		if err != nil {
			return seg, fmt.Errorf("%s:%d: invalid sequence number %q", name, lineNo, seqField)
		}
		seg.Entries = append(seg.Entries, Entry{
			Seq:     seq,
			Content: strings.TrimLeft(content, " "),
			Source:  name,
			Line:    lineNo,
		})
	}
	if err := scanner.Err(); err != nil {
		return seg, fmt.Errorf("%s: %w", name, err)
	}
	return seg, nil
}

// ConflictError reports two entries that share a sequence number but carry
// different content.
type ConflictError struct {
	Seq          uint64
	FirstSource  string
	FirstLine    int
	SecondSource string
	SecondLine   int
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflicting content for sequence %d (%s:%d vs %s:%d)",
		e.Seq, e.FirstSource, e.FirstLine, e.SecondSource, e.SecondLine)
}

// GapError reports the first sequence number missing after the checkpoint
// while higher-numbered entries are present. Sources lists the segments
// bordering the gap.
type GapError struct {
	Missing uint64
	Sources []string
}

func (e *GapError) Error() string {
	return fmt.Sprintf("missing sequence %d (gap bordered by segments: %s)",
		e.Missing, strings.Join(e.Sources, ", "))
}

// Recover merges the given segments and returns the contiguous prefix of
// entries immediately following checkpoint, together with the first
// sequence number missing after that prefix (i.e. the next sequence the
// log is waiting for).
//
// It returns a *ConflictError if any two entries share a sequence number
// with different content, and a *GapError if entries exist beyond the
// first missing sequence number.
func Recover(checkpoint uint64, segs []Segment) (applied []Entry, nextMissing uint64, err error) {
	bySeq := make(map[uint64]Entry)
	for _, seg := range segs {
		for _, e := range seg.Entries {
			prev, ok := bySeq[e.Seq]
			if ok {
				if prev.Content != e.Content {
					return nil, 0, &ConflictError{
						Seq:          e.Seq,
						FirstSource:  prev.Source,
						FirstLine:    prev.Line,
						SecondSource: e.Source,
						SecondLine:   e.Line,
					}
				}
				continue // same seq, same content: deduplicate
			}
			bySeq[e.Seq] = e
		}
	}

	next := checkpoint + 1
	if next < checkpoint { // checkpoint == math.MaxUint64
		return nil, checkpoint, nil
	}
	for {
		e, ok := bySeq[next]
		if !ok {
			break
		}
		applied = append(applied, e)
		next++
		if next == 0 { // overflow guard
			break
		}
	}
	missing := next

	beyond := false
	for seq := range bySeq {
		if seq > missing {
			beyond = true
			break
		}
	}
	if beyond {
		return nil, missing, &GapError{Missing: missing, Sources: gapSources(missing, segs)}
	}
	return applied, missing, nil
}

// gapSources names the segments bordering a gap at the missing sequence
// number: segments that straddle the gap (holding entries on both sides),
// or, if no segment straddles it, the segments holding the nearest entries
// below and above the gap.
func gapSources(missing uint64, segs []Segment) []string {
	straddle := make(map[string]bool)
	below := make(map[uint64]map[string]bool) // seq -> segments containing it
	above := make(map[uint64]map[string]bool)
	var maxBelow, minAbove uint64
	haveBelow, haveAbove := false, false

	for _, seg := range segs {
		var lo, hi uint64
		haveLo, haveHi := false, false
		for _, e := range seg.Entries {
			if e.Seq < missing {
				if !haveLo || e.Seq > lo {
					lo = e.Seq
					haveLo = true
				}
				if !haveBelow || e.Seq > maxBelow {
					maxBelow = e.Seq
					haveBelow = true
				}
				if below[e.Seq] == nil {
					below[e.Seq] = make(map[string]bool)
				}
				below[e.Seq][seg.Name] = true
			}
			if e.Seq > missing {
				if !haveHi || e.Seq < hi {
					hi = e.Seq
					haveHi = true
				}
				if !haveAbove || e.Seq < minAbove {
					minAbove = e.Seq
					haveAbove = true
				}
				if above[e.Seq] == nil {
					above[e.Seq] = make(map[string]bool)
				}
				above[e.Seq][seg.Name] = true
			}
		}
		if haveLo && haveHi {
			straddle[seg.Name] = true
		}
	}

	names := make(map[string]bool)
	if len(straddle) > 0 {
		for name := range straddle {
			names[name] = true
		}
	} else {
		if haveBelow {
			for name := range below[maxBelow] {
				names[name] = true
			}
		}
		if haveAbove {
			for name := range above[minAbove] {
				names[name] = true
			}
		}
	}

	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
