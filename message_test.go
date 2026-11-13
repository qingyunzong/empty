package dataeng

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestSequentialReassembly(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if message.SectionComplete("1") {
		t.Fatal("section should not be complete yet")
	}
	if err := message.AddBytes("1", 5, []byte("world")); err != nil {
		t.Fatal(err)
	}
	if !message.SectionComplete("1") {
		t.Fatal("section should be complete")
	}
	if !message.MessageComplete() {
		t.Fatal("message should be complete")
	}
	got, err := message.SectionBytes("1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "helloworld" {
		t.Fatalf("got %q", got)
	}
}

func TestOutOfOrderReassembly(t *testing.T) {
	message := New()
	if err := message.Expect("TEXT", 11); err != nil {
		t.Fatal(err)
	}
	if err := message.Add(Segment{Section: "TEXT", Origin: 5, Data: []byte(" world")}); err != nil {
		t.Fatal(err)
	}
	if err := message.Add(Segment{Section: "TEXT", Origin: 0, Data: []byte("hello")}); err != nil {
		t.Fatal(err)
	}
	got, err := message.Bytes("TEXT")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestIdenticalOverlapIsIdempotent(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("abcdefghij")); err != nil {
		t.Fatal(err)
	}
	result, err := message.Submit(Segment{Section: "1", Origin: 3, Data: []byte("defgh")})
	if err != nil {
		t.Fatal(err)
	}
	if result.Added != 0 || result.Overlapped != 5 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if !result.Complete {
		t.Fatal("duplicate fragment should leave the section complete")
	}
	got, err := message.SectionBytes("1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "abcdefghij" {
		t.Fatalf("got %q", got)
	}
	if message.Failed() {
		t.Fatal("idempotent overlap must not fail the message")
	}
}

func TestOverlapConflictFailsMessage(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 6); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("abcdef")); err != nil {
		t.Fatal(err)
	}
	err := message.AddBytes("1", 2, []byte("XY"))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("want *ConflictError, got %T", err)
	}
	if conflict.Offset != 2 || conflict.Existing != 'c' || conflict.Incoming != 'X' {
		t.Fatalf("unexpected conflict detail: %+v", conflict)
	}
	if !message.Failed() {
		t.Fatal("conflict must fail the message")
	}
	if message.SectionComplete("1") {
		t.Fatal("a section with a conflict must not be complete")
	}
	if _, err := message.Assemble(); !errors.Is(err, ErrMessageFailed) || !errors.Is(err, ErrConflict) {
		t.Fatalf("Assemble error = %v", err)
	}
	if _, err := message.SectionBytes("1"); !errors.Is(err, ErrConflict) {
		t.Fatalf("SectionBytes error = %v", err)
	}
}

func TestConflictLabelsExistingAndIncomingWhenFragmentStartsEarlier(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 6); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 2, []byte("cdef")); err != nil {
		t.Fatal(err)
	}
	err := message.AddBytes("1", 0, []byte("abXe"))
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("want *ConflictError, got %v", err)
	}
	if conflict.Offset != 2 || conflict.Existing != 'c' || conflict.Incoming != 'X' {
		t.Fatalf("unexpected conflict detail: %+v", conflict)
	}
}

func TestGapIsReported(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 6, []byte("ghij")); err != nil {
		t.Fatal(err)
	}
	if message.SectionComplete("1") {
		t.Fatal("section with a hole must not be complete")
	}
	gaps := message.Gaps("1")
	if len(gaps) != 1 || gaps[0] != (Range{Start: 4, End: 6}) {
		t.Fatalf("gaps = %v", gaps)
	}
	_, err := message.SectionBytes("1")
	if !errors.Is(err, ErrIncomplete) || !errors.Is(err, ErrGap) {
		t.Fatalf("want incomplete gap, got %v", err)
	}
	if message.Failed() {
		t.Fatal("a gap is retryable and must not fail the message")
	}
}

func TestTruncationIsDetected(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 100); err != nil {
		t.Fatal(err)
	}
	if err := message.AddPartial("1", 0, 100, []byte(strings.Repeat("a", 60))); err != nil {
		t.Fatal(err)
	}
	status, ok := message.Status("1")
	if !ok {
		t.Fatal("missing status")
	}
	if !status.Truncated {
		t.Fatalf("expected truncation, status = %+v", status)
	}
	if len(status.Truncations) != 1 || status.Truncations[0].Needed != 100 {
		t.Fatalf("truncations = %+v", status.Truncations)
	}
	if status.Complete {
		t.Fatal("truncated section must not be complete")
	}
	if !message.Truncated("1") {
		t.Fatal("Truncated should report true")
	}
	if err := message.Check("1"); !errors.Is(err, ErrTruncated) || !errors.Is(err, ErrIncomplete) {
		t.Fatalf("Check error = %v", err)
	}
}

func TestShortLiteralAtSectionEndIsNotTruncation(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	result, err := message.Submit(Segment{
		Section:         "1",
		Origin:          0,
		RequestedLength: 50,
		Data:            []byte("0123456789"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated {
		t.Fatal("a literal that reaches the declared end is not truncated")
	}
	status, _ := message.Status("1")
	if status.Truncated {
		t.Fatalf("unexpected truncation: %+v", status)
	}
	if !status.Complete {
		t.Fatal("section should be complete")
	}
}

func TestTruncationOnlyProvableWithExpectedSize(t *testing.T) {
	message := NewMessage()
	if err := message.AddPartial("1", 0, 100, []byte("short")); err != nil {
		t.Fatal(err)
	}
	status, _ := message.Status("1")
	if status.Truncated {
		t.Fatal("truncation cannot be proven without an expected size")
	}
	if status.ShortLiterals != 1 {
		t.Fatalf("short literal not recorded: %+v", status)
	}
	if message.SectionComplete("1") {
		t.Fatal("unknown-size section must never be complete")
	}
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	status, _ = message.Status("1")
	if !status.Truncated {
		t.Fatal("expected size should make the earlier short literal provably truncated")
	}
}

func TestShortLiteralBeforeKnownLaterDataIsTruncation(t *testing.T) {
	message := NewMessage()
	if err := message.AddBytes("1", 50, []byte("later")); err != nil {
		t.Fatal(err)
	}
	result, err := message.Submit(Segment{
		Section:         "1",
		Origin:          0,
		RequestedLength: 100,
		Data:            []byte("short"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated {
		t.Fatal("short literal with data beyond it should be reported as truncated")
	}
	if !message.Truncated("1") {
		t.Fatal("section should report truncation")
	}
}

func TestCompletionUsesActualLiteralLength(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	// The requested lengths add up to ten, but only nine bytes arrived.
	if err := message.AddPartial("1", 0, 5, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddPartial("1", 5, 5, []byte("fghij")); err != nil {
		t.Fatal(err)
	}
	status, _ := message.Status("1")
	if status.Received != 9 {
		t.Fatalf("received = %d", status.Received)
	}
	if status.Complete {
		t.Fatal("requested lengths must not make the section complete")
	}
	if got := message.Gaps("1"); len(got) != 1 || got[0] != (Range{Start: 4, End: 5}) {
		t.Fatalf("gaps = %v", got)
	}
}

func TestExpectedSizeAfterData(t *testing.T) {
	message := NewMessage()
	if err := message.AddBytes("1", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := message.Expect("1", 6); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 3, []byte("def")); err != nil {
		t.Fatal(err)
	}
	if !message.SectionComplete("1") {
		t.Fatal("section should be complete")
	}
	if err := message.Expect("1", 7); !errors.Is(err, ErrExpectedSizeConflict) {
		t.Fatalf("want expected-size conflict, got %v", err)
	}
}

func TestExpectedSizeCannotShrinkBelowData(t *testing.T) {
	message := NewMessage()
	if err := message.AddBytes("1", 4, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := message.Expect("1", 6); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("want out-of-bounds, got %v", err)
	}
	if _, known := message.ExpectedSize("1"); known {
		t.Fatal("failed expectation must not be installed")
	}
}

func TestOutOfBoundsLiteralFailsMessage(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 4); err != nil {
		t.Fatal(err)
	}
	err := message.AddBytes("1", 2, []byte("cdef"))
	if !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("want out-of-bounds, got %v", err)
	}
	if !message.Failed() {
		t.Fatal("data beyond the declared size must fail the message")
	}
}

func TestLiteralStartingBeyondSectionFailsMessage(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 4); err != nil {
		t.Fatal(err)
	}
	err := message.AddBytes("1", 5, []byte("x"))
	if !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("want out-of-bounds, got %v", err)
	}
	if !message.Failed() {
		t.Fatal("literal beyond the declared size must fail the message")
	}
}

func TestEmptyLiteralBeyondSectionIsNotFatal(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 4); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 5, nil); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("want out-of-bounds, got %v", err)
	}
	if message.Failed() {
		t.Fatal("an empty out-of-range literal carries no data")
	}
}

func TestLiteralLongerThanRequestIsRejected(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	err := message.AddPartial("1", 0, 3, []byte("abcd"))
	if !errors.Is(err, ErrLiteralTooLong) {
		t.Fatalf("want ErrLiteralTooLong, got %v", err)
	}
	if message.Failed() {
		t.Fatal("invalid caller input should not fail the message")
	}
}

func TestZeroLengthSection(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 0); err != nil {
		t.Fatal(err)
	}
	if !message.SectionComplete("1") {
		t.Fatal("zero-length section should be complete")
	}
	got, err := message.SectionBytes("1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d bytes", len(got))
	}
}

func TestSegmentDataIsCopied(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 3); err != nil {
		t.Fatal(err)
	}
	buffer := []byte("abc")
	if err := message.AddBytes("1", 0, buffer); err != nil {
		t.Fatal(err)
	}
	buffer[0] = 'X'
	got, err := message.SectionBytes("1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "abc" {
		t.Fatalf("got %q", got)
	}
	got[0] = 'Y'
	again, _ := message.SectionBytes("1")
	if string(again) != "abc" {
		t.Fatalf("returned bytes alias internal state: %q", again)
	}
}

func TestMissingExpectedSize(t *testing.T) {
	message := NewMessage()
	if err := message.AddBytes("1", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if message.SectionComplete("1") || message.MessageComplete() {
		t.Fatal("unknown-size section must not be complete")
	}
	_, err := message.SectionBytes("1")
	if !errors.Is(err, ErrExpectedSizeUnknown) {
		t.Fatalf("want ErrExpectedSizeUnknown, got %v", err)
	}
}

func TestDifferentSectionsAreIsolated(t *testing.T) {
	message := NewMessage()
	if err := message.ExpectSections(map[Section]int64{"1": 4, "2": 4}); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("2", 0, []byte("wxyz")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 1, []byte("X")); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	if !message.Failed() {
		t.Fatal("message should be failed")
	}
	got, err := message.SectionBytes("2")
	if err != nil {
		t.Fatalf("section 2 should remain readable: %v", err)
	}
	if string(got) != "wxyz" {
		t.Fatalf("got %q", got)
	}
	if _, err := message.Assemble(); !errors.Is(err, ErrMessageFailed) {
		t.Fatalf("Assemble error = %v", err)
	}
}

func TestConcurrentDifferentSections(t *testing.T) {
	message := NewMessage()
	const sections = 8
	const writers = 8
	const chunkSize = 64

	sizes := make(map[Section]int64, sections)
	for i := 0; i < sections; i++ {
		sizes[sectionName(i)] = writers * chunkSize
	}
	if err := message.ExpectSections(sizes); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for section := 0; section < sections; section++ {
		for writer := 0; writer < writers; writer++ {
			wg.Add(1)
			go func(section, writer int) {
				defer wg.Done()
				name := sectionName(section)
				origin := int64(writer * chunkSize)
				data := []byte(strings.Repeat(string(rune('a'+section)), chunkSize))
				if err := message.AddBytes(name, origin, data); err != nil {
					t.Errorf("section %s: %v", name, err)
				}
			}(section, writer)
		}
	}
	wg.Wait()

	if message.Failed() {
		t.Fatalf("unexpected failure: %v", message.Err())
	}
	for i := 0; i < sections; i++ {
		name := sectionName(i)
		if !message.SectionComplete(name) {
			t.Fatalf("section %s incomplete: %+v", name, message.Gaps(name))
		}
		got, err := message.SectionBytes(name)
		if err != nil {
			t.Fatal(err)
		}
		want := strings.Repeat(string(rune('a'+i)), writers*chunkSize)
		if string(got) != want {
			t.Fatalf("section %s content mismatch", name)
		}
	}
	if !message.MessageComplete() {
		t.Fatal("message should be complete")
	}
}

func TestConcurrentIdenticalOverlaps(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 4); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := message.AddBytes("1", 0, []byte("same")); err != nil {
				t.Errorf("add: %v", err)
			}
		}()
	}
	wg.Wait()
	if message.Failed() {
		t.Fatalf("unexpected failure: %v", message.Err())
	}
	status, _ := message.Status("1")
	if !status.Complete || status.Received != 4 {
		t.Fatalf("status = %+v", status)
	}
}

func TestReassembleConvenience(t *testing.T) {
	bodies, err := Reassemble(
		[]Segment{
			{Section: "1", Origin: 3, Data: []byte("def")},
			{Section: "1", Origin: 0, Data: []byte("abc")},
			{Section: "2", Origin: 0, Data: []byte("xy")},
		},
		map[Section]int64{"1": 6, "2": 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(bodies["1"]) != "abcdef" || string(bodies["2"]) != "xy" {
		t.Fatalf("bodies = %q", bodies)
	}
}

func TestReassembleRequiresSizes(t *testing.T) {
	_, err := Reassemble([]Segment{{Section: "1", Origin: 0, Data: []byte("abc")}})
	if !errors.Is(err, ErrIncomplete) || !errors.Is(err, ErrExpectedSizeUnknown) {
		t.Fatalf("want incomplete/unknown size, got %v", err)
	}
}

func TestInvalidOrigin(t *testing.T) {
	message := NewMessage()
	if err := message.AddBytes("1", -1, []byte("x")); !errors.Is(err, ErrInvalidSegment) {
		t.Fatalf("want ErrInvalidSegment, got %v", err)
	}
	if message.Failed() {
		t.Fatal("invalid caller input should not fail the message")
	}
}

func TestSectionStringIsVerbatim(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("HEADER.FIELDS (From To)", 3); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("HEADER.FIELDS (From To)", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if got := message.Sections(); len(got) != 1 || got[0] != "HEADER.FIELDS (From To)" {
		t.Fatalf("sections = %v", got)
	}
}

func sectionName(i int) Section {
	return Section([]byte{byte('1' + i)})
}
