package dataeng_test

import (
	"bytes"
	"errors"
	"math/rand"
	"testing"
	"time"

	"example.org/dataeng13/q0034"
)

// The helpers below are an independent bit model. They build the expected
// payload directly from source six-bit values and never call the package to
// compute an expected bit stream.

func refValueBits(values ...byte) []byte {
	bits := make([]byte, 0, len(values)*6)
	for _, value := range values {
		for shift := 5; shift >= 0; shift-- {
			bits = append(bits, (value>>uint(shift))&1)
		}
	}
	return bits
}

func refRandomBits(rng *rand.Rand, n int) []byte {
	bits := make([]byte, n)
	for i := range bits {
		bits[i] = byte(rng.Intn(2))
	}
	return bits
}

func refConcat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func refSplit(bits []byte, sizes []int) [][]byte {
	if len(bits) != sum(sizes) {
		panic("refSplit: sizes do not cover bits")
	}
	out := make([][]byte, 0, len(sizes))
	offset := 0
	for _, size := range sizes {
		out = append(out, append([]byte(nil), bits[offset:offset+size]...))
		offset += size
	}
	return out
}

func refSplitRandom(rng *rand.Rand, bits []byte, total, minLast int) [][]byte {
	out := make([][]byte, total)
	offset := 0
	for i := 0; i < total; i++ {
		remaining := len(bits) - offset
		size := remaining
		if i < total-1 {
			max := remaining - minLast
			if max < 0 {
				max = 0
			}
			size = rng.Intn(max + 1)
		}
		out[i] = append([]byte(nil), bits[offset:offset+size]...)
		offset += size
	}
	return out
}

func sum(values []int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func refSentence(id string, total, number, fillBits int, bits []byte) dataeng.Sentence {
	return dataeng.Sentence{
		MessageID: id,
		Total:     total,
		Number:    number,
		FillBits:  fillBits,
		Bits:      bits,
	}
}

func refFeed(t *testing.T, assembler *dataeng.Assembler, sentences []dataeng.Sentence, order []int, now time.Time) []dataeng.Result {
	t.Helper()
	results := make([]dataeng.Result, 0, len(order))
	for _, position := range order {
		results = append(results, assembler.Add(sentences[position], now))
	}
	return results
}

func TestOutOfOrderAssembly(t *testing.T) {
	expected := refValueBits(0x05, 0x3f, 0x12, 0x21, 0x07, 0x2a)
	chunks := refSplit(expected, []int{11, 13, 12})
	assembler := dataeng.NewAssembler(time.Minute)

	sentences := make([]dataeng.Sentence, len(chunks))
	for i, chunk := range chunks {
		sentences[i] = refSentence("out-of-order", 3, i+1, 0, chunk)
	}

	results := refFeed(t, assembler, sentences, []int{1, 2, 0}, time.Unix(10, 0))
	if results[0].Status != dataeng.StatusAccepted || results[1].Status != dataeng.StatusAccepted {
		t.Fatalf("first two fragments should be accepted, got %v and %v", results[0].Status, results[1].Status)
	}
	completed := results[2]
	if completed.Status != dataeng.StatusComplete {
		t.Fatalf("last fragment status = %v, err = %v", completed.Status, completed.Err)
	}
	if completed.Message == nil {
		t.Fatal("completion did not include a message")
	}
	if !bytes.Equal(completed.Message.Bits, expected) {
		t.Fatalf("assembled bits = %v, want independent model %v", completed.Message.Bits, expected)
	}
}

func TestFillBitsRemovedOnlyFromLastSentence(t *testing.T) {
	data := refValueBits(0x0f, 0x33, 0x15)
	padding := []byte{1, 1, 0, 1}
	padded := refConcat(data, padding)
	chunks := refSplit(padded, []int{7, 8, 7})
	assembler := dataeng.NewAssembler(time.Minute)

	sentences := []dataeng.Sentence{
		refSentence("padded", 3, 1, 0, chunks[0]),
		refSentence("padded", 3, 2, 0, chunks[1]),
		refSentence("padded", 3, 3, len(padding), chunks[2]),
	}
	results := refFeed(t, assembler, sentences, []int{1, 0, 2}, time.Unix(20, 0))
	completed := results[len(results)-1]
	if completed.Status != dataeng.StatusComplete {
		t.Fatalf("status = %v, err = %v", completed.Status, completed.Err)
	}
	if !bytes.Equal(completed.Message.Bits, data) {
		t.Fatalf("fill bits were not removed correctly: got %v, want %v", completed.Message.Bits, data)
	}
}

func TestFillBitsRejectedBeforeLastSentence(t *testing.T) {
	data := refValueBits(0x11, 0x22)
	padding := []byte{1, 0}
	padded := refConcat(data, padding)
	chunks := refSplit(padded, []int{7, 7})
	assembler := dataeng.NewAssembler(time.Minute)

	badFirst := refSentence("bad-fill-position", 2, 1, len(padding), chunks[0])
	result := assembler.Add(badFirst, time.Unix(30, 0))
	if result.Status != dataeng.StatusFailed {
		t.Fatalf("status = %v, want failure", result.Status)
	}
	if !errors.Is(result.Err, dataeng.ErrFillBitsNotLast) {
		t.Fatalf("error = %v, want ErrFillBitsNotLast", result.Err)
	}

	last := refSentence("bad-fill-position", 2, 2, 0, chunks[1])
	if result := assembler.Add(last, time.Unix(30, 0)); result.Status != dataeng.StatusFailed {
		t.Fatalf("fragment after failure status = %v, want failure", result.Status)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("invalid sentence left pending state: %+v", assembler.Pending())
	}
}

func TestFillRemovalMustLeaveMultipleOfSixBits(t *testing.T) {
	// 20 data bits plus four padding bits is 24 raw bits. A package that
	// checked raw length would wrongly accept this message.
	data := refRandomBits(rand.New(rand.NewSource(4)), 20)
	padding := []byte{0, 1, 1, 0}
	padded := refConcat(data, padding)
	chunks := refSplit(padded, []int{11, 13})
	assembler := dataeng.NewAssembler(time.Minute)

	sentences := []dataeng.Sentence{
		refSentence("not-multiple", 2, 1, 0, chunks[0]),
		refSentence("not-multiple", 2, 2, len(padding), chunks[1]),
	}
	results := refFeed(t, assembler, sentences, []int{0, 1}, time.Unix(40, 0))
	last := results[1]
	if last.Status != dataeng.StatusFailed {
		t.Fatalf("status = %v, want failure", last.Status)
	}
	if !errors.Is(last.Err, dataeng.ErrBitCountNotMultipleOfSix) {
		t.Fatalf("error = %v, want ErrBitCountNotMultipleOfSix", last.Err)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("failed message is still pending")
	}
}

func TestTotalSentenceCountMustAgree(t *testing.T) {
	bits := refValueBits(0x01, 0x02)
	assembler := dataeng.NewAssembler(time.Minute)

	first := refSentence("total", 2, 1, 0, bits[:6])
	if result := assembler.Add(first, time.Unix(50, 0)); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first fragment status = %v", result.Status)
	}

	conflicting := refSentence("total", 3, 2, 0, bits[6:])
	result := assembler.Add(conflicting, time.Unix(50, 0))
	if result.Status != dataeng.StatusFailed {
		t.Fatalf("status = %v, want failure", result.Status)
	}
	if !errors.Is(result.Err, dataeng.ErrInconsistentTotal) {
		t.Fatalf("error = %v, want ErrInconsistentTotal", result.Err)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("message was not failed after total mismatch")
	}

	third := refSentence("total", 3, 3, 0, []byte{0, 1, 1, 0, 1, 0})
	if result := assembler.Add(third, time.Unix(50, 0)); !errors.Is(result.Err, dataeng.ErrMessageFailed) {
		t.Fatalf("late fragment error = %v, want ErrMessageFailed", result.Err)
	}
}

func TestDuplicateSentenceFailsMessage(t *testing.T) {
	bits := refValueBits(0x01, 0x02, 0x03)
	assembler := dataeng.NewAssembler(time.Minute)

	first := refSentence("duplicate", 3, 1, 0, bits[:6])
	if result := assembler.Add(first, time.Unix(60, 0)); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first fragment status = %v", result.Status)
	}
	result := assembler.Add(first, time.Unix(60, 0))
	if result.Status != dataeng.StatusFailed {
		t.Fatalf("duplicate status = %v, want failure", result.Status)
	}
	if !errors.Is(result.Err, dataeng.ErrDuplicateNumber) {
		t.Fatalf("error = %v, want ErrDuplicateNumber", result.Err)
	}
}

func TestMissingSentencesExpireOnCallerClock(t *testing.T) {
	const timeout = 100 * time.Millisecond
	start := time.Unix(70, 0)
	assembler := dataeng.NewAssembler(timeout)

	first := refSentence("slow", 3, 1, 0, refValueBits(0x3c)[:6])
	if result := assembler.Add(first, start); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first fragment status = %v", result.Status)
	}

	pending := assembler.Pending()
	if len(pending) != 1 || pending[0].Total != 3 || !equalInts(pending[0].Missing, []int{2, 3}) {
		t.Fatalf("pending snapshot = %+v", pending)
	}

	if expired := assembler.Expire(start.Add(timeout - time.Nanosecond)); len(expired) != 0 {
		t.Fatalf("expired before deadline: %+v", expired)
	}
	expired := assembler.Expire(start.Add(timeout))
	if len(expired) != 1 {
		t.Fatalf("expired results = %+v, want one", expired)
	}
	if expired[0].Status != dataeng.StatusExpired || !errors.Is(expired[0].Err, dataeng.ErrMessageExpired) {
		t.Fatalf("expiry result = %+v", expired[0])
	}
	if !equalInts(expired[0].Missing, []int{2, 3}) {
		t.Fatalf("missing = %v, want [2 3]", expired[0].Missing)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("expired message remains pending")
	}

	// A fragment arriving after expiry starts a fresh message rather than
	// reviving the expired one.
	late := start.Add(timeout + time.Second)
	second := refSentence("slow", 3, 2, 0, []byte{1, 0, 1, 1, 0, 0})
	if result := assembler.Add(second, late); result.Status != dataeng.StatusAccepted {
		t.Fatalf("late fragment status = %v", result.Status)
	}
	third := refSentence("slow", 3, 3, 0, []byte{0, 1, 1, 0, 1, 0})
	if result := assembler.Add(third, late); result.Status != dataeng.StatusAccepted {
		t.Fatalf("late third fragment status = %v", result.Status)
	}
	if expired := assembler.Expire(late.Add(timeout)); len(expired) != 1 || !equalInts(expired[0].Missing, []int{1}) {
		t.Fatalf("second expiry = %+v, want missing sentence 1", expired)
	}
}

func TestAssemblerUsesInjectedClock(t *testing.T) {
	current := time.Unix(80, 0)
	assembler := dataeng.NewAssembler(time.Second, func() time.Time { return current })

	first := refSentence("injected-clock", 2, 1, 0, []byte{1, 1, 0, 0, 1, 0})
	if result := assembler.Add(first); result.Status != dataeng.StatusAccepted {
		t.Fatalf("status = %v", result.Status)
	}
	if expired := assembler.Expire(); len(expired) != 0 {
		t.Fatalf("expired too early: %+v", expired)
	}
	current = current.Add(time.Second)
	expired := assembler.Expire()
	if len(expired) != 1 || !equalInts(expired[0].Missing, []int{2}) {
		t.Fatalf("injected clock expiry = %+v", expired)
	}
}

func TestNonPositiveTimeoutDisablesExpiry(t *testing.T) {
	for _, timeout := range []time.Duration{0, -time.Second} {
		assembler := dataeng.NewAssembler(timeout)
		first := refSentence("never", 2, 1, 0, []byte{0, 1})
		if result := assembler.Add(first, time.Unix(90, 0)); result.Status != dataeng.StatusAccepted {
			t.Fatalf("timeout %v: status = %v", timeout, result.Status)
		}
		if expired := assembler.Expire(time.Unix(91, 0).Add(100000 * time.Hour)); len(expired) != 0 {
			t.Fatalf("timeout %v: unexpected expiry %+v", timeout, expired)
		}
		if len(assembler.Pending()) != 1 {
			t.Fatalf("timeout %v: message disappeared", timeout)
		}
	}
}

func TestFailureTombstoneExpiresAndIDCanBeReused(t *testing.T) {
	const timeout = time.Second
	start := time.Unix(95, 0)
	assembler := dataeng.NewAssembler(timeout)
	data := refValueBits(0x09, 0x31)
	chunks := refSplit(data, []int{6, 6})

	first := refSentence("reuse", 2, 1, 0, chunks[0])
	if result := assembler.Add(first, start); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first fragment status = %v", result.Status)
	}
	bad := refSentence("reuse", 2, 2, 0, []byte{1, 2})
	if result := assembler.Add(bad, start); result.Status != dataeng.StatusFailed {
		t.Fatalf("bad fragment status = %v", result.Status)
	}
	if result := assembler.Add(first, start.Add(timeout/2)); !errors.Is(result.Err, dataeng.ErrMessageFailed) {
		t.Fatalf("tombstone was released too early: %v", result.Err)
	}

	fresh := start.Add(timeout)
	if result := assembler.Add(first, fresh); result.Status != dataeng.StatusAccepted {
		t.Fatalf("fresh fragment status = %v, err = %v", result.Status, result.Err)
	}
	last := refSentence("reuse", 2, 2, 0, chunks[1])
	result := assembler.Add(last, fresh)
	if result.Status != dataeng.StatusComplete || !bytes.Equal(result.Message.Bits, data) {
		t.Fatalf("reused message = %+v, want bits %v", result, data)
	}
}

func TestFeedAliasResetAndBitString(t *testing.T) {
	data := refValueBits(0x2d, 0x07)
	assembler := dataeng.New(time.Minute)
	result := assembler.Feed(refSentence("alias", 1, 1, 0, data), time.Unix(96, 0))
	if result.Status != dataeng.StatusComplete {
		t.Fatalf("Feed status = %v, err = %v", result.Status, result.Err)
	}
	expectedText := "101101000111"
	if got := result.Message.BitString(); got != expectedText {
		t.Fatalf("BitString = %q, want %q", got, expectedText)
	}

	assembler.Feed(refSentence("pending", 2, 1, 0, []byte{0, 1, 0, 1}), time.Unix(96, 0))
	if len(assembler.Pending()) != 1 {
		t.Fatalf("expected one pending message")
	}
	assembler.Reset()
	if len(assembler.Pending()) != 0 {
		t.Fatalf("Reset left pending state")
	}
}

func TestInvalidSentenceFailsOwningMessage(t *testing.T) {
	data := refValueBits(0x24, 0x13, 0x2f)
	chunks := refSplit(data, []int{6, 6, 6})
	assembler := dataeng.NewAssembler(time.Minute)

	sentences := []dataeng.Sentence{
		refSentence("invalid", 3, 1, 0, chunks[0]),
		refSentence("invalid", 3, 2, 0, chunks[1]),
		refSentence("invalid", 3, 3, 0, chunks[2]),
	}
	if result := assembler.Add(sentences[0], time.Unix(100, 0)); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first fragment status = %v", result.Status)
	}

	bad := refSentence("invalid", 3, 2, 0, []byte{0, 2})
	result := assembler.Add(bad, time.Unix(100, 0))
	if result.Status != dataeng.StatusFailed || !errors.Is(result.Err, dataeng.ErrNonBitPayload) {
		t.Fatalf("bad fragment result = %+v", result)
	}
	if len(assembler.Pending()) != 0 {
		t.Fatalf("bad fragment did not fail the message")
	}

	// A valid replacement for the discarded sentence must not rescue the
	// message after a validation failure.
	if result := assembler.Add(sentences[1], time.Unix(100, 0)); !errors.Is(result.Err, dataeng.ErrMessageFailed) {
		t.Fatalf("replacement error = %v, want ErrMessageFailed", result.Err)
	}
	if result := assembler.Add(sentences[2], time.Unix(100, 0)); !errors.Is(result.Err, dataeng.ErrMessageFailed) {
		t.Fatalf("last fragment error = %v, want ErrMessageFailed", result.Err)
	}

	assembler.Forget("invalid")
	if result := assembler.Add(sentences[0], time.Unix(101, 0)); result.Status != dataeng.StatusAccepted {
		t.Fatalf("fresh first fragment status = %v", result.Status)
	}
	results := make([]dataeng.Result, 0, 2)
	results = append(results, assembler.Add(sentences[1], time.Unix(101, 0)))
	results = append(results, assembler.Add(sentences[2], time.Unix(101, 0)))
	if results[1].Status != dataeng.StatusComplete || !bytes.Equal(results[1].Message.Bits, data) {
		t.Fatalf("fresh message = %+v, want bits %v", results[1], data)
	}
}

func TestValidationRejectsMalformedSentences(t *testing.T) {
	writeErr := errors.New("external checksum failure")
	tests := []struct {
		name     string
		sentence dataeng.Sentence
		want     error
	}{
		{
			name:     "external validation",
			sentence: dataeng.Sentence{MessageID: "v", Total: 1, Number: 1, Err: writeErr},
			want:     dataeng.ErrInvalidSentence,
		},
		{
			name:     "zero total",
			sentence: dataeng.Sentence{MessageID: "v", Total: 0, Number: 1},
			want:     dataeng.ErrInvalidSentence,
		},
		{
			name:     "zero number",
			sentence: dataeng.Sentence{MessageID: "v", Total: 1, Number: 0},
			want:     dataeng.ErrInvalidSentence,
		},
		{
			name:     "number past total",
			sentence: dataeng.Sentence{MessageID: "v", Total: 2, Number: 3},
			want:     dataeng.ErrInvalidSentence,
		},
		{
			name:     "negative fill",
			sentence: dataeng.Sentence{MessageID: "v", Total: 1, Number: 1, FillBits: -1},
			want:     dataeng.ErrInvalidSentence,
		},
		{
			name:     "fill on non-final",
			sentence: dataeng.Sentence{MessageID: "v", Total: 2, Number: 1, FillBits: 1, Bits: []byte{0}},
			want:     dataeng.ErrFillBitsNotLast,
		},
		{
			name:     "fill exceeds payload",
			sentence: dataeng.Sentence{MessageID: "v", Total: 1, Number: 1, FillBits: 3, Bits: []byte{0, 1}},
			want:     dataeng.ErrFillExceedsPayload,
		},
		{
			name:     "non-bit payload",
			sentence: dataeng.Sentence{MessageID: "v", Total: 1, Number: 1, Bits: []byte{0, 2}},
			want:     dataeng.ErrNonBitPayload,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assembler := dataeng.NewAssembler(time.Minute)
			result := assembler.Add(test.sentence, time.Unix(110, 0))
			if result.Status != dataeng.StatusFailed {
				t.Fatalf("status = %v, want failure", result.Status)
			}
			if !errors.Is(result.Err, test.want) {
				t.Fatalf("error = %v, want %v", result.Err, test.want)
			}
			if len(assembler.Pending()) != 0 {
				t.Fatalf("invalid fragment left pending state")
			}
		})
	}
}

func TestPayloadBitsAreCopied(t *testing.T) {
	firstBits := []byte{0, 1, 1, 0, 1, 0}
	secondBits := []byte{1, 0, 0, 1, 1, 0}
	expected := refConcat(firstBits, secondBits)
	assembler := dataeng.NewAssembler(time.Minute)

	first := refSentence("copy", 2, 1, 0, firstBits)
	second := refSentence("copy", 2, 2, 0, secondBits)
	if result := assembler.Add(first, time.Unix(120, 0)); result.Status != dataeng.StatusAccepted {
		t.Fatalf("first status = %v", result.Status)
	}
	firstBits[0] = 1
	firstBits[1] = 0
	result := assembler.Add(second, time.Unix(120, 0))
	if result.Status != dataeng.StatusComplete || !bytes.Equal(result.Message.Bits, expected) {
		t.Fatalf("completion = %+v, want copied bits %v", result, expected)
	}
}

func TestRandomizedIndependentBitModel(t *testing.T) {
	rng := rand.New(rand.NewSource(13))
	for iteration := 0; iteration < 300; iteration++ {
		total := rng.Intn(5) + 1
		symbolCount := rng.Intn(20) + 1
		values := make([]byte, symbolCount)
		for i := range values {
			values[i] = byte(rng.Intn(64))
		}
		data := refValueBits(values...)

		padLen := rng.Intn(5)
		padding := refRandomBits(rng, padLen)
		padded := refConcat(data, padding)
		chunks := refSplitRandom(rng, padded, total, padLen)

		sentences := make([]dataeng.Sentence, total)
		for i := 0; i < total; i++ {
			fillBits := 0
			if i == total-1 {
				fillBits = padLen
			}
			sentences[i] = refSentence("random", total, i+1, fillBits, chunks[i])
		}

		order := rng.Perm(total)
		assembler := dataeng.NewAssembler(0)
		now := time.Unix(int64(200+iteration), 0)
		var completed *dataeng.Result
		for position, index := range order {
			result := assembler.Add(sentences[index], now)
			if position < total-1 {
				if result.Status != dataeng.StatusAccepted {
					t.Fatalf("iteration %d: fragment %d status = %v, err = %v (before completion)",
						iteration, index+1, result.Status, result.Err)
				}
				continue
			}
			completed = &result
		}
		if completed == nil || completed.Status != dataeng.StatusComplete {
			t.Fatalf("iteration %d: no completion, result = %+v", iteration, completed)
		}
		if !bytes.Equal(completed.Message.Bits, data) {
			t.Fatalf("iteration %d: bits = %v, want independent model %v",
				iteration, completed.Message.Bits, data)
		}
		if len(assembler.Pending()) != 0 {
			t.Fatalf("iteration %d: completed message still pending", iteration)
		}
	}
}

func equalInts(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
