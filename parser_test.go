package dataeng

import (
	"errors"
	"strings"
	"testing"
)

func TestParseCompleteBatchAndFieldTree(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"PID|1||12345^^^HOSP^MR~67890^^^ALT^MR||Doe^John\r" +
		"OBX|1|ST|NOTE||A\\F\\B\\S\\C\\R\\D\\T\\E\\X7C\\\r" +
		"BTS|1\r" +
		"FTS|1\r"

	batch, err := ParseBatch([]byte(raw))
	if err != nil {
		t.Fatalf("ParseBatch() error = %v", err)
	}
	if !batch.Complete() || !batch.Valid() || !batch.Published() {
		t.Fatalf(
			"batch state complete=%v valid=%v published=%v",
			batch.Complete(),
			batch.Valid(),
			batch.Published(),
		)
	}
	if got := string(batch.Raw()); got != raw {
		t.Fatalf("Raw() did not preserve the payload")
	}
	if batch.BTSMessageCount != 1 || !batch.BTSMessageCountSet {
		t.Fatalf("BTS evidence = %d, set=%v", batch.BTSMessageCount, batch.BTSMessageCountSet)
	}
	if batch.FTSBatchCount != 1 || !batch.FTSBatchCountSet {
		t.Fatalf("FTS evidence = %d, set=%v", batch.FTSBatchCount, batch.FTSBatchCountSet)
	}
	if batch.ObservedMessages != 1 || batch.ValidMessages != 1 || batch.FailedMessages != 0 {
		t.Fatalf(
			"message counts observed=%d valid=%d failed=%d",
			batch.ObservedMessages,
			batch.ValidMessages,
			batch.FailedMessages,
		)
	}
	if len(batch.Messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(batch.Messages))
	}

	message := batch.Messages[0]
	if message.StartLine != 3 || message.EndLine != 5 {
		t.Fatalf("message lines = %d-%d, want 3-5", message.StartLine, message.EndLine)
	}
	if got := len(message.Segments); got != 3 {
		t.Fatalf("segments = %d, want 3", got)
	}
	if message.Segments[0].Index != 3 || message.Segments[2].Index != 5 {
		t.Fatalf(
			"global segment indexes = %d, %d",
			message.Segments[0].Index,
			message.Segments[2].Index,
		)
	}
	if message.Segments[1].MessageSegmentIndex != 2 {
		t.Fatalf("message segment index = %d, want 2", message.Segments[1].MessageSegmentIndex)
	}

	if got := message.MSH.Value(1); got != "|" {
		t.Fatalf("MSH-1 = %q", got)
	}
	if got := message.MSH.Value(2); got != "^~\\&" {
		t.Fatalf("MSH-2 = %q", got)
	}
	code, trigger, structure := message.Type()
	if code != "ADT" || trigger != "A01" || structure != "" {
		t.Fatalf("message type = %q^%q^%q", code, trigger, structure)
	}

	pid := message.Segment("PID")
	if pid == nil {
		t.Fatal("PID segment not found")
	}
	patientID := pid.Field(3)
	if got := len(patientID.Repetitions); got != 2 {
		t.Fatalf("PID-3 repetitions = %d, want 2", got)
	}
	if got := patientID.Values(); len(got) != 2 || got[0] != "12345" || got[1] != "67890" {
		t.Fatalf("PID-3 values = %#v", got)
	}
	if got := patientID.Repetitions[0].Components[3].Value(); got != "HOSP" {
		t.Fatalf("PID-3.1.4 = %q, want HOSP", got)
	}
	if got := patientID.Repetitions[1].Components[4].Value(); got != "MR" {
		t.Fatalf("PID-3.2.5 = %q, want MR", got)
	}
	if got := pid.ComponentValue(5, 1, 2); got != "John" {
		t.Fatalf("PID-5.2 = %q, want John", got)
	}

	obx := message.Segment("OBX")
	if got := obx.Value(5); got != "A|B^C~D&E|" {
		t.Fatalf("OBX-5 = %q, want decoded escapes", got)
	}
	if got := string(obx.RawBytes()); got != obx.RawLine() {
		t.Fatalf("segment raw mismatch")
	}

	if got := string(message.Raw()); got != raw[strings.Index(raw, "MSH|"):strings.Index(raw, "BTS|")] {
		t.Fatalf("message Raw() did not preserve its exact bytes")
	}
}

func TestParseUsesMSHDelimiters(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH*%$!@*APP*FAC*RCV*RFAC*202611160103**ADT%A01*MSG0002*P*2.5\r" +
		"PID*1**A!F!B\r" +
		"BTS|1\r" +
		"FTS|1\r"

	batch, err := ParseBatch([]byte(raw))
	if err != nil {
		t.Fatalf("ParseBatch() error = %v", err)
	}
	message := batch.Messages[0]
	want := Delimiters{
		Field:        '*',
		Component:    '%',
		Repetition:   '$',
		Escape:       '!',
		Subcomponent: '@',
	}
	if message.Delimiters != want {
		t.Fatalf("MSH delimiters = %#v, want %#v", message.Delimiters, want)
	}
	if got := message.MSH.Value(2); got != "%$!@" {
		t.Fatalf("MSH-2 = %q", got)
	}
	if got := message.Value("PID", 3); got != "A*B" {
		t.Fatalf("PID-3 = %q, want A*B", got)
	}
	if batch.BTSMessageCount != 1 || batch.FTSBatchCount != 1 {
		t.Fatalf("envelope counts changed with message delimiters")
	}
}

func TestMessageFailurePreservesEnvelopeEvidence(t *testing.T) {
	first := "MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"PID|1||OK\r"
	second := "MSH|^~\\&|APP|FAC|RCV|RFAC|202611160104||ADT^A01|MSG0002|P|2.5\r" +
		"PID|1||BROKEN\\Q\r"
	raw := "BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		first + second +
		"BTS|2\r"

	batch, err := ParseBatch([]byte(raw))
	if err == nil {
		t.Fatal("ParseBatch() error = nil, want message decode error")
	}
	if batch == nil {
		t.Fatal("batch is nil; per-message failure must retain evidence")
	}
	if !batch.Complete() {
		t.Fatal("message failure must not make a complete envelope structurally incomplete")
	}
	if batch.Published() {
		t.Fatal("batch containing a failed message must not be published")
	}
	if batch.BTSMessageCount != 2 {
		t.Fatalf("BTS-1 evidence = %d, want unchanged 2", batch.BTSMessageCount)
	}
	if batch.ObservedMessages != 2 || batch.ValidMessages != 1 || batch.FailedMessages != 1 {
		t.Fatalf(
			"counts observed=%d valid=%d failed=%d",
			batch.ObservedMessages,
			batch.ValidMessages,
			batch.FailedMessages,
		)
	}
	if len(batch.Errors) != 1 {
		t.Fatalf("diagnostics = %d, want 1", len(batch.Errors))
	}

	parseErr := batch.Errors[0]
	if parseErr.Kind != ErrEscape {
		t.Fatalf("kind = %q, want %q", parseErr.Kind, ErrEscape)
	}
	if parseErr.SegmentID != "PID" || parseErr.Line != 5 {
		t.Fatalf("location = %s line %d", parseErr.SegmentID, parseErr.Line)
	}
	if parseErr.Column <= 0 || parseErr.Offset <= 0 {
		t.Fatalf("column/offset = %d/%d, want original positions", parseErr.Column, parseErr.Offset)
	}
	if string(parseErr.RawMessage) != second {
		t.Fatalf("diagnostic raw message did not replay exact failed message")
	}
	if string(parseErr.RawSegment) != "PID|1||BROKEN\\Q\r" {
		t.Fatalf("diagnostic raw segment = %q", string(parseErr.RawSegment))
	}
	if got := string(batch.Messages[1].Raw()); got != second {
		t.Fatalf("failed message Raw() = %q, want exact input", got)
	}
	segmentRaw, messageRaw := batch.Messages[1].Segment("PID").Replays()
	if string(segmentRaw) != "PID|1||BROKEN\\Q\r" || string(messageRaw) != second {
		t.Fatal("Segment.Replays() did not return exact segment and message")
	}
}

func TestTruncatedBatchIsNotPublished(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"PID|1||12345\r" +
		"BTS|1\r"

	batch, err := ParseBatch([]byte(raw))
	if batch != nil {
		t.Fatalf("truncated batch was published: %#v", batch)
	}
	if err == nil {
		t.Fatal("ParseBatch() error = nil")
	}

	parseErr, ok := AsParseError(err)
	if !ok {
		t.Fatalf("error type = %T, want ParseError", err)
	}
	if parseErr.Kind != ErrTruncated {
		t.Fatalf("kind = %q, want %q", parseErr.Kind, ErrTruncated)
	}
	if parseErr.Batch == nil || parseErr.Evidence == nil {
		t.Fatal("rejected batch did not retain diagnostic evidence")
	}
	if parseErr.Batch.Published() {
		t.Fatal("rejected evidence batch reports published")
	}
	if parseErr.Evidence.BTSMessageCount != 1 {
		t.Fatalf("BTS evidence = %d, want 1", parseErr.Evidence.BTSMessageCount)
	}
	if len(parseErr.Batch.Messages) != 1 {
		t.Fatalf("evidence messages = %d, want 1", len(parseErr.Batch.Messages))
	}
	if got := string(parseErr.Batch.Messages[0].Raw()); got != raw[strings.Index(raw, "MSH|"):strings.Index(raw, "BTS|")] {
		t.Fatal("evidence did not preserve replayable message")
	}
}

func TestMissingBTSEvidence(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r"

	batch, err := ParseBatch([]byte(raw))
	if batch != nil {
		t.Fatal("batch with missing BTS/FTS was published")
	}
	parseErr, ok := AsParseError(err)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if parseErr.Kind != ErrTruncated {
		t.Fatalf("kind = %q", parseErr.Kind)
	}
	if parseErr.Evidence == nil || parseErr.Evidence.ObservedMessages != 1 {
		t.Fatalf("observed message evidence = %#v", parseErr.Evidence)
	}
	if parseErr.Evidence.BTSMessageCountSet || parseErr.Evidence.FTSBatchCountSet {
		t.Fatal("missing trailers must not invent count declarations")
	}
}

func TestMessageOutsideBHSSectionIsRejected(t *testing.T) {
	raw := "BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"BTS|1\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160104||ADT^A01|MSG0002|P|2.5\r" +
		"BTS|1\r"

	batch, err := ParseBatch([]byte(raw))
	if batch != nil {
		t.Fatal("message outside BHS was published")
	}
	parseErr, ok := AsParseError(err)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if parseErr.Kind != ErrUnexpected || parseErr.SegmentID != "MSH" {
		t.Fatalf("error = %s line %d", parseErr.Kind, parseErr.Line)
	}
}

func TestCountMismatchRetainsDeclaredCount(t *testing.T) {
	raw := "BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"BTS|2\r"

	batch, err := ParseBatch([]byte(raw))
	if batch != nil {
		t.Fatal("count-mismatched batch was published")
	}
	parseErr, ok := AsParseError(err)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if parseErr.Kind != ErrCountMismatch {
		t.Fatalf("kind = %q, want %q", parseErr.Kind, ErrCountMismatch)
	}
	if parseErr.Evidence == nil {
		t.Fatal("missing evidence")
	}
	if parseErr.Evidence.BTSMessageCount != 2 || parseErr.Evidence.ObservedMessages != 1 {
		t.Fatalf(
			"declared/observed = %d/%d, want 2/1",
			parseErr.Evidence.BTSMessageCount,
			parseErr.Evidence.ObservedMessages,
		)
	}
}

func TestFTSMismatchRetainsDeclaredBatchCount(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"BTS|1\r" +
		"FTS|2\r"

	batch, err := ParseBatch([]byte(raw))
	if batch != nil {
		t.Fatal("FTS-mismatched batch was published")
	}
	parseErr, ok := AsParseError(err)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	if parseErr.Kind != ErrCountMismatch {
		t.Fatalf("kind = %q", parseErr.Kind)
	}
	if parseErr.Evidence.FTSBatchCount != 2 || parseErr.Evidence.ObservedBatches != 1 {
		t.Fatalf(
			"declared/observed batches = %d/%d",
			parseErr.Evidence.FTSBatchCount,
			parseErr.Evidence.ObservedBatches,
		)
	}
}

func TestMultipleBatchSectionsAndFTSCount(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"BTS|1\r" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160104||\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160105||ADT^A01|MSG0002|P|2.5\r" +
		"MSH|^~\\&|APP|FAC|RCV|RFAC|202611160106||ADT^A01|MSG0003|P|2.5\r" +
		"BTS|2\r" +
		"FTS|2\r"

	batch, err := ParseBatch([]byte(raw))
	if err != nil {
		t.Fatalf("ParseBatch() error = %v", err)
	}
	if len(batch.Sections) != 2 {
		t.Fatalf("sections = %d, want 2", len(batch.Sections))
	}
	if len(batch.Messages) != 3 || batch.ObservedMessages != 3 {
		t.Fatalf("messages = %d, observed = %d", len(batch.Messages), batch.ObservedMessages)
	}
	if batch.FTSBatchCount != 2 || batch.ObservedBatches != 2 {
		t.Fatalf("batch counts = %d/%d", batch.FTSBatchCount, batch.ObservedBatches)
	}
	if got := batch.BTSMessageCounts; len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("BTS evidence = %#v", got)
	}
	if batch.BTSMessageCount != 3 || batch.DeclaredMessages != 3 {
		t.Fatalf("aggregate declared messages = %d", batch.BTSMessageCount)
	}
	if batch.Sections[0].Index != 1 || batch.Sections[1].Index != 2 {
		t.Fatal("section indexes not assigned")
	}
	if batch.Sections[1].Messages[1].SectionIndex != 2 {
		t.Fatal("message section index not assigned")
	}
}

func TestCRLFOffsetsAndZeroCount(t *testing.T) {
	raw := "FHS|^~\\&|SRC|SFAC|DST|DFAC|202611160101||\r\n" +
		"BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r\n" +
		"BTS|0\r\n" +
		"FTS|1\r\n"

	batch, err := ParseBatch([]byte(raw))
	if err != nil {
		t.Fatalf("ParseBatch() error = %v", err)
	}
	if batch.BTSMessageCount != 0 || batch.ObservedMessages != 0 {
		t.Fatalf("zero-message batch counts = %d/%d", batch.BTSMessageCount, batch.ObservedMessages)
	}
	if batch.BTS.Terminator != "\r\n" {
		t.Fatalf("BTS terminator = %q", batch.BTS.Terminator)
	}
	if batch.FTS.Line != 4 || batch.FTS.Offset != strings.Index(raw, "FTS|") {
		t.Fatalf("FTS position = line %d offset %d", batch.FTS.Line, batch.FTS.Offset)
	}
	if got := string(batch.Raw()); got != raw {
		t.Fatal("CRLF payload was not preserved")
	}
}

func TestUTF8BOMAndParseMessage(t *testing.T) {
	messageRaw := "MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r" +
		"PID|1||12345\r"
	raw := "\xef\xbb\xbf" + messageRaw

	message, err := ParseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("ParseMessage() error = %v", err)
	}
	if message.Offset != 3 || message.StartLine != 1 {
		t.Fatalf("message position = line %d offset %d", message.StartLine, message.Offset)
	}
	if got := string(message.Raw()); got != messageRaw {
		t.Fatal("BOM leaked into replayable message bytes")
	}
}

func TestUnescapeAndDelimiterValidation(t *testing.T) {
	delimiters := DefaultDelimiters()
	value, err := Unescape(`A\F\B\S\C\R\D\T\E\E\\X7C\`, delimiters)
	if err != nil {
		t.Fatalf("Unescape() error = %v", err)
	}
	if value != "A|B^C~D&E\\|" {
		t.Fatalf("Unescape() = %q", value)
	}
	if unknown, err := Unescape(`A\Zfoo\B`, delimiters); err != nil || unknown != `A\Zfoo\B` {
		t.Fatalf("unknown escape = %q, err=%v", unknown, err)
	}

	if _, err := Unescape("broken\\Q", delimiters); err == nil {
		t.Fatal("unterminated escape was accepted")
	}
	var escapeErr *EscapeError
	if _, err := Unescape("bad\\X0\\", delimiters); !errors.As(err, &escapeErr) {
		t.Fatalf("odd hex escape error = %T", err)
	}

	if _, err := DelimitersFromHeader("MSH|^~|"); err == nil {
		t.Fatal("short MSH-2 was accepted")
	}
	if _, err := DelimitersFromHeader("MSH|||||"); err == nil {
		t.Fatal("duplicate delimiters were accepted")
	}
}

func TestInvalidMSHDoesNotChangeCountEvidence(t *testing.T) {
	raw := "BHS|^~\\&|SRC|SFAC|DST|DFAC|202611160102||\r" +
		"MSH|^~|APP|FAC\r" +
		"PID|1||12345\r" +
		"BTS|1\r"

	batch, err := ParseBatch([]byte(raw))
	if err == nil {
		t.Fatal("invalid MSH was accepted")
	}
	if batch == nil {
		t.Fatal("message-level delimiter failure lost envelope evidence")
	}
	if !batch.Complete() || batch.BTSMessageCount != 1 || batch.ObservedMessages != 1 {
		t.Fatalf(
			"evidence complete=%v declared=%d observed=%d",
			batch.Complete(),
			batch.BTSMessageCount,
			batch.ObservedMessages,
		)
	}
	if batch.Messages[0].Err == nil || batch.Messages[0].Err.Kind != ErrDelimiter {
		t.Fatalf("message error = %#v", batch.Messages[0].Err)
	}
	if got := string(batch.Messages[0].Raw()); !strings.HasPrefix(got, "MSH|^~|APP|FAC\r") {
		t.Fatalf("failed message raw = %q", got)
	}
}

func TestParseReaderAndSizeLimit(t *testing.T) {
	raw := "MSH|^~\\&|APP|FAC|RCV|RFAC|202611160103||ADT^A01|MSG0001|P|2.5\r"
	batch, err := NewParser(1024).ParseReader(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("ParseReader() error = %v", err)
	}
	if batch == nil || len(batch.Messages) != 1 {
		t.Fatal("ParseReader() did not parse the message")
	}

	_, err = NewParser(8).ParseReader(strings.NewReader(raw))
	if err == nil {
		t.Fatal("size limit was ignored")
	}
}
