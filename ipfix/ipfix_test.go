package ipfix

import (
	"bytes"
	"errors"
	"testing"
)

// ---- Minimal wire encoder used only by tests ----

type encField struct {
	enterprise uint32
	id         uint16
	length     uint16
}

func be16(value uint16) []byte {
	return []byte{byte(value >> 8), byte(value)}
}

func be32(value uint32) []byte {
	return []byte{byte(value >> 24), byte(value >> 16), byte(value >> 8), byte(value)}
}

func encMessage(exportTime, sequence, domain uint32, sets ...[]byte) []byte {
	body := make([]byte, 0)
	for _, set := range sets {
		body = append(body, set...)
	}
	header := append(be16(10), be16(uint16(headerLength+len(body)))...)
	header = append(header, be32(exportTime)...)
	header = append(header, be32(sequence)...)
	header = append(header, be32(domain)...)
	return append(header, body...)
}

func encSet(id uint16, payload ...[]byte) []byte {
	body := make([]byte, 0)
	for _, part := range payload {
		body = append(body, part...)
	}
	return append(append(be16(id), be16(uint16(setHeaderLength+len(body)))...), body...)
}

func encTemplateRecord(id uint16, fields ...encField) []byte {
	out := append(be16(id), be16(uint16(len(fields)))...)
	for _, field := range fields {
		raw := field.id
		if field.enterprise != 0 {
			raw |= enterpriseFlag
		}
		out = append(out, be16(raw)...)
		out = append(out, be16(field.length)...)
		if field.enterprise != 0 {
			out = append(out, be32(field.enterprise)...)
		}
	}
	return out
}

func encWithdraw(id uint16) []byte {
	return append(be16(id), be16(0)...)
}

func encVarShort(value []byte) []byte {
	if len(value) >= 255 {
		panic("short form requires fewer than 255 bytes")
	}
	return append([]byte{byte(len(value))}, value...)
}

func encVarLong(value []byte) []byte {
	out := []byte{255}
	out = append(out, be16(uint16(len(value)))...)
	return append(out, value...)
}

func mustAppend(t *testing.T, r *Receiver, chunk []byte) []Message {
	t.Helper()
	messages, err := r.Append(chunk)
	if err != nil {
		t.Fatalf("Append returned unexpected error: %v", err)
	}
	return messages
}

func expectFailure(t *testing.T, r *Receiver, chunk []byte) {
	t.Helper()
	if _, err := r.Append(chunk); err == nil {
		t.Fatalf("expected failure, got nil")
	}
	if !r.Failed() {
		t.Fatalf("receiver did not enter failed state")
	}
	if _, err := r.Append(nil); !errors.Is(err, ErrReceiverFailed) {
		t.Fatalf("later append error = %v, want ErrReceiverFailed", err)
	}
}

func testIdentity(name string) ConnIdentity {
	return ConnIdentity{LocalAddr: "10.0.0.1:4739", RemoteAddr: name}
}

func TestDataBeforeTemplateInSameMessageRejected(t *testing.T) {
	r := NewReceiver(testIdentity("before"), Limits{})

	data := encSet(300, []byte{0x01, 0x02})
	template := encSet(TemplateSetID, encTemplateRecord(300,
		encField{id: 8, length: 2},
	))
	frame := encMessage(100, 7, 1, data, template)

	expectFailure(t, r, frame)
	if r.TemplateCount() != 0 {
		t.Fatalf("template count = %d, want 0 after rollback", r.TemplateCount())
	}
}

func TestTemplateReplacementVersions(t *testing.T) {
	r := NewReceiver(testIdentity("replace"), Limits{})

	v1 := encTemplateRecord(300, encField{id: 8, length: 2})
	first := encMessage(1, 0, 0, encSet(TemplateSetID, v1),
		encSet(300, []byte{0x11, 0x22}))
	msgs := mustAppend(t, r, first)
	if len(msgs) != 1 || len(msgs[0].Sets[0].Records) != 1 {
		t.Fatalf("first message decode failed: %+v", msgs)
	}
	got := msgs[0].Sets[0].Records[0].Fields[0].Value
	if !bytes.Equal(got, []byte{0x11, 0x22}) {
		t.Fatalf("v1 value = %v", got)
	}

	v2 := encTemplateRecord(300, encField{id: 8, length: 1}, encField{id: 12, length: 1})
	second := encMessage(2, 1, 0, encSet(TemplateSetID, v2),
		encSet(300, []byte{0x33, 0x44}))
	msgs = mustAppend(t, r, second)
	record := msgs[0].Sets[0].Records[0]
	if len(record.Fields) != 2 {
		t.Fatalf("v2 field count = %d, want 2", len(record.Fields))
	}
	if !bytes.Equal(record.Fields[0].Value, []byte{0x33}) ||
		!bytes.Equal(record.Fields[1].Value, []byte{0x44}) {
		t.Fatalf("v2 values = %+v", record.Fields)
	}
	if r.TemplateCount() != 1 {
		t.Fatalf("replacement must reuse one slot, count = %d", r.TemplateCount())
	}
}

func TestVariableLength255BranchAndShortForm(t *testing.T) {
	r := NewReceiver(testIdentity("var"), Limits{})

	template := encTemplateRecord(400,
		encField{id: 100, length: 65535},
		encField{enterprise: 9, id: 7, length: 65535},
	)
	longValue := bytes.Repeat([]byte{0xab}, 255)
	recordPayload := append(encVarLong(longValue), encVarShort([]byte{0x01, 0x02})...)
	emptyRecord := append(encVarShort(nil), encVarShort(nil)...)
	frame := encMessage(1, 0, 5,
		encSet(TemplateSetID, template),
		encSet(400, recordPayload, emptyRecord))

	msgs := mustAppend(t, r, frame)
	records := msgs[0].Sets[0].Records
	if len(records) != 2 {
		t.Fatalf("record count = %d, want 2", len(records))
	}
	first := records[0].Fields
	if len(first) != 2 || !bytes.Equal(first[0].Value, longValue) {
		t.Fatalf("long-form value mismatch: %+v", first)
	}
	if first[1].Enterprise != 9 || first[1].ID != 7 {
		t.Fatalf("enterprise field metadata = %+v", first[1])
	}
	if !bytes.Equal(first[1].Value, []byte{0x01, 0x02}) {
		t.Fatalf("short-form value = %v", first[1].Value)
	}
	if len(records[1].Fields[0].Value) != 0 {
		t.Fatalf("empty variable value = %v", records[1].Fields[0].Value)
	}
}

func TestAllZeroLegalRecordIsNotPadding(t *testing.T) {
	r := NewReceiver(testIdentity("zeros"), Limits{})

	template := encTemplateRecord(500,
		encField{id: 1, length: 1},
		encField{id: 2, length: 1},
	)
	// Two full two-byte zero records followed by one legal zero padding byte.
	payload := append([]byte{0, 0, 0, 0}, 0)
	frame := encMessage(1, 0, 0,
		encSet(TemplateSetID, template),
		encSet(500, payload))

	msgs := mustAppend(t, r, frame)
	records := msgs[0].Sets[0].Records
	if len(records) != 2 {
		t.Fatalf("record count = %d, want 2 full records", len(records))
	}
	for _, record := range records {
		for _, field := range record.Fields {
			if len(field.Value) != 1 || field.Value[0] != 0 {
				t.Fatalf("legal zero field misread: %+v", field)
			}
		}
	}
}

func TestWithdrawAllAndDomainIsolation(t *testing.T) {
	r := NewReceiver(testIdentity("withdraw"), Limits{})

	installA := encMessage(1, 0, 10, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 1, length: 1})))
	installB := encMessage(1, 0, 20, encSet(TemplateSetID,
		encTemplateRecord(300, encField{id: 2, length: 2})))
	mustAppend(t, r, installA)
	mustAppend(t, r, installB)
	if r.TemplateCount() != 2 {
		t.Fatalf("template count = %d, want 2", r.TemplateCount())
	}

	withdraw := encMessage(2, 0, 10, encSet(TemplateSetID, encWithdraw(TemplateSetID)))
	mustAppend(t, r, withdraw)
	if r.Template(10, 300) != nil {
		t.Fatal("domain 10 template should be withdrawn")
	}
	if r.Template(20, 300) == nil {
		t.Fatal("domain 20 template must remain installed")
	}
	if r.TemplateCount() != 1 {
		t.Fatalf("template count after withdraw-all = %d, want 1", r.TemplateCount())
	}

	// The withdrawn domain cannot decode data, while the isolated domain can.
	unknown := encMessage(3, 0, 10, encSet(300, []byte{0}))
	expectFailure(t, r, unknown)

	fresh := NewReceiver(testIdentity("new-connection"), Limits{})
	if fresh.Template(20, 300) != nil {
		t.Fatal("new connection identity must not inherit templates")
	}
}

func TestSequenceWraparoundAndRecords(t *testing.T) {
	r := NewReceiver(testIdentity("wrap"), Limits{})

	template := encTemplateRecord(600, encField{id: 1, length: 1})
	first := encMessage(1, 0xffffffff, 0,
		encSet(TemplateSetID, template),
		encSet(600, []byte{0xa}, []byte{0xb}))
	msgs := mustAppend(t, r, first)
	if len(msgs[0].Sets[0].Records) != 2 {
		t.Fatal("expected two data records")
	}

	// 0xffffffff + the previous message's two records wraps to 1.
	second := encMessage(2, 1, 0, encSet(600, []byte{0xc}))
	msgs = mustAppend(t, r, second)
	if msgs[0].Sequence != 1 {
		t.Fatalf("wrapped sequence = %d, want 1", msgs[0].Sequence)
	}

	bad := encMessage(3, 99, 0, encSet(600, []byte{0xd}))
	expectFailure(t, r, bad)
	if r.Template(0, 600) == nil {
		t.Fatal("sequence failure must not roll back committed templates")
	}
}

func TestAllChunkCutPoints(t *testing.T) {
	template := encTemplateRecord(700,
		encField{id: 1, length: 2},
		encField{id: 2, length: 65535},
	)
	first := encMessage(1, 0, 0,
		encSet(TemplateSetID, template),
		encSet(700, append([]byte{0x11, 0x22}, encVarShort([]byte{0x99})...)))
	second := encMessage(2, 1, 0, encSet(700,
		append([]byte{0x33, 0x44}, encVarLong([]byte{0x88, 0x77})...)))
	stream := append(append([]byte{}, first...), second...)

	for cut := 1; cut < len(stream); cut++ {
		r := NewReceiver(testIdentity("chunks"), Limits{})
		var got []Message
		for start := 0; start < len(stream); start += cut {
			end := start + cut
			if end > len(stream) {
				end = len(stream)
			}
			got = append(got, mustAppend(t, r, stream[start:end])...)
		}
		if err := r.EndInput(); err != nil {
			t.Fatalf("cut %d: EndInput: %v", cut, err)
		}
		if len(got) != 2 {
			t.Fatalf("cut %d: message count = %d, want 2", cut, len(got))
		}
		if len(got[1].Sets[0].Records) != 1 {
			t.Fatalf("cut %d: second record missing", cut)
		}
	}
}

func TestTruncationAndRejectedSets(t *testing.T) {
	template := encTemplateRecord(800, encField{id: 1, length: 1})
	good := encMessage(1, 0, 0,
		encSet(TemplateSetID, template),
		encSet(800, []byte{0x01}))

	for _, residual := range [][]byte{
		good[:5],           // partial header
		good[:len(good)-1], // partial final message
	} {
		r := NewReceiver(testIdentity("trunc"), Limits{})
		committed := mustAppend(t, r, good)
		if _, err := r.Append(residual); err != nil {
			t.Fatalf("partial frame should remain buffered, got %v", err)
		}
		if err := r.EndInput(); err == nil {
			t.Fatal("EndInput should report truncated residual")
		}
		if !r.Failed() {
			t.Fatal("truncated EOF should leave receiver in failed terminal state")
		}
		if len(committed) != 1 {
			t.Fatalf("committed messages = %d, want prior message retained", len(committed))
		}
	}

	r := NewReceiver(testIdentity("options"), Limits{})
	options := encMessage(1, 0, 0, encSet(OptionSetID, []byte{0, 0, 0, 0}))
	expectFailure(t, r, options)

	r = NewReceiver(testIdentity("lowid"), Limits{})
	lowID := encMessage(1, 0, 0, encSet(TemplateSetID,
		encTemplateRecord(255, encField{id: 1, length: 1})))
	expectFailure(t, r, lowID)
}

func TestPaddingAndMalformedTrailingBytes(t *testing.T) {
	r := NewReceiver(testIdentity("padding"), Limits{})
	template := encTemplateRecord(900, encField{id: 1, length: 4})
	// One complete record, then three zero padding bytes inside the data set.
	dataSet := encSet(900, []byte{1, 2, 3, 4, 0, 0, 0})
	// Template set with two zero padding bytes, then a message-level zero.
	templateSet := encSet(TemplateSetID, template, []byte{0, 0})
	frame := encMessage(1, 0, 0, templateSet, dataSet, []byte{0})
	msgs := mustAppend(t, r, frame)
	if len(msgs[0].Sets[0].Records) != 1 {
		t.Fatalf("records = %d, want 1", len(msgs[0].Sets[0].Records))
	}

	// A non-padding short tail must fail rather than being discarded.
	badPayload := append([]byte{1, 2, 3, 4}, []byte{0, 0, 1}...)
	bad := encMessage(2, 1, 0, encSet(900, badPayload))
	expectFailure(t, r, bad)
}

func TestSingleTemplateWithdrawAndFieldOrder(t *testing.T) {
	r := NewReceiver(testIdentity("withdraw-one"), Limits{})
	template := encTemplateRecord(301,
		encField{id: 8, length: 1},
		encField{enterprise: 42, id: 15, length: 2},
	)
	install := encMessage(1, 0, 0,
		encSet(TemplateSetID, template),
		encSet(301, []byte{0x09, 0x0a, 0x0b}))
	msgs := mustAppend(t, r, install)
	fields := msgs[0].Sets[0].Records[0].Fields
	if fields[0].Index != 0 || fields[0].ID != 8 || fields[0].Enterprise != 0 {
		t.Fatalf("field 0 metadata mismatch: %+v", fields[0])
	}
	if fields[1].Index != 1 || fields[1].ID != 15 || fields[1].Enterprise != 42 {
		t.Fatalf("enterprise field metadata mismatch: %+v", fields[1])
	}

	// Withdrawing a missing template is successful.
	mustAppend(t, r, encMessage(2, 1, 0, encSet(TemplateSetID, encWithdraw(302))))
	mustAppend(t, r, encMessage(3, 1, 0, encSet(TemplateSetID, encWithdraw(301))))
	if r.Template(0, 301) != nil {
		t.Fatal("template 301 should be withdrawn")
	}
}

func TestBudgetsStopBeforeOversizedWork(t *testing.T) {
	t.Run("message bytes", func(t *testing.T) {
		r := NewReceiver(testIdentity("bytes"), Limits{MaxMessageBytes: 20})
		frame := encMessage(1, 0, 0, encSet(TemplateSetID,
			encTemplateRecord(300, encField{id: 1, length: 1})))
		expectFailure(t, r, frame)
	})

	t.Run("template fields", func(t *testing.T) {
		r := NewReceiver(testIdentity("fields"), Limits{MaxTemplateFields: 1})
		frame := encMessage(1, 0, 0, encSet(TemplateSetID,
			encTemplateRecord(300,
				encField{id: 1, length: 1},
				encField{id: 2, length: 1})))
		expectFailure(t, r, frame)
	})

	t.Run("total templates", func(t *testing.T) {
		r := NewReceiver(testIdentity("total"), Limits{MaxTotalTemplates: 1})
		frame := encMessage(1, 0, 0, encSet(TemplateSetID,
			encTemplateRecord(300, encField{id: 1, length: 1}),
			encTemplateRecord(301, encField{id: 2, length: 1})))
		expectFailure(t, r, frame)
		if r.TemplateCount() != 0 {
			t.Fatalf("rolled-back template count = %d", r.TemplateCount())
		}
	})

	t.Run("message records", func(t *testing.T) {
		r := NewReceiver(testIdentity("records"), Limits{MaxMessageRecords: 1})
		template := encTemplateRecord(300, encField{id: 1, length: 1})
		frame := encMessage(1, 0, 0,
			encSet(TemplateSetID, template),
			encSet(300, []byte{1}, []byte{2}))
		expectFailure(t, r, frame)
	})
}

func TestBadVariableAndSetBoundaries(t *testing.T) {
	r := NewReceiver(testIdentity("badvar"), Limits{})
	template := encTemplateRecord(300, encField{id: 1, length: 65535})
	install := encMessage(1, 0, 0, encSet(TemplateSetID, template))
	mustAppend(t, r, install)

	// Long-form prefix claiming 10 bytes when only one byte remains.
	bad := encMessage(2, 0, 0, encSet(300, []byte{255, 0, 10, 1}))
	expectFailure(t, r, bad)

	r = NewReceiver(testIdentity("cross"), Limits{})
	install = encMessage(1, 0, 0, encSet(TemplateSetID, template))
	mustAppend(t, r, install)
	// Declare a 32-byte message but give the only set a 40-byte length.
	cross := make([]byte, 32)
	cross[0], cross[1] = 0, 10
	cross[2], cross[3] = 0, 32
	cross[16], cross[17] = be16(300)[0], be16(300)[1]
	cross[18], cross[19] = 0, 40
	expectFailure(t, r, cross)
}
