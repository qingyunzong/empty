package fieldsync

import (
	"fmt"
	"sort"
)

// DiffKind classifies a single concrete difference between desired and
// observed state.
type DiffKind string

const (
	DiffFieldMismatch        DiffKind = "field_mismatch"
	DiffAttachmentMissing    DiffKind = "attachment_missing"
	DiffAttachmentUnexpected DiffKind = "attachment_unexpected"
)

// Diff describes one concrete difference. For field diffs, Want/Got hold the
// raw (un-normalized) values; for attachment diffs they hold content hashes.
type Diff struct {
	Kind  DiffKind
	Field string
	Want  string
	Got   string
}

func (d Diff) String() string {
	switch d.Kind {
	case DiffFieldMismatch:
		return fmt.Sprintf("field %q: want %q, got %q", d.Field, d.Want, d.Got)
	case DiffAttachmentMissing:
		return fmt.Sprintf("attachment hash %s missing", d.Want)
	case DiffAttachmentUnexpected:
		return fmt.Sprintf("unexpected attachment hash %s", d.Got)
	default:
		return fmt.Sprintf("%s: want %q, got %q", d.Kind, d.Want, d.Got)
	}
}

// diffBatch compares want against got, applying only the declared rules to
// field values and comparing attachments as an order-insensitive multiset of
// hashes. A field present on one side but absent on the other is always a
// mismatch, even if both normalize to the empty string.
func diffBatch(want, got Batch, rules []EquivalenceRule) []Diff {
	var diffs []Diff

	keys := map[string]struct{}{}
	for k := range want.Fields {
		keys[k] = struct{}{}
	}
	for k := range got.Fields {
		keys[k] = struct{}{}
	}
	sortedKeys := make([]string, 0, len(keys))
	for k := range keys {
		sortedKeys = append(sortedKeys, k)
	}
	sort.Strings(sortedKeys)

	for _, k := range sortedKeys {
		w, wok := want.Fields[k]
		g, gok := got.Fields[k]
		if wok != gok || normalizeValue(w, rules) != normalizeValue(g, rules) {
			diffs = append(diffs, Diff{Kind: DiffFieldMismatch, Field: k, Want: w, Got: g})
		}
	}

	wantCounts := map[string]int{}
	for _, a := range want.Attachments {
		wantCounts[a.Hash()]++
	}
	gotCounts := map[string]int{}
	for _, a := range got.Attachments {
		gotCounts[a.Hash()]++
	}
	hashes := map[string]struct{}{}
	for h := range wantCounts {
		hashes[h] = struct{}{}
	}
	for h := range gotCounts {
		hashes[h] = struct{}{}
	}
	sortedHashes := make([]string, 0, len(hashes))
	for h := range hashes {
		sortedHashes = append(sortedHashes, h)
	}
	sort.Strings(sortedHashes)

	for _, h := range sortedHashes {
		if missing := wantCounts[h] - gotCounts[h]; missing > 0 {
			for i := 0; i < missing; i++ {
				diffs = append(diffs, Diff{Kind: DiffAttachmentMissing, Want: h})
			}
		}
		if extra := gotCounts[h] - wantCounts[h]; extra > 0 {
			for i := 0; i < extra; i++ {
				diffs = append(diffs, Diff{Kind: DiffAttachmentUnexpected, Got: h})
			}
		}
	}

	return diffs
}
