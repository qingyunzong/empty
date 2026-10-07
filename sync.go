package synclib

import (
	"context"
	"sort"
	"strconv"
)

// Syncer writes records to a Store and verifies them by reading back.
type Syncer struct {
	Store Store
	Rules Ruleset
}

// compare returns all discrepancies between the wanted and the read-back
// record after applying only the declared equivalence rules. The result is
// sorted for deterministic error messages.
func (s *Syncer) compare(want, got Record) []Diff {
	var diffs []Diff
	for name, wantVal := range want.Fields {
		rules := s.Rules.rulesFor(name)
		gotVal, ok := got.Fields[name]
		if !ok {
			diffs = append(diffs, Diff{Kind: DiffFieldMissing, Field: name, Want: wantVal})
			continue
		}
		if applyRules(wantVal, rules) != applyRules(gotVal, rules) {
			diffs = append(diffs, Diff{Kind: DiffFieldMismatch, Field: name, Want: wantVal, Got: gotVal})
		}
	}
	for name, gotVal := range got.Fields {
		if _, ok := want.Fields[name]; !ok {
			diffs = append(diffs, Diff{Kind: DiffFieldExtra, Field: name, Got: gotVal})
		}
	}
	wantHashes := want.attachmentHashes()
	gotHashes := got.attachmentHashes()
	for hash, n := range wantHashes {
		if gotHashes[hash] < n {
			diffs = append(diffs, Diff{
				Kind:  DiffAttachmentMissing,
				Field: hash,
				Want:  strconv.Itoa(n),
				Got:   strconv.Itoa(gotHashes[hash]),
			})
		}
	}
	for hash, n := range gotHashes {
		if wantHashes[hash] < n {
			diffs = append(diffs, Diff{
				Kind:  DiffAttachmentExtra,
				Field: hash,
				Want:  strconv.Itoa(wantHashes[hash]),
				Got:   strconv.Itoa(n),
			})
		}
	}
	sort.Slice(diffs, func(i, j int) bool {
		if diffs[i].Kind != diffs[j].Kind {
			return diffs[i].Kind < diffs[j].Kind
		}
		return diffs[i].Field < diffs[j].Field
	})
	return diffs
}

// Matches reports whether the stored record already satisfies rec under the
// declared rules. It is used for read-before-retry confirmation.
func (s *Syncer) Matches(want, got Record) bool {
	return len(s.compare(want, got)) == 0
}

// Sync writes rec and verifies it with an immediate read-back. On
// verification failure it returns a *MismatchError carrying the original
// write receipt and the specific diffs.
func (s *Syncer) Sync(ctx context.Context, rec Record) (Receipt, error) {
	receipt, err := s.Store.Write(ctx, rec)
	if err != nil {
		return receipt, err
	}
	got, _, err := s.Store.Read(ctx, rec.ID)
	if err != nil {
		return receipt, err
	}
	if diffs := s.compare(rec, got); len(diffs) > 0 {
		return receipt, &MismatchError{Receipt: receipt, Diffs: diffs}
	}
	return receipt, nil
}
