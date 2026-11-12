package ipfix

import (
	"bytes"
	"testing"
)

func TestCrossDomainTotalTemplateBudget(t *testing.T) {
	r := NewReceiver(testIdentity("cross-budget"), Limits{MaxTotalTemplates: 2})

	one := encMessage(1, 0, 1, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	two := encMessage(1, 0, 2, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	mustAppend(t, r, one)
	mustAppend(t, r, two)
	if r.TemplateCount() != 2 {
		t.Fatalf("template count = %d, want 2", r.TemplateCount())
	}

	three := encMessage(1, 0, 3, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	expectFailure(t, r, three)
	if r.TemplateCount() != 2 {
		t.Fatalf("count after rejected insert = %d, want 2", r.TemplateCount())
	}

	// Replacing within a domain stays within the budget.
	fresh := NewReceiver(testIdentity("replace-budget"), Limits{MaxTotalTemplates: 1})
	first := encMessage(1, 0, 1, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	replacement := encMessage(2, 0, 1, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 2, length: 2})))
	mustAppend(t, fresh, first)
	mustAppend(t, fresh, replacement)
	if fresh.TemplateCount() != 1 {
		t.Fatalf("replacement count = %d, want 1", fresh.TemplateCount())
	}
}

func TestRollbackLeavesPriorStateIntact(t *testing.T) {
	r := NewReceiver(testIdentity("rollback"), Limits{})
	install := encMessage(1, 0, 0, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	mustAppend(t, r, install)

	// A second message that installs a new template then hits an unknown data
	// set must fail and publish neither template nor records.
	bad := encMessage(2, 1, 0,
		encSet(TemplateSetID, encTemplateRecord(301, encField{id: 2, length: 1})),
		encSet(999, []byte{0}))
	expectFailure(t, r, bad)
	if r.Template(0, 301) != nil {
		t.Fatal("template 301 must not survive message rollback")
	}
	if r.Template(0, 300) == nil {
		t.Fatal("previously committed template 300 must remain")
	}
}

func TestHeaderValidation(t *testing.T) {
	r := NewReceiver(testIdentity("version"), Limits{})
	frame := encMessage(1, 0, 0)
	frame[0] = 0
	frame[1] = 9
	expectFailure(t, r, frame)

	r = NewReceiver(testIdentity("shortlen"), Limits{})
	short := make([]byte, headerLength)
	short[0], short[1] = 0, 10
	short[2], short[3] = 0, 8
	expectFailure(t, r, short)
}

func TestDecodedValuesDoNotAliasStreamBuffer(t *testing.T) {
	r := NewReceiver(testIdentity("alias"), Limits{})
	template := encTemplateRecord(300, encField{id: 1, length: 2})
	frame := encMessage(1, 0, 0,
		encSet(TemplateSetID, template),
		encSet(300, []byte{0xaa, 0xbb}))
	messages := mustAppend(t, r, frame)
	value := messages[0].Sets[0].Records[0].Fields[0].Value

	// Reuse the same backing slice for unrelated new input.
	for index := range frame {
		frame[index] = 0xff
	}
	if !bytes.Equal(value, []byte{0xaa, 0xbb}) {
		t.Fatalf("decoded value aliased stream buffer: %v", value)
	}
}

func TestZeroLengthFixedFieldRejected(t *testing.T) {
	r := NewReceiver(testIdentity("zerofield"), Limits{})
	frame := encMessage(1, 0, 0, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 0})))
	expectFailure(t, r, frame)
}

func TestTemplateSetPaddingOnly(t *testing.T) {
	r := NewReceiver(testIdentity("tmpl-padding"), Limits{})
	for _, padding := range []int{1, 2, 3} {
		frame := encMessage(1, 0, 0,
			encSet(TemplateSetID,
				encTemplateRecord(300, encField{id: 1, length: 1}),
				make([]byte, padding)))
		mustAppend(t, r, frame)
	}
}
