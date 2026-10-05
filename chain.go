package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Record is one entry in a hash chain. Digest must equal
// ComputeDigest(Prev, Payload); Prev is the hex digest of the parent
// record, or "" for a genesis record.
type Record struct {
	Digest  string `json:"digest"`
	Prev    string `json:"prev"`
	Payload string `json:"payload"`
}

// ComputeDigest derives a record digest from its parent digest and payload.
func ComputeDigest(prev, payload string) string {
	h := sha256.New()
	if prev != "" {
		b, err := hex.DecodeString(prev)
		if err == nil {
			h.Write(b)
		}
	}
	h.Write([]byte{0})
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}

// locatedRecord ties a record to its position in a segment file.
type locatedRecord struct {
	Record
	Segment string
	Line    int
}

// DigestIssue reports a record whose stored digest does not match the
// digest recomputed from its prev and payload (i.e. tampered payload),
// located by segment file and line.
type DigestIssue struct {
	Segment string
	Line    int
	Stored  string
	Actual  string
}

// MissingIssue reports a digest referenced as a parent but absent from
// the graph.
type MissingIssue struct {
	Digest       string
	ReferencedBy []string
}

// CycleIssue reports a set of digests forming a cycle in the prev graph.
type CycleIssue struct {
	Digests []string
}

// Report is the result of a full-graph check.
type Report struct {
	Records    int
	Segments   int
	Heads      []string
	BadDigests []DigestIssue
	Missing    []MissingIssue
	Cycles     []CycleIssue
}

// OK reports whether the graph has no integrity problems.
func (r *Report) OK() bool {
	return len(r.BadDigests) == 0 && len(r.Missing) == 0 && len(r.Cycles) == 0
}

// loadSegments reads every *.seg file in dir. Each non-empty line is one
// JSON record. Segment files are unordered shards: neither file order
// nor line order affects the resulting graph, which is defined purely
// by prev pointers.
func loadSegments(dir string) ([]locatedRecord, error) {
	names, err := filepath.Glob(filepath.Join(dir, "*.seg"))
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	var out []locatedRecord
	for _, name := range names {
		data, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		base := filepath.Base(name)
		for i, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var rec Record
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				return nil, fmt.Errorf("%s:%d: %w", base, i+1, err)
			}
			out = append(out, locatedRecord{Record: rec, Segment: base, Line: i + 1})
		}
	}
	return out, nil
}

// Check loads all segments in dir and verifies the full graph: stored
// digests, missing ancestors, and cycles. Multiple records sharing the
// same prev are branches, not duplicates.
func Check(dir string) (*Report, error) {
	recs, err := loadSegments(dir)
	if err != nil {
		return nil, err
	}
	rep := &Report{Records: len(recs)}
	seenSeg := map[string]bool{}
	byDigest := map[string]Record{}
	children := map[string]int{}

	// Stored-digest verification, located per segment and line.
	for _, lr := range recs {
		seenSeg[lr.Segment] = true
		if actual := ComputeDigest(lr.Prev, lr.Payload); actual != lr.Digest {
			rep.BadDigests = append(rep.BadDigests, DigestIssue{
				Segment: lr.Segment, Line: lr.Line,
				Stored: lr.Digest, Actual: actual,
			})
		}
	}
	rep.Segments = len(seenSeg)

	// Graph assembly: key by digest. Identical digest implies identical
	// content (digest is content-derived), so re-appearances are true
	// duplicates and are merged; distinct successors of one digest are
	// branches and are allowed.
	for _, lr := range recs {
		if _, ok := byDigest[lr.Digest]; !ok {
			byDigest[lr.Digest] = lr.Record
		}
	}
	missingRefs := map[string][]string{}
	for _, lr := range recs {
		if lr.Prev == "" {
			continue
		}
		children[lr.Prev]++
		if _, ok := byDigest[lr.Prev]; !ok {
			missingRefs[lr.Prev] = append(missingRefs[lr.Prev],
				fmt.Sprintf("%s:%d", lr.Segment, lr.Line))
		}
	}
	for d, refs := range missingRefs {
		sort.Strings(refs)
		rep.Missing = append(rep.Missing, MissingIssue{Digest: d, ReferencedBy: refs})
	}
	sort.Slice(rep.Missing, func(i, j int) bool { return rep.Missing[i].Digest < rep.Missing[j].Digest })

	// Cycle detection: each node has at most one parent, so walking prev
	// links from any unvisited node finds each cycle at most once.
	color := map[string]bool{}
	for d := range byDigest {
		if color[d] {
			continue
		}
		var walk []string
		pos := map[string]int{}
		cur := d
		for cur != "" {
			if color[cur] {
				break
			}
			rec, ok := byDigest[cur]
			if !ok {
				break // missing ancestor, reported separately
			}
			if p, seen := pos[cur]; seen {
				cyc := append([]string(nil), walk[p:]...)
				rep.Cycles = append(rep.Cycles, CycleIssue{Digests: cyc})
				break
			}
			pos[cur] = len(walk)
			walk = append(walk, cur)
			cur = rec.Prev
		}
		for _, w := range walk {
			color[w] = true
		}
	}

	for d := range byDigest {
		if children[d] == 0 {
			rep.Heads = append(rep.Heads, d)
		}
	}
	sort.Strings(rep.Heads)
	return rep, nil
}

// PathResult is the outcome of walking back from a head digest.
type PathResult struct {
	// Path runs from the queried head back toward genesis (head first).
	Path []Record
	// Missing is the digest of the first absent ancestor, if any.
	Missing string
	// Cycle lists the digests of the detected cycle, if any.
	Cycle []string
}

// Path walks the prev chain from head back to genesis. A missing
// ancestor and a cycle are reported separately, never as each other.
func Path(dir, head string) (*PathResult, error) {
	recs, err := loadSegments(dir)
	if err != nil {
		return nil, err
	}
	byDigest := map[string]Record{}
	for _, lr := range recs {
		if _, ok := byDigest[lr.Digest]; !ok {
			byDigest[lr.Digest] = lr.Record
		}
	}
	res := &PathResult{}
	cur := head
	pos := map[string]int{}
	for cur != "" {
		rec, ok := byDigest[cur]
		if !ok {
			res.Missing = cur
			return res, nil
		}
		if p, seen := pos[cur]; seen {
			for _, r := range res.Path[p:] {
				res.Cycle = append(res.Cycle, r.Digest)
			}
			return res, nil
		}
		pos[cur] = len(res.Path)
		res.Path = append(res.Path, rec)
		cur = rec.Prev
	}
	return res, nil
}
