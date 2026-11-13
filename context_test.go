package dataeng

import (
	"errors"
	"math"
	"testing"
)

func ptr(value uint64) *uint64 { return &value }

func mustContext(t *testing.T, system []string, imports []Import, directory Directory) *Context {
	t.Helper()
	context, err := NewContext(system, imports, directory)
	if err != nil {
		t.Fatalf("NewContext: %v", err)
	}
	return context
}

func mustResolve(t *testing.T, context *Context, sid uint64) Token {
	t.Helper()
	token, err := context.Resolve(sid)
	if err != nil {
		t.Fatalf("Resolve(%d): %v", sid, err)
	}
	return token
}

func TestContextLayoutResolutionAndLookup(t *testing.T) {
	directory := Directory{
		Key{"sh", 1}:    []string{"s1", "", "s1"},
		Key{"sh", 2}:    []string{"v2a", "v2b"},
		Key{"unk", 1}:   UnknownTable(3),
		Key{"trunc", 1}: []string{"t1", "t2", "t3"},
		Key{"pad", 1}:   []string{"p1"},
		Key{"empty", 1}: []string{},
		Key{"mixed", 1}: []Slot{KnownSlot("m1"), UnknownSlot(), KnownSlot("m1")},
	}
	imports := []Import{
		{Name: "sh", Version: 1},
		{Name: "sh", Version: 1, MaxID: ptr(5)},
		{Name: "sh", Version: 3, MaxID: ptr(2)}, // exact absent; falls back to sh v2
		{Name: "sh", Version: 2, MaxID: ptr(4)},
		{Name: "unk", Version: 1},
		{Name: "trunc", Version: 1, MaxID: ptr(2)},
		{Name: "pad", Version: 1, MaxID: ptr(3)},
		{Name: "mixed", Version: 1},
		{Name: "empty", Version: 1},
		{Name: "absent", Version: 9, MaxID: ptr(0)},
		{Name: "absent", Version: 10, MaxID: ptr(2)},
	}
	system := []string{"sysA", "", "sysA", "Z"}
	context := mustContext(t, system, imports, directory)

	if got, want := context.MaxSID(), uint64(31); got != want {
		t.Fatalf("MaxSID = %d, want %d", got, want)
	}

	cases := []struct {
		sid  uint64
		want Token
	}{
		{5, Known("s1")},
		{6, Known("")},
		{7, Known("s1")},
		{8, Known("s1")},
		{9, Known("")},
		{10, Known("s1")},
		{11, SharedUnknown("sh", 4)},
		{12, SharedUnknown("sh", 5)},
		{13, Known("v2a")},
		{14, Known("v2b")},
		{15, Known("v2a")},
		{16, Known("v2b")},
		{17, SharedUnknown("sh", 3)},
		{18, SharedUnknown("sh", 4)},
		{19, SharedUnknown("unk", 1)},
		{20, SharedUnknown("unk", 2)},
		{21, SharedUnknown("unk", 3)},
		{22, Known("t1")},
		{23, Known("t2")},
		{24, Known("p1")},
		{25, SharedUnknown("pad", 2)},
		{26, SharedUnknown("pad", 3)},
		{27, Known("m1")},
		{28, SharedUnknown("mixed", 2)},
		{29, Known("m1")},
		{30, SharedUnknown("absent", 1)},
		{31, SharedUnknown("absent", 2)},
	}
	for _, test := range cases {
		if got := mustResolve(t, context, test.sid); !Equivalent(got, test.want) {
			t.Errorf("Resolve(%d) = %s, want %s", test.sid, got, test.want)
		}
	}

	if token := mustResolve(t, context, 0); !token.IsLocalUnknown() {
		t.Fatalf("Resolve(0) = %s, want LocalUnknown", token)
	}
	if _, err := context.Resolve(32); !errors.Is(err, ErrSIDOutOfRange) {
		t.Fatalf("Resolve(32) error = %v, want ErrSIDOutOfRange", err)
	}

	lookupCases := []struct {
		token     Token
		wantSID   uint64
		wantFound bool
	}{
		{Known("sysA"), 1, true},
		{Known(""), 2, true}, // system empty text shadows every later empty text
		{Known("Z"), 4, true},
		{Known("s1"), 5, true},
		{Known("v2a"), 13, true},
		{Known("m1"), 27, true},
		{Known("p1"), 24, true},
		{Known("t3"), 0, false}, // truncated import does not expose slot 3
		{Known("never"), 0, false},
		{LocalUnknown(), 0, true},
		{SharedUnknown("sh", 3), 17, true}, // sh v1 slot 3 is known; skip it
		{SharedUnknown("sh", 4), 11, true},
		{SharedUnknown("sh", 5), 12, true},
		{SharedUnknown("unk", 2), 20, true},
		{SharedUnknown("mixed", 2), 28, true},
		{SharedUnknown("absent", 2), 31, true},
		{SharedUnknown("absent", 3), 0, false},
		{SharedUnknown("other", 1), 0, false},
	}
	for _, test := range lookupCases {
		sid, found := context.Lookup(test.token)
		if found != test.wantFound || (found && sid != test.wantSID) {
			t.Errorf("Lookup(%s) = (%d, %v), want (%d, %v)",
				test.token, sid, found, test.wantSID, test.wantFound)
		}
	}
}

func TestImportSelectionRules(t *testing.T) {
	directory := Directory{
		Key{"sh", 1}: []string{"old1", "old2"},
		Key{"sh", 2}: []string{"new1"},
	}

	t.Run("exact version wins over newer", func(t *testing.T) {
		context := mustContext(t, nil, []Import{{Name: "sh", Version: 1, MaxID: ptr(1)}}, directory)
		if got := mustResolve(t, context, 1); !Equivalent(got, Known("old1")) {
			t.Fatalf("slot = %s, want Known(old1)", got)
		}
	})

	t.Run("fallback uses highest same-name version", func(t *testing.T) {
		context := mustContext(t, nil, []Import{{Name: "sh", Version: 9, MaxID: ptr(1)}}, directory)
		if got := mustResolve(t, context, 1); !Equivalent(got, Known("new1")) {
			t.Fatalf("slot = %s, want Known(new1)", got)
		}
	})

	t.Run("missing exact without maxID is rejected", func(t *testing.T) {
		_, err := NewContext(nil, []Import{{Name: "sh", Version: 9}}, directory)
		if !errors.Is(err, ErrImportNotFound) {
			t.Fatalf("error = %v, want ErrImportNotFound", err)
		}
	})

	t.Run("missing exact with maxID and missing name is all unknown", func(t *testing.T) {
		context := mustContext(t, nil, []Import{{Name: "nowhere", Version: 1, MaxID: ptr(4)}}, directory)
		for ordinal := uint64(1); ordinal <= 4; ordinal++ {
			got := mustResolve(t, context, ordinal)
			want := SharedUnknown("nowhere", ordinal)
			if !Equivalent(got, want) {
				t.Fatalf("Resolve(%d) = %s, want %s", ordinal, got, want)
			}
		}
	})

	t.Run("maxID zero keeps a zero-length area", func(t *testing.T) {
		context := mustContext(t, []string{"sys"}, []Import{
			{Name: "sh", Version: 1, MaxID: ptr(0)},
			{Name: "sh", Version: 1},
		}, directory)
		if got, want := context.MaxSID(), uint64(3); got != want {
			t.Fatalf("MaxSID = %d, want %d", got, want)
		}
		if got := mustResolve(t, context, 2); !Equivalent(got, Known("old1")) {
			t.Fatalf("SID 2 = %s, want Known(old1)", got)
		}
	})

	t.Run("truncate and pad do not require an expanded array", func(t *testing.T) {
		context := mustContext(t, nil, []Import{
			{Name: "sh", Version: 1, MaxID: ptr(1)},
			{Name: "sh", Version: 2, MaxID: ptr(3)},
		}, directory)
		if got := mustResolve(t, context, 1); !Equivalent(got, Known("old1")) {
			t.Fatalf("truncated slot = %s", got)
		}
		if got := mustResolve(t, context, 2); !Equivalent(got, Known("new1")) {
			t.Fatalf("padded import slot 1 = %s", got)
		}
		if got := mustResolve(t, context, 3); !Equivalent(got, SharedUnknown("sh", 2)) {
			t.Fatalf("padded slot 2 = %s", got)
		}
	})
}

func TestSharedUnknownLookupAcrossRepeatedImports(t *testing.T) {
	directory := Directory{
		Key{"sh", 1}: []string{"a", "b", "c"},
		Key{"sh", 2}: []string{"d", "e"},
		Key{"sh", 9}: UnknownTable(2),
	}
	context := mustContext(t, nil, []Import{
		{Name: "sh", Version: 1, MaxID: ptr(3)},
		{Name: "sh", Version: 2, MaxID: ptr(5)},
		{Name: "sh", Version: 2, MaxID: ptr(3)},
		{Name: "sh", Version: 9, MaxID: ptr(2)}, // exact table is all unknown
	}, directory)

	lookups := []struct {
		ordinal uint64
		wantSID uint64
		found   bool
	}{
		{1, 12, true}, // earlier imports have known text at slot 1
		{2, 13, true},
		{3, 6, true}, // v2 import starts at SID 4, with unknown third slot
		{4, 7, true},
		{5, 8, true},
	}

	for _, test := range lookups {
		sid, found := context.Lookup(SharedUnknown("sh", test.ordinal))
		if found != test.found || (found && sid != test.wantSID) {
			t.Errorf("Lookup(sh, %d) = (%d, %v), want (%d, %v)",
				test.ordinal, sid, found, test.wantSID, test.found)
		}
	}
	if sid, found := context.Lookup(Known("d")); !found || sid != 4 {
		t.Fatalf("Lookup(Known(d)) = (%d, %v), want (4, true)", sid, found)
	}
}

func TestContextSnapshotIsolationAndReset(t *testing.T) {
	slots := []Slot{KnownSlot("a"), UnknownSlot()}
	directory := Directory{
		Key{"t", 1}: Table{Slots: slots},
	}
	context := mustContext(t, []string{"s"}, []Import{{Name: "t", Version: 1}}, directory)
	tokenAtThree := mustResolve(t, context, 3)
	if !Equivalent(tokenAtThree, SharedUnknown("t", 2)) {
		t.Fatalf("token at 3 = %s", tokenAtThree)
	}

	// Mutating the host array must not change an existing snapshot.
	slots[1] = KnownSlot("changed")
	if got := mustResolve(t, context, 3); !Equivalent(got, SharedUnknown("t", 2)) {
		t.Fatalf("snapshot changed through host array: %s", got)
	}

	// Replacing a directory entry must not retroactively change old slots.
	directory[Key{"t", 1}] = []string{"a", "later"}
	if got := mustResolve(t, context, 3); !Equivalent(got, SharedUnknown("t", 2)) {
		t.Fatalf("old snapshot changed after directory replacement: %s", got)
	}
	newer := mustContext(t, []string{"s"}, []Import{{Name: "t", Version: 1}}, directory)
	if got := mustResolve(t, newer, 3); !Equivalent(got, Known("later")) {
		t.Fatalf("new snapshot slot = %s, want Known(later)", got)
	}

	appended, err := context.AppendLocal("", "local")
	if err != nil {
		t.Fatalf("AppendLocal: %v", err)
	}
	if context.LocalLen() != 0 || context.MaxSID() != 3 {
		t.Fatalf("old snapshot mutated: local=%d max=%d", context.LocalLen(), context.MaxSID())
	}
	if appended.LocalLen() != 2 || appended.MaxSID() != 5 {
		t.Fatalf("new snapshot local=%d max=%d", appended.LocalLen(), appended.MaxSID())
	}
	if got := mustResolve(t, appended, 4); !Equivalent(got, Known("")) {
		t.Fatalf("local slot 1 = %s, want Known(empty)", got)
	}
	if got := mustResolve(t, appended, 5); !Equivalent(got, Known("local")) {
		t.Fatalf("local slot 2 = %s, want Known(local)", got)
	}
	if !Equivalent(tokenAtThree, SharedUnknown("t", 2)) {
		t.Fatalf("old token changed after append: %s", tokenAtThree)
	}

	reset := appended.Reset()
	if got, want := reset.MaxSID(), uint64(1); got != want {
		t.Fatalf("reset MaxSID = %d, want %d", got, want)
	}
	if got := mustResolve(t, reset, 1); !Equivalent(got, Known("s")) {
		t.Fatalf("reset system slot = %s", got)
	}
	if _, err := reset.Resolve(2); !errors.Is(err, ErrSIDOutOfRange) {
		t.Fatalf("reset Resolve(2) error = %v, want ErrSIDOutOfRange", err)
	}
	if !Equivalent(tokenAtThree, SharedUnknown("t", 2)) {
		t.Fatalf("old token invalid after reset: %s", tokenAtThree)
	}
}

func TestAppendLocalOverflowKeepsSnapshot(t *testing.T) {
	context := mustContext(t, nil, []Import{
		ImportWithMax("huge", 1, math.MaxUint64),
	}, nil)
	if got, want := context.MaxSID(), uint64(math.MaxUint64); got != want {
		t.Fatalf("MaxSID = %d, want %d", got, want)
	}
	if got := mustResolve(t, context, math.MaxUint64); !Equivalent(got, SharedUnknown("huge", math.MaxUint64)) {
		t.Fatalf("last token = %s", got)
	}
	if _, err := context.AppendLocal("x"); !errors.Is(err, ErrSIDOverflow) {
		t.Fatalf("AppendLocal error = %v, want ErrSIDOverflow", err)
	}
	if context.LocalLen() != 0 || context.MaxSID() != math.MaxUint64 {
		t.Fatalf("failed append changed snapshot")
	}
}

func TestEquivalent(t *testing.T) {
	tests := []struct {
		a, b Token
		want bool
	}{
		{Known(""), Known(""), true},
		{Known("abc"), Known("abc"), true},
		{Known("abc"), Known("abd"), false},
		{Known("é"), Known("e\u0301"), false}, // no Unicode normalization
		{LocalUnknown(), LocalUnknown(), true},
		{SharedUnknown("t", 1), SharedUnknown("t", 1), true},
		{SharedUnknown("t", 1), SharedUnknown("t", 2), false},
		{SharedUnknown("t", 1), SharedUnknown("u", 1), false},
		{Known(""), LocalUnknown(), false},
		{Known("t"), SharedUnknown("t", 1), false},
		{LocalUnknown(), SharedUnknown("", 1), false},
	}
	for _, test := range tests {
		if got := Equivalent(test.a, test.b); got != test.want {
			t.Errorf("Equivalent(%s, %s) = %v, want %v", test.a, test.b, got, test.want)
		}
		if got := test.a.Equal(test.b); got != test.want {
			t.Errorf("Token.Equal(%s, %s) = %v, want %v", test.a, test.b, got, test.want)
		}
	}
}

func TestInvalidConstruction(t *testing.T) {
	tests := []struct {
		name      string
		system    []string
		imports   []Import
		directory Directory
	}{
		{"empty import name", nil, []Import{{Version: 1}}, nil},
		{"zero import version", nil, []Import{{Name: "t"}}, nil},
		{"directory empty name", nil, nil, Directory{Key{"", 1}: []string{"x"}}},
		{"directory zero version", nil, nil, Directory{Key{"t", 0}: []string{"x"}}},
		{"unsupported directory value", nil, nil, Directory{Key{"t", 1}: 42}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewContext(test.system, test.imports, test.directory); err == nil {
				t.Fatal("NewContext succeeded, want error")
			}
		})
	}
}
