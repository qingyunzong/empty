package dataeng

import (
	"errors"
	"testing"
	"unicode/utf16"
)

func inferLock(t *testing.T, data string, options ...LockOption) (*Result, *Lock) {
	t.Helper()
	result, err := Infer([]Sample{{Name: "seed.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Ambiguous {
		t.Fatalf("seed inference is ambiguous: %v", result.Reasons)
	}
	lock, err := result.Lock(options...)
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}
	return result, lock
}

func TestLockAcceptsValidAndQuarantinesViolations(t *testing.T) {
	_, lock := inferLock(t, "id,name,amount\n1,Alice,10.00\n2,Bob,20.00\n")
	lockedDialect := lock.Dialect()
	if lock.Columns() != 3 {
		t.Fatalf("columns = %d, want 3", lock.Columns())
	}

	if verdict := lock.Validate("valid.csv", []byte("3,Carol,30.00\n")); !verdict.Accepted {
		t.Fatalf("valid file quarantined: %+v", verdict.Violations)
	}

	cases := []struct {
		name string
		data []byte
		kind ViolationKind
	}{
		{"width.csv", []byte("4,Dave\n"), ViolationWidth},
		{"delimiter.csv", []byte("5;Eve;50.00\n"), ViolationDelimiter},
		{"newline.csv", []byte("6,Frank,60.00\r\n"), ViolationNewline},
		{"encoding.csv", utf16LE("7,Grace,70.00\n"), ViolationEncoding},
	}
	for _, test := range cases {
		verdict := lock.Validate(test.name, test.data)
		if verdict.Accepted {
			t.Fatalf("%s was accepted", test.name)
		}
		if !verdict.IsQuarantined() {
			t.Fatalf("%s status = %s", test.name, verdict.Status)
		}
		if !hasViolation(verdict, test.kind) {
			t.Fatalf("%s violations = %+v, want %s", test.name, verdict.Violations, test.kind)
		}
	}

	// A quarantined file must not alter the batch rule or poison later files.
	if lock.Dialect() != lockedDialect {
		t.Fatalf("lock dialect drifted: %s -> %s", lockedDialect, lock.Dialect())
	}
	if verdict := lock.Validate("valid-again.csv", []byte("8,Heidi,80.00\n")); !verdict.Accepted {
		t.Fatalf("file after quarantine was rejected: %+v", verdict.Violations)
	}
}

func TestLockQuarantinesBrokenQuoteStructure(t *testing.T) {
	_, lock := inferLock(t, "id,name,amount\n1,\"Alice\",10.00\n2,\"Bob\",20.00\n")

	unterminated := lock.Validate("unterminated.csv", []byte("3,\"Carol,30.00\n"))
	if unterminated.Accepted || !hasViolation(unterminated, ViolationQuote) {
		t.Fatalf("unterminated quote verdict = %+v", unterminated)
	}

	bare := lock.Validate("bare.csv", []byte("3,Car\"ol,30.00\n"))
	if bare.Accepted || !hasViolation(bare, ViolationQuote) {
		t.Fatalf("bare quote verdict = %+v", bare)
	}
}

func TestLockWithQuotingDisabledRejectsQuoteAppearance(t *testing.T) {
	dialect := Dialect{
		Delimiter: ',',
		Quote:     0,
		Newline:   "\n",
		Encoding:  EncodingUTF8,
	}
	lock, err := NewLock(dialect, WithColumns(2))
	if err != nil {
		t.Fatalf("NewLock: %v", err)
	}
	verdict := lock.Validate("quoted.csv", []byte("a,\"b\"\n"))
	if verdict.Accepted || !hasViolation(verdict, ViolationQuote) {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestLockBackslashEscapeMismatch(t *testing.T) {
	_, lock := inferLock(t, "a,b\n\"x\\\"y\",1\n\"z\\\"w\",2\n")
	verdict := lock.Validate("doubled.csv", []byte("\"p\"\"q\",3\n"))
	if verdict.Accepted || !hasViolation(verdict, ViolationQuote) {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestLockRejectsUnexpectedBackslashEscape(t *testing.T) {
	_, lock := inferLock(t, "a,b\n\"x\",1\n\"y\",2\n")
	verdict := lock.Validate("escaped.csv", []byte("p\\,q,3\n"))
	if verdict.Accepted || !hasViolation(verdict, ViolationEscape) {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestLockAllowsBackslashBeforeDelimiterInsideQuotes(t *testing.T) {
	_, lock := inferLock(t, "a,b\n\"x\",1\n\"y\",2\n")
	verdict := lock.Validate("literal-backslash.csv", []byte("\"p\\,q\",3\n"))
	if !verdict.Accepted {
		t.Fatalf("valid quoted backslash was quarantined: %+v", verdict.Violations)
	}
}

func TestLockDifferentQuoteCharacter(t *testing.T) {
	_, lock := inferLock(t, "a,b\n\"x\",1\n\"y\",2\n")
	verdict := lock.Validate("single.csv", []byte("'p','q'\n"))
	if verdict.Accepted || !hasViolation(verdict, ViolationQuote) {
		t.Fatalf("verdict = %+v", verdict)
	}
}

func TestLockBOMVariationOption(t *testing.T) {
	_, lock := inferLock(t, "a,b\n1,2\n")
	withBOM := append([]byte{0xEF, 0xBB, 0xBF}, []byte("3,4\n")...)
	if verdict := lock.Validate("bom.csv", withBOM); !verdict.Accepted {
		t.Fatalf("BOM variation should be allowed by default: %+v", verdict.Violations)
	}

	strict, err := NewLock(lock.Dialect(), WithColumns(2), WithBOMVariation(false))
	if err != nil {
		t.Fatalf("NewLock: %v", err)
	}
	verdict := strict.Validate("bom.csv", withBOM)
	if verdict.Accepted || !hasViolation(verdict, ViolationEncoding) {
		t.Fatalf("strict BOM verdict = %+v", verdict)
	}
}

func TestLockEmptyFilesOption(t *testing.T) {
	_, lock := inferLock(t, "a,b\n1,2\n")
	if verdict := lock.Validate("empty.csv", nil); verdict.Accepted {
		t.Fatal("empty file should be quarantined by default")
	}
	lenient, err := NewLock(lock.Dialect(), WithColumns(2), WithEmptyFiles(true))
	if err != nil {
		t.Fatalf("NewLock: %v", err)
	}
	if verdict := lenient.Validate("empty.csv", nil); !verdict.Accepted {
		t.Fatalf("empty file should be accepted when allowed: %+v", verdict.Violations)
	}
	utf16Lock, err := NewLock(Dialect{
		Delimiter:   ',',
		Quote:       '"',
		DoubleQuote: true,
		Newline:     "\n",
		Encoding:    EncodingUTF16LE,
	}, WithColumns(2), WithEmptyFiles(true))
	if err != nil {
		t.Fatalf("NewLock UTF-16: %v", err)
	}
	if verdict := utf16Lock.Validate("empty.csv", nil); !verdict.Accepted {
		t.Fatalf("empty file has no encoding evidence and should be allowed: %+v", verdict.Violations)
	}
}

func TestLockCanDisableStrictNewline(t *testing.T) {
	_, lock := inferLock(t, "a,b\n1,2\n2,3\n")
	lenient, err := NewLock(lock.Dialect(), WithColumns(2), WithStrictNewline(false))
	if err != nil {
		t.Fatalf("NewLock: %v", err)
	}
	if verdict := lenient.Validate("crlf.csv", []byte("3,4\r\n")); !verdict.Accepted {
		t.Fatalf("CRLF should be accepted when strict newline is disabled: %+v", verdict.Violations)
	}
}

func TestLockRefusesAmbiguousResult(t *testing.T) {
	result, err := Infer([]Sample{{Name: "one.txt", Data: []byte("hello\nworld\n")}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if !result.Ambiguous {
		t.Fatal("expected ambiguity")
	}
	if _, err := result.Lock(); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("Lock error = %v, want ErrAmbiguous", err)
	}
	lock, err := result.Lock(AllowAmbiguousLock())
	if err != nil {
		t.Fatalf("AllowAmbiguousLock: %v", err)
	}
	if lock.Columns() != 1 {
		t.Fatalf("columns = %d, want 1", lock.Columns())
	}
}

func TestBatchPartitionsWithoutDrift(t *testing.T) {
	_, lock := inferLock(t, "a,b\n1,2\n2,3\n")
	batch, err := NewBatch(lock)
	if err != nil {
		t.Fatalf("NewBatch: %v", err)
	}
	before := batch.Dialect()

	batch.Ingest("ok1.csv", []byte("3,4\n"))
	batch.Ingest("bad.csv", []byte("5;6\n"))
	batch.Ingest("ok2.csv", []byte("7,8\n"))

	if got := len(batch.AcceptedFiles()); got != 2 {
		t.Fatalf("accepted = %d, want 2", got)
	}
	if got := len(batch.QuarantinedFiles()); got != 1 {
		t.Fatalf("quarantined = %d, want 1", got)
	}
	if batch.Dialect() != before {
		t.Fatalf("batch dialect drifted: %s -> %s", before, batch.Dialect())
	}
}

func TestCollectorLocksThenOnlyIngests(t *testing.T) {
	collector := NewCollector()
	if _, err := collector.IngestFile("early.csv", []byte("1,2\n")); !errors.Is(err, ErrNotLocked) {
		t.Fatalf("Ingest before lock error = %v, want ErrNotLocked", err)
	}
	if err := collector.AddFile("a.csv", []byte("id,name\n1,Alice\n")); err != nil {
		t.Fatalf("AddFile: %v", err)
	}
	if err := collector.AddFile("b.csv", []byte("id,name\n2,Bob\n")); err != nil {
		t.Fatalf("AddFile: %v", err)
	}
	result, err := collector.Lock()
	if err != nil {
		t.Fatalf("Collector.Lock: %v", err)
	}
	locked := result.Best.Dialect
	if !collector.Locked() {
		t.Fatal("collector should be locked")
	}
	if _, err := collector.Infer(); !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("Infer after lock error = %v, want ErrAlreadyLocked", err)
	}
	if _, err := collector.Lock(); !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("second Lock error = %v, want ErrAlreadyLocked", err)
	}

	if err := collector.AddFile("bad.csv", []byte("3;Carol\n")); err != nil {
		t.Fatalf("Add bad file: %v", err)
	}
	if err := collector.AddFile("good.csv", []byte("4,Dave\n")); err != nil {
		t.Fatalf("Add good file: %v", err)
	}
	batch := collector.Batch()
	if batch == nil {
		t.Fatal("missing batch")
	}
	if got := len(batch.QuarantinedFiles()); got != 1 {
		t.Fatalf("quarantined = %d, want 1", got)
	}
	if got := len(batch.AcceptedFiles()); got != 3 {
		t.Fatalf("accepted = %d, want 3 (two seeds plus one late file)", got)
	}
	if dialect, ok := collector.Dialect(); !ok || dialect != locked {
		t.Fatalf("collector dialect drifted: %s -> %s", locked, dialect)
	}
}

func TestLockParseReturnsRecordsAndVerdict(t *testing.T) {
	_, lock := inferLock(t, "a,b\n1,2\n2,3\n")
	records, verdict := lock.Parse("ok.csv", []byte("3,4\n"))
	if !verdict.Accepted || len(records) != 1 {
		t.Fatalf("records=%d verdict=%+v", len(records), verdict)
	}
	if records[0].Fields[0] != "3" || records[0].Fields[1] != "4" {
		t.Fatalf("fields = %v", records[0].Fields)
	}

	records, verdict = lock.Parse("bad.csv", []byte("5;6\n"))
	if verdict.Accepted || records != nil {
		t.Fatalf("records=%v verdict=%+v", records, verdict)
	}
}

func hasViolation(verdict FileVerdict, kind ViolationKind) bool {
	for _, violation := range verdict.Violations {
		if violation.Kind == kind {
			return true
		}
	}
	return false
}

func utf16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	data := append([]byte{0xFF, 0xFE}, make([]byte, len(units)*2)...)
	for i, unit := range units {
		data[2+i*2] = byte(unit)
		data[3+i*2] = byte(unit >> 8)
	}
	return data
}
