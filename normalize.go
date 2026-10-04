package pathnorm

import (
	"errors"
	"fmt"
	"strings"
)

// Sentinel errors for rejected paths. Use errors.Is to match them; the
// returned *PathError wraps them with the offending segment and path.
var (
	// ErrEmptySegment reports a path containing an empty segment
	// (leading, trailing, or repeated '/').
	ErrEmptySegment = errors.New("pathnorm: empty segment")
	// ErrUpwardSegment reports a path containing an upward ("..") segment.
	ErrUpwardSegment = errors.New("pathnorm: upward segment")
)

// PathError describes a rejected path, preserving the original input as
// evidence.
type PathError struct {
	Err      error  // one of ErrEmptySegment, ErrUpwardSegment
	Path     string // original path as supplied by the caller
	Segment  string // offending segment
	Position int    // zero-based segment index
}

func (e *PathError) Error() string {
	return fmt.Sprintf("%v: segment %d %q in path %q", e.Err, e.Position, e.Segment, e.Path)
}

func (e *PathError) Unwrap() error { return e.Err }

// CollisionError reports that two different original paths normalized to
// the same name. The whole batch is rejected when this occurs.
type CollisionError struct {
	Normalized string // colliding normalized path
	First      string // original path seen first
	Second     string // original path seen later
}

func (e *CollisionError) Error() string {
	return fmt.Sprintf("pathnorm: normalization collision: %q and %q both normalize to %q",
		e.First, e.Second, e.Normalized)
}

// Record pairs an original path with its normalized form; it is the
// evidence trail for a batch normalization.
type Record struct {
	Original   string
	Normalized string
}

// BatchResult is the outcome of a successful NormalizeBatch call.
type BatchResult struct {
	// Records lists every input path in input order with its normalized
	// form.
	Records []Record
	// Evidence maps each normalized path to the original path that
	// produced it (first occurrence wins).
	Evidence map[string]string
}

// Normalizer normalizes paths under a fixed folding map and case rule.
// The zero value is not valid; construct one with New.
type Normalizer struct {
	folding FoldingMap
	rule    CaseRule
}

// New returns a Normalizer using the given folding map and case rule. The
// map is retained by reference and must not be mutated afterwards.
func New(folding FoldingMap, rule CaseRule) *Normalizer {
	return &Normalizer{folding: folding, rule: rule}
}

// NormalizeSegment normalizes a single path segment. The result always
// matches Interpret with the same map and rule.
func (n *Normalizer) NormalizeSegment(seg string) string {
	return Interpret(n.folding, n.rule, seg)
}

// NormalizePath normalizes a slash-separated path segment by segment and
// rejoins it with '/'. Empty segments and upward ("..") segments are
// rejected with a *PathError wrapping ErrEmptySegment or ErrUpwardSegment.
// A "." segment is allowed and normalized like any other segment.
func (n *Normalizer) NormalizePath(path string) (string, error) {
	segments := strings.Split(path, "/")
	for i, seg := range segments {
		switch {
		case seg == "":
			return "", &PathError{Err: ErrEmptySegment, Path: path, Segment: seg, Position: i}
		case seg == "..":
			return "", &PathError{Err: ErrUpwardSegment, Path: path, Segment: seg, Position: i}
		}
		segments[i] = n.NormalizeSegment(seg)
	}
	return strings.Join(segments, "/"), nil
}

// NormalizeBatch normalizes every path in the batch. If two different
// original paths normalize to the same name, the entire batch is rejected
// with a *CollisionError and no result is returned. Repeating the exact
// same original path is not a collision. Any invalid path likewise
// rejects the whole batch.
func (n *Normalizer) NormalizeBatch(paths []string) (*BatchResult, error) {
	result := &BatchResult{
		Records:  make([]Record, 0, len(paths)),
		Evidence: make(map[string]string, len(paths)),
	}
	for _, original := range paths {
		normalized, err := n.NormalizePath(original)
		if err != nil {
			return nil, err
		}
		if first, seen := result.Evidence[normalized]; seen {
			if first != original {
				return nil, &CollisionError{
					Normalized: normalized,
					First:      first,
					Second:     original,
				}
			}
		} else {
			result.Evidence[normalized] = original
		}
		result.Records = append(result.Records, Record{Original: original, Normalized: normalized})
	}
	return result, nil
}
