package dataeng_test

import (
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"example.org/dataeng13/q0015"
)

func TestParseUnfoldsContinuationAndDecodesBase64(t *testing.T) {
	input := "version: 1\n\n" +
		"dn: uid=alice,ou=People,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Ali\n" +
		" ce\n" +
		"description:: SGVsbG8s\n" +
		" IFdvcmxkIQ==\n" +
		"title: Sen\n" +
		"\tior\n"

	changes, err := dataeng.Parse(strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("got %d records, want 1", len(changes))
	}

	change := changes[0]
	if change.Err != nil {
		t.Fatalf("record error: %v", change.Err)
	}
	if change.Record != 1 || change.Line != 3 {
		t.Errorf("record/line = %d/%d, want 1/3", change.Record, change.Line)
	}
	if change.DN != "uid=alice,ou=People,dc=example,dc=org" {
		t.Errorf("DN = %q", change.DN)
	}
	if change.Type != dataeng.ChangeAdd {
		t.Errorf("type = %q, want add", change.Type)
	}

	want := map[string][]string{
		"cn":          {"Alice"},
		"description": {"Hello, World!"},
		"title":       {"Senior"},
	}
	for name, values := range want {
		got, ok := change.Values(name)
		if !ok {
			t.Errorf("missing attribute %s", name)
			continue
		}
		if !reflect.DeepEqual(got, values) {
			t.Errorf("%s = %#v, want %#v", name, got, values)
		}
	}
}

func TestBadBase64FailsRecordButNotNextRecord(t *testing.T) {
	input := "dn: uid=bad,dc=example,dc=org\n" +
		"changetype: add\n" +
		"note:: !!!\n\n" +
		"dn: uid=good,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Good\n"

	changes, err := dataeng.Parse(strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("got %d records, want 2", len(changes))
	}
	if !errors.Is(changes[0].Err, dataeng.ErrInvalidBase64) {
		t.Errorf("first record error = %v, want ErrInvalidBase64", changes[0].Err)
	}
	if changes[1].Err != nil {
		t.Errorf("second record error = %v, want nil", changes[1].Err)
	}

	dir, readChanges, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(readChanges) != 2 {
		t.Fatalf("ReadChanges got %d records, want 2", len(readChanges))
	}
	if dir.Len() != 1 {
		t.Fatalf("directory has %d entries, want 1", dir.Len())
	}
	entry, ok := dir.Lookup("uid=good,dc=example,dc=org")
	if !ok {
		t.Fatal("good entry missing")
	}
	if got, _ := entry.Get("cn"); !reflect.DeepEqual(got, []string{"Good"}) {
		t.Errorf("cn = %#v", got)
	}
}

func TestInvalidChangeTypeDoesNotConsumeNextRecord(t *testing.T) {
	input := "dn: uid=bad,dc=example,dc=org\n" +
		"changetype: modrdn\n\n" +
		"dn: uid=good,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Good\n"

	changes, err := dataeng.Parse(strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("got %d records, want 2", len(changes))
	}
	if !errors.Is(changes[0].Err, dataeng.ErrInvalidChangeType) {
		t.Errorf("first record error = %v, want ErrInvalidChangeType", changes[0].Err)
	}
	if changes[1].Err != nil || changes[1].Type != dataeng.ChangeAdd {
		t.Errorf("second record = %+v", changes[1])
	}
}

func TestModifyOperationsApplyInOrderAtomically(t *testing.T) {
	input := "dn: uid=alice,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Alice\n" +
		"mail: a@example.org\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: mail\n" +
		"mail: b@example.org\n" +
		"-\n" +
		"delete: mail\n" +
		"mail: a@example.org\n" +
		"-\n" +
		"add: mail\n" +
		"mail: b@example.org\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"delete: mail\n" +
		"mail: z@example.org\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: mail\n" +
		"mail: c@example.org\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), func(dn string) string {
		return strings.ToLower(dn)
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 4 {
		t.Fatalf("got %d records, want 4", len(changes))
	}
	if changes[0].Err != nil {
		t.Errorf("add record failed: %v", changes[0].Err)
	}
	if !errors.Is(changes[1].Err, dataeng.ErrValueExists) {
		t.Errorf("duplicate add error = %v, want ErrValueExists", changes[1].Err)
	}
	if !errors.Is(changes[2].Err, dataeng.ErrValueNotFound) {
		t.Errorf("missing delete error = %v, want ErrValueNotFound", changes[2].Err)
	}
	if changes[3].Err != nil {
		t.Errorf("final modify failed: %v", changes[3].Err)
	}

	want := &dataeng.Entry{
		DN: "uid=alice,dc=example,dc=org",
		Attributes: map[string][]string{
			"cn":   {"Alice"},
			"mail": {"a@example.org", "c@example.org"},
		},
	}
	got, ok := dir.Lookup("UID=ALICE,DC=EXAMPLE,DC=ORG")
	if !ok {
		t.Fatal("entry missing")
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("entry = %#v, want %#v", got, want)
	}
}

func TestDeleteThenAddSameValueIsValidOrder(t *testing.T) {
	input := "dn: uid=alice,dc=example,dc=org\n" +
		"changetype: add\n" +
		"mail: a@example.org\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"delete: mail\n" +
		"mail: a@example.org\n" +
		"-\n" +
		"add: mail\n" +
		"mail: a@example.org\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 2 || changes[1].Err != nil {
		t.Fatalf("changes = %+v", changes)
	}
	entry, ok := dir.Lookup("uid=alice,dc=example,dc=org")
	if !ok {
		t.Fatal("entry missing")
	}
	if got, _ := entry.Get("mail"); !reflect.DeepEqual(got, []string{"a@example.org"}) {
		t.Errorf("mail = %#v", got)
	}
}

func TestDuplicateValueInAddRecordIsRejected(t *testing.T) {
	input := "dn: uid=dup,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Dup\n" +
		"cn: Dup\n\n" +
		"dn: uid=ok,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Ok\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("got %d records, want 2", len(changes))
	}
	if !errors.Is(changes[0].Err, dataeng.ErrDuplicateValue) {
		t.Errorf("duplicate add error = %v, want ErrDuplicateValue", changes[0].Err)
	}
	if changes[1].Err != nil {
		t.Errorf("later record failed: %v", changes[1].Err)
	}
	if dir.Len() != 1 {
		t.Fatalf("directory has %d entries, want 1", dir.Len())
	}
	if _, ok := dir.Lookup("uid=dup,dc=example,dc=org"); ok {
		t.Error("duplicate entry was committed")
	}
}

func TestMalformedRecordIsIsolated(t *testing.T) {
	input := "dn: uid=broken,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn\n\n" +
		"dn: uid=ok,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Ok\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 2 {
		t.Fatalf("got %d records, want 2", len(changes))
	}
	if !errors.Is(changes[0].Err, dataeng.ErrInvalidAttribute) {
		t.Errorf("malformed record error = %v, want ErrInvalidAttribute", changes[0].Err)
	}
	if changes[1].Err != nil {
		t.Errorf("later record failed: %v", changes[1].Err)
	}
	if dir.Len() != 1 {
		t.Fatalf("directory has %d entries, want 1", dir.Len())
	}
}

func TestBase64FailureInModifyIsAtomic(t *testing.T) {
	input := "dn: uid=alice,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Alice\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: note\n" +
		"note:: @@@\n" +
		"-\n" +
		"add: cn\n" +
		"cn: Mallory\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: note\n" +
		"note: later\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !errors.Is(changes[1].Err, dataeng.ErrInvalidBase64) {
		t.Errorf("modify error = %v, want ErrInvalidBase64", changes[1].Err)
	}
	entry, ok := dir.Lookup("uid=alice,dc=example,dc=org")
	if !ok {
		t.Fatal("entry missing")
	}
	if got, _ := entry.Get("cn"); !reflect.DeepEqual(got, []string{"Alice"}) {
		t.Errorf("cn = %#v, want unchanged Alice", got)
	}
	if got, _ := entry.Get("note"); !reflect.DeepEqual(got, []string{"later"}) {
		t.Errorf("note after later record = %#v, want later", got)
	}
}

func TestCallerNormalizerComparesDNs(t *testing.T) {
	normalize := func(dn string) string {
		return strings.ToLower(strings.TrimSpace(dn))
	}

	input := "dn: UID=Alice,OU=People,DC=Example,DC=Org\n" +
		"changetype: add\n" +
		"cn: Alice\n\n" +
		"dn: uid=alice,ou=people,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: description\n" +
		"description: Engineer\n\n" +
		"dn: uId=ALICE,Ou=PEOPLE,Dc=EXAMPLE,Dc=ORG\n" +
		"changetype: delete\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), normalize)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 3 {
		t.Fatalf("got %d records, want 3", len(changes))
	}
	for i, change := range changes {
		if change.Err != nil {
			t.Errorf("record %d failed: %v", i+1, change.Err)
		}
	}
	if dir.Len() != 0 {
		t.Fatalf("directory has %d entries, want 0", dir.Len())
	}
}

func TestNilNormalizerUsesExactDN(t *testing.T) {
	input := "dn: uid=Alice,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Alice\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: description\n" +
		"description: Engineer\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !errors.Is(changes[1].Err, dataeng.ErrEntryNotFound) {
		t.Errorf("modify error = %v, want ErrEntryNotFound", changes[1].Err)
	}
	if dir.Len() != 1 {
		t.Fatalf("directory has %d entries, want 1", dir.Len())
	}
}

// refDirectory is intentionally independent of the package's Directory type.
// Expectations in these tests are written as literals, not produced by the
// implementation under test.
type refEntry struct {
	dn    string
	attrs map[string][]string
}

type refDirectory struct {
	entries map[string]refEntry
}

func TestIndependentModelChecksFoldAndRecordIsolation(t *testing.T) {
	input := "dn: uid=alice,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Ali\n" +
		" ce\n" +
		"mail: a@example.org\n\n" +
		"dn: uid=broken,dc=example,dc=org\n" +
		"changetype: add\n" +
		"oops\n\n" +
		"dn: uid=bob,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Bob\n" +
		"cn: Bob\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: mail\n" +
		"mail: b@example.org\n\n" +
		"dn: uid=carol,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Carol\n"

	dir, changes, err := dataeng.Process(strings.NewReader(input), nil)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if len(changes) != 5 {
		t.Fatalf("got %d records, want 5", len(changes))
	}
	if !errors.Is(changes[1].Err, dataeng.ErrInvalidAttribute) {
		t.Errorf("broken record error = %v", changes[1].Err)
	}
	if !errors.Is(changes[2].Err, dataeng.ErrDuplicateValue) {
		t.Errorf("duplicate-value record error = %v", changes[2].Err)
	}

	want := refDirectory{entries: map[string]refEntry{
		"uid=alice,dc=example,dc=org": {
			dn: "uid=alice,dc=example,dc=org",
			attrs: map[string][]string{
				"cn":   {"Alice"},
				"mail": {"a@example.org", "b@example.org"},
			},
		},
		"uid=carol,dc=example,dc=org": {
			dn:    "uid=carol,dc=example,dc=org",
			attrs: map[string][]string{"cn": {"Carol"}},
		},
	}}

	got := refDirectory{entries: map[string]refEntry{}}
	for _, entry := range dir.Entries() {
		got.entries[entry.DN] = refEntry{dn: entry.DN, attrs: entry.Attributes}
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("directory = %#v, want %#v", got, want)
	}
}

func TestDecoderReturnsBadRecordAndContinues(t *testing.T) {
	input := "dn: uid=one,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: One\n\n" +
		"dn: uid=bad,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn:: !!!\n\n" +
		"dn: uid=two,dc=example,dc=org\n" +
		"changetype: add\n" +
		"cn: Two\n"

	decoder := dataeng.NewDecoder(strings.NewReader(input))
	first, err := decoder.Next()
	if err != nil {
		t.Fatalf("Next first: %v", err)
	}
	if first.Err != nil || first.Record != 1 {
		t.Errorf("first = %+v", first)
	}

	second, err := decoder.Next()
	if err != nil {
		t.Fatalf("Next second: %v", err)
	}
	if !errors.Is(second.Err, dataeng.ErrInvalidBase64) || second.Record != 2 {
		t.Errorf("second = %+v", second)
	}

	third, err := decoder.Next()
	if err != nil {
		t.Fatalf("Next third: %v", err)
	}
	if third.Err != nil || third.Record != 3 {
		t.Errorf("third = %+v", third)
	}

	if _, err := decoder.Next(); !errors.Is(err, io.EOF) {
		t.Errorf("final Next error = %v, want io.EOF", err)
	}
}

func TestCRLFAndLongLogicalLine(t *testing.T) {
	long := strings.Repeat("x", 200000)
	input := "\ufeffdn: uid=long,dc=example,dc=org\r\n" +
		"changetype: add\r\n" +
		"note: " + long + "\r\n"

	changes, err := dataeng.ParseRecords(strings.NewReader(input))
	if err != nil {
		t.Fatalf("ParseRecords: %v", err)
	}
	if len(changes) != 1 || changes[0].Err != nil {
		t.Fatalf("changes = %+v", changes)
	}
	got, ok := changes[0].Values("note")
	if !ok {
		t.Fatal("note missing")
	}
	if len(got) != 1 || got[0] != long {
		t.Errorf("note length = %d, want %d", len(got[0]), len(long))
	}
}

func TestParseWithNormalizerAppliesSemantics(t *testing.T) {
	input := "dn: UID=Alice,DC=Example,DC=Org\n" +
		"changetype: add\n" +
		"note: first\n\n" +
		"dn: uid=alice,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: note\n" +
		"note: second\n\n" +
		"dn: uid=ALICE,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"add: note\n" +
		"note: second\n"

	changes, err := dataeng.Parse(strings.NewReader(input), func(dn string) string {
		return strings.ToLower(dn)
	})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if changes[0].Err != nil || changes[1].Err != nil {
		t.Fatalf("first two records failed: %v, %v", changes[0].Err, changes[1].Err)
	}
	if !errors.Is(changes[2].Err, dataeng.ErrValueExists) {
		t.Errorf("duplicate add error = %v, want ErrValueExists", changes[2].Err)
	}
}
