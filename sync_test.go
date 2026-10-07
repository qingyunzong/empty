package synclib_test

import (
	"context"
	"errors"
	"testing"

	"example.com/synclib"
	"example.com/synclib/fakestore"
)

// stubStore returns a fixed record on Read, to drive normalization tests
// without going through fakestore mechanics.
type stubStore struct {
	receipt synclib.Receipt
	got     synclib.Record
	readErr error
}

func (s *stubStore) Write(ctx context.Context, rec synclib.Record) (synclib.Receipt, error) {
	return s.receipt, nil
}

func (s *stubStore) Read(ctx context.Context, id string) (synclib.Record, synclib.Receipt, error) {
	return s.got, s.receipt, s.readErr
}

func wantRecord() synclib.Record {
	return synclib.Record{
		ID: "rec-1",
		Fields: map[string]string{
			"title": "Hello",
			"body":  "a  b",
		},
		Attachments: []synclib.Attachment{
			{Name: "a.txt", Data: []byte("alpha")},
			{Name: "b.txt", Data: []byte("beta")},
		},
	}
}

func TestSyncWritesAndVerifies(t *testing.T) {
	store := fakestore.New()
	s := &synclib.Syncer{Store: store}
	receipt, err := s.Sync(context.Background(), wantRecord())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if receipt.Version != 1 || receipt.ID != "rec-1" {
		t.Fatalf("unexpected receipt: %+v", receipt)
	}
}

func TestNormalizationAppliesOnlyDeclaredRules(t *testing.T) {
	want := synclib.Record{ID: "r", Fields: map[string]string{
		"title": "Hello",
		"body":  "a  b",
	}}
	got := synclib.Record{ID: "r", Fields: map[string]string{
		"title": "  hello ",
		"body":  "a b",
	}}
	cases := []struct {
		name      string
		rules     synclib.Ruleset
		wantDiffs int
	}{
		{"no rules declared", synclib.Ruleset{}, 2},
		{"trim and fold declared for title", synclib.Ruleset{
			Fields: map[string][]synclib.Rule{
				"title": {synclib.RuleTrimSpace, synclib.RuleFoldCase},
			},
		}, 1},
		{"all rules declared", synclib.Ruleset{
			Fields: map[string][]synclib.Rule{
				"title": {synclib.RuleTrimSpace, synclib.RuleFoldCase},
				"body":  {synclib.RuleCollapseSpace},
			},
		}, 0},
		{"global rules apply to every field", synclib.Ruleset{
			Global: []synclib.Rule{synclib.RuleTrimSpace, synclib.RuleFoldCase, synclib.RuleCollapseSpace},
		}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &synclib.Syncer{Store: &stubStore{got: got}, Rules: tc.rules}
			_, err := s.Sync(context.Background(), want)
			var me *synclib.MismatchError
			if tc.wantDiffs == 0 {
				if err != nil {
					t.Fatalf("Sync: %v", err)
				}
				return
			}
			if !errors.As(err, &me) {
				t.Fatalf("want MismatchError, got %v", err)
			}
			if len(me.Diffs) != tc.wantDiffs {
				t.Fatalf("want %d diffs, got %v", tc.wantDiffs, me.Diffs)
			}
		})
	}
}

func TestAttachmentOrderIrrelevantButHashMustMatch(t *testing.T) {
	want := wantRecord()

	reordered := wantRecord()
	reordered.Attachments[0], reordered.Attachments[1] =
		reordered.Attachments[1], reordered.Attachments[0]
	s := &synclib.Syncer{Store: &stubStore{got: reordered}}
	if _, err := s.Sync(context.Background(), want); err != nil {
		t.Fatalf("reordered attachments must verify: %v", err)
	}

	tampered := wantRecord()
	tampered.Attachments[1].Data = []byte("BETA")
	s = &synclib.Syncer{Store: &stubStore{got: tampered}}
	_, err := s.Sync(context.Background(), want)
	var me *synclib.MismatchError
	if !errors.As(err, &me) {
		t.Fatalf("want MismatchError, got %v", err)
	}
	var kinds []synclib.DiffKind
	for _, d := range me.Diffs {
		kinds = append(kinds, d.Kind)
	}
	wantKinds := []synclib.DiffKind{synclib.DiffAttachmentMissing, synclib.DiffAttachmentExtra}
	if len(kinds) != 2 || kinds[0] != wantKinds[0] || kinds[1] != wantKinds[1] {
		t.Fatalf("want diffs %v, got %v", wantKinds, kinds)
	}
}

func TestMismatchErrorRetainsReceiptAndDiffs(t *testing.T) {
	store := fakestore.New()
	store.Partials = []fakestore.PartialWrite{{
		OnCall:          1,
		DropFields:      []string{"body"},
		DropAttachments: []string{"b.txt"},
	}}
	s := &synclib.Syncer{Store: store}
	_, err := s.Sync(context.Background(), wantRecord())
	var me *synclib.MismatchError
	if !errors.As(err, &me) {
		t.Fatalf("want MismatchError, got %v", err)
	}
	if me.Receipt.Version != 1 || me.Receipt.ID != "rec-1" {
		t.Fatalf("receipt not retained: %+v", me.Receipt)
	}
	if len(me.Diffs) != 2 {
		t.Fatalf("want 2 diffs, got %v", me.Diffs)
	}
	if me.Diffs[0].Kind != synclib.DiffFieldMissing || me.Diffs[0].Field != "body" {
		t.Fatalf("unexpected field diff: %+v", me.Diffs[0])
	}
	if me.Diffs[1].Kind != synclib.DiffAttachmentMissing {
		t.Fatalf("unexpected attachment diff: %+v", me.Diffs[1])
	}
}
