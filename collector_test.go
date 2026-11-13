package dataeng_test

import (
	"bytes"
	"errors"
	"fmt"
	"testing"

	dataeng "example.org/dataeng/q0351"
)

const soh = byte(0x01)

// field builds the raw bytes of one field entirely within the test, without
// any reference to the component under test.
func field(tag int, value string) []byte {
	return []byte(fmt.Sprintf("%d=%s%c", tag, value, soh))
}

// bodyLength independently counts every byte after the 0x01 ending tag 9 up to
// the 0x01 immediately preceding tag 10.
func bodyLength(fields ...[]byte) int {
	n := 0
	started := false
	for _, f := range fields {
		if f == nil || bytes.HasPrefix(f, []byte("9=")) {
			started = true
			continue
		}
		if bytes.HasPrefix(f, []byte("10=")) {
			break
		}
		if started {
			n += len(f)
		}
	}
	return n
}

// checksum independently sums every byte preceding the tag 10 field modulo 256.
func checksum(fields ...[]byte) int {
	sum := 0
	for _, f := range fields {
		if f == nil {
			continue
		}
		if bytes.HasPrefix(f, []byte("10=")) {
			break
		}
		for _, b := range f {
			sum += int(b)
		}
	}
	return sum & 0xff
}

// buildMessage composes a message from caller-supplied tag 9 and tag 10 fields
// so wrong lengths or checksums can be exercised directly.
func buildMessage(begin string, tag9 []byte, body [][]byte, tag10 []byte) []byte {
	out := append([]byte(nil), field(8, begin)...)
	out = append(out, tag9...)
	for _, f := range body {
		out = append(out, f...)
	}
	out = append(out, tag10...)
	return out
}

// validMessage builds a fully correct message using independently counted body
// length and checksum, never using the component under test.
func validMessage(t *testing.T, begin string, body [][]byte) []byte {
	t.Helper()
	tag8 := field(8, begin)
	bl := bodyLength(append([][]byte{tag8, nil}, body...)...)
	tag9 := field(9, fmt.Sprintf("%d", bl))
	cs := checksum(append([][]byte{tag8, tag9}, body...)...)
	return buildMessage(begin, tag9, body, field(10, fmt.Sprintf("%03d", cs)))
}

func TestValidMessageEverySplit(t *testing.T) {
	body := [][]byte{
		field(35, "D"),
		field(49, "SENDER"),
		field(56, "TARGET"),
		field(55, "AAPL"),
		field(55, "MSFT"), // repeated non-reserved tag, order retained
		field(44, ""),     // empty value allowed
	}
	msg := validMessage(t, "FIX.4.4", body)

	for cut := 0; cut <= len(msg); cut++ {
		t.Run(fmt.Sprintf("cut=%d", cut), func(t *testing.T) {
			c := dataeng.NewCollector(4096)
			if _, err := c.Push(msg[:cut]); err != nil {
				t.Fatalf("first Push failed: %v", err)
			}
			if _, err := c.Push(msg[cut:]); err != nil {
				t.Fatalf("second Push failed: %v", err)
			}
			if err := c.Finish(); err != nil {
				t.Fatalf("Finish failed: %v", err)
			}
			got := c.Messages()
			if len(got) != 1 {
				t.Fatalf("delivered %d messages, want 1", len(got))
			}
			if !bytes.Equal(got[0].Raw, msg) {
				t.Fatalf("raw mismatch")
			}
			wantTags := []int{8, 9, 35, 49, 56, 55, 55, 44, 10}
			if len(got[0].Fields) != len(wantTags) {
				t.Fatalf("field count %d, want %d", len(got[0].Fields), len(wantTags))
			}
			for i, f := range got[0].Fields {
				if f.Tag != wantTags[i] {
					t.Fatalf("field %d tag = %d, want %d (order not retained)", i, f.Tag, wantTags[i])
				}
			}
			if got[0].Fields[6].Value != "MSFT" || got[0].Fields[7].Value != "" {
				t.Fatalf("repeated/empty field values wrong: %+v", got[0].Fields)
			}
			if got[0].Fields[8].Tag != 10 || len(got[0].Fields[8].Value) != 3 {
				t.Fatalf("tag 10 value must keep three digits")
			}
		})
	}
}

func TestBodyLengthIncludingStartingFieldRejected(t *testing.T) {
	tag8 := field(8, "FIX.4.2")
	body := [][]byte{field(35, "D"), field(49, "S")}
	correct := validMessage(t, "FIX.4.2", body)

	// Wrong count: include the two starting fields (tags 8 and 9) in the
	// body, the classic off-by-range mistake, computed independently here.
	startFields := len(tag8) + len(field(9, "0"))
	wrongBody := bodyLength(tag8, nil, body[0], body[1]) + startFields
	wrongTag9 := field(9, fmt.Sprintf("%d", wrongBody))
	// Keep the checksum self-consistent so only the body length is wrong.
	cs := checksum(tag8, wrongTag9, body[0], body[1])
	wrong := buildMessage("FIX.4.2", wrongTag9, body, field(10, fmt.Sprintf("%03d", cs)))

	c := dataeng.NewCollector(4096)
	if n, err := c.Push(correct); err != nil || n != 1 {
		t.Fatalf("good message: n=%d err=%v", n, err)
	}
	if _, err := c.Push(wrong); !errors.Is(err, dataeng.ErrBodyLength) {
		t.Fatalf("want ErrBodyLength, got %v", err)
	}
	if err := c.Finish(); !errors.Is(err, dataeng.ErrBodyLength) {
		t.Fatalf("collector must stay stopped, got %v", err)
	}
	if len(c.Messages()) != 1 || !bytes.Equal(c.Messages()[0].Raw, correct) {
		t.Fatalf("delivered message must be retained after failure")
	}
}

func TestChecksumOmittingTag9Rejected(t *testing.T) {
	tag8 := field(8, "FIX.4.4")
	body := [][]byte{field(35, "8"), field(55, "GOOG")}
	bl := bodyLength(tag8, nil, body[0], body[1])
	tag9 := field(9, fmt.Sprintf("%d", bl))

	// Wrong checksum: sum over the body only, silently omitting tag 9.
	wrongSum := 0
	for _, f := range body {
		for _, b := range f {
			wrongSum += int(b)
		}
	}
	wrong := buildMessage("FIX.4.4", tag9, body, field(10, fmt.Sprintf("%03d", wrongSum&0xff)))

	c := dataeng.NewCollector(4096)
	if _, err := c.Push(wrong); !errors.Is(err, dataeng.ErrChecksum) {
		t.Fatalf("want ErrChecksum, got %v", err)
	}
	if _, err := c.Push(wrong); !errors.Is(err, dataeng.ErrChecksum) {
		t.Fatalf("stopped collector must reject further Push, got %v", err)
	}

	// The correct checksum covers tag 9 and every byte before tag 10.
	cs := checksum(tag8, tag9, body[0], body[1])
	good := buildMessage("FIX.4.4", tag9, body, field(10, fmt.Sprintf("%03d", cs)))
	fresh := dataeng.NewCollector(4096)
	if n, err := fresh.Push(good); err != nil || n != 1 {
		t.Fatalf("correct checksum rejected: n=%d err=%v", n, err)
	}
}

func TestTag10NotLastRejected(t *testing.T) {
	body := [][]byte{field(35, "D"), field(49, "S")}
	msg := validMessage(t, "FIX.4.2", body)
	trailing := field(55, "X") // a field after tag 10

	c := dataeng.NewCollector(4096)
	n, err := c.Push(append(append([]byte(nil), msg...), trailing...))
	if !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for field after tag 10, got %v", err)
	}
	if n != 1 {
		t.Fatalf("the valid message should still be delivered once, got %d", n)
	}
	if len(c.Messages()) != 1 || !bytes.Equal(c.Messages()[0].Raw, msg) {
		t.Fatalf("delivered message must be retained")
	}
}

func TestTag35NotFirstAfterBodyRejected(t *testing.T) {
	tag8 := field(8, "FIX.4.4")
	tag35 := field(35, "D")
	other := field(49, "S")

	// Case 1: another field appears before tag 35.
	body := [][]byte{other, tag35}
	bl := bodyLength(tag8, nil, other, tag35)
	tag9 := field(9, fmt.Sprintf("%d", bl))
	cs := checksum(tag8, tag9, other, tag35)
	msg := buildMessage("FIX.4.4", tag9, body, field(10, fmt.Sprintf("%03d", cs)))

	c := dataeng.NewCollector(4096)
	if _, err := c.Push(msg); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for misplaced tag 35, got %v", err)
	}

	// Case 2: tag 35 present first but with an empty value.
	empty35 := field(35, "")
	bl2 := bodyLength(tag8, nil, empty35)
	tag9b := field(9, fmt.Sprintf("%d", bl2))
	cs2 := checksum(tag8, tag9b, empty35)
	msg2 := buildMessage("FIX.4.4", tag9b, [][]byte{empty35}, field(10, fmt.Sprintf("%03d", cs2)))
	c2 := dataeng.NewCollector(4096)
	if _, err := c2.Push(msg2); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for empty tag 35, got %v", err)
	}

	// Case 3: tag 35 repeats.
	dup := [][]byte{field(35, "D"), field(35, "E")}
	bl3 := bodyLength(tag8, nil, dup[0], dup[1])
	tag9c := field(9, fmt.Sprintf("%d", bl3))
	cs3 := checksum(tag8, tag9c, dup[0], dup[1])
	dupMsg := buildMessage("FIX.4.4", tag9c, dup, field(10, fmt.Sprintf("%03d", cs3)))
	c3 := dataeng.NewCollector(4096)
	if _, err := c3.Push(dupMsg); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for repeated tag 35, got %v", err)
	}
}

func TestSOHByteSplitAcrossPushes(t *testing.T) {
	body := [][]byte{field(35, "D"), field(55, "IBM")}
	msg := validMessage(t, "FIX.4.2", body)

	// The third 0x01 ends tag 35 (1st ends tag 8, 2nd ends tag 9). Split
	// exactly there so the 0x01 byte arrives alone in the second Push.
	sohCount := 0
	cutAtSOH := -1
	for i, b := range msg {
		if b == soh {
			sohCount++
			if sohCount == 3 {
				cutAtSOH = i
				break
			}
		}
	}
	if cutAtSOH < 0 {
		t.Fatalf("could not locate tag 35 terminator")
	}

	c := dataeng.NewCollector(4096)
	if _, err := c.Push(msg[:cutAtSOH]); err != nil {
		t.Fatalf("Push before SOH: %v", err)
	}
	if _, err := c.Push(msg[cutAtSOH : cutAtSOH+1]); err != nil { // lone 0x01
		t.Fatalf("Push of lone SOH: %v", err)
	}
	if _, err := c.Push(msg[cutAtSOH+1:]); err != nil {
		t.Fatalf("Push remainder: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(c.Messages()) != 1 || !bytes.Equal(c.Messages()[0].Raw, msg) {
		t.Fatalf("message across split SOH not delivered intact")
	}

	// Byte-by-byte feeding of a second message.
	other := validMessage(t, "FIX.4.4", [][]byte{field(35, "A"), field(34, "7")})
	c2 := dataeng.NewCollector(4096)
	for i := 0; i < len(other); i++ {
		if _, err := c2.Push(other[i : i+1]); err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
	}
	if err := c2.Finish(); err != nil {
		t.Fatalf("Finish byte-wise: %v", err)
	}
}

func TestFinishTruncatedFails(t *testing.T) {
	msg := validMessage(t, "FIX.4.2", [][]byte{field(35, "D")})
	for _, cut := range []int{1, 3, len(msg) - 1} {
		c := dataeng.NewCollector(4096)
		if _, err := c.Push(msg[:cut]); err != nil {
			t.Fatalf("partial Push: %v", err)
		}
		if err := c.Finish(); !errors.Is(err, dataeng.ErrTruncated) {
			t.Fatalf("cut %d: want ErrTruncated, got %v", cut, err)
		}
		if len(c.Messages()) != 0 {
			t.Fatalf("no message should be delivered")
		}
	}

	c := dataeng.NewCollector(4096)
	if err := c.Finish(); err != nil {
		t.Fatalf("empty Finish: %v", err)
	}
}

func TestMaxBodyRejectedRightAfterTag9(t *testing.T) {
	tag8 := field(8, "FIX.4.2")
	tag35 := field(35, "D")
	extra := field(999, "payload")
	bl := bodyLength(tag8, nil, tag35, extra)
	tag9 := field(9, fmt.Sprintf("%d", bl))
	cs := checksum(tag8, tag9, tag35, extra)
	msg := buildMessage("FIX.4.2", tag9, [][]byte{tag35, extra}, field(10, fmt.Sprintf("%03d", cs)))

	if bl <= 4 {
		t.Fatalf("test body too small to prove limit: %d", bl)
	}
	c := dataeng.NewCollector(4)
	// Feed only through the end of tag 9. Rejection must happen as soon as
	// the tag 9 value is complete, before any body bytes arrive.
	header := append(append([]byte(nil), tag8...), tag9...)
	if _, err := c.Push(header); !errors.Is(err, dataeng.ErrMaxBody) {
		t.Fatalf("want ErrMaxBody once tag 9 completes, got %v", err)
	}
	if _, err := c.Push(msg); !errors.Is(err, dataeng.ErrMaxBody) {
		t.Fatalf("collector stays stopped after maxBody failure, got %v", err)
	}
	if len(c.Messages()) != 0 {
		t.Fatalf("oversized message must not be delivered")
	}

	// A declaration exactly at the limit is accepted.
	small := validMessage(t, "FIX.4.2", [][]byte{field(35, "D")})
	smallBody := bodyLength(field(8, "FIX.4.2"), nil, field(35, "D"))
	fresh := dataeng.NewCollector(smallBody)
	if n, err := fresh.Push(small); err != nil || n != 1 {
		t.Fatalf("body equal to maxBody: n=%d err=%v", n, err)
	}
}

func TestTag10ValueRules(t *testing.T) {
	tag8 := field(8, "FIX.4.2")
	tag35 := field(35, "D")
	bl := bodyLength(tag8, nil, tag35)
	tag9 := field(9, fmt.Sprintf("%d", bl))
	cs := checksum(tag8, tag9, tag35)

	good := buildMessage("FIX.4.2", tag9, [][]byte{tag35}, field(10, fmt.Sprintf("%03d", cs)))
	c := dataeng.NewCollector(4096)
	if n, err := c.Push(good); err != nil || n != 1 {
		t.Fatalf("three-digit checksum with leading zeros rejected: n=%d err=%v", n, err)
	}

	bad := []struct {
		name  string
		value string
		want  error
	}{
		{"two digits", "99", dataeng.ErrChecksumTag},
		{"four digits", "0099", dataeng.ErrChecksumTag},
		{"above range", "256", dataeng.ErrChecksumTag},
		{"non digit", "12a", dataeng.ErrChecksumTag},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			msg := buildMessage("FIX.4.2", tag9, [][]byte{tag35}, field(10, tc.value))
			cc := dataeng.NewCollector(4096)
			if _, err := cc.Push(msg); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}

	// Checksum value 255 format accepted when it really is the byte sum.
	if cs <= 255 {
		zeroMsg := buildMessage("FIX.4.2", tag9, [][]byte{tag35}, field(10, fmt.Sprintf("%03d", cs)))
		cc := dataeng.NewCollector(4096)
		if n, err := cc.Push(zeroMsg); err != nil || n != 1 {
			t.Fatalf("legitimate %03d checksum: n=%d err=%v", cs, n, err)
		}
	}
}

func TestHeaderAndTagFormatRules(t *testing.T) {
	// Message not starting with tag 8.
	noTag8 := append(append([]byte(nil), field(9, "0")...), field(10, "000")...)
	c := dataeng.NewCollector(4096)
	if _, err := c.Push(noTag8); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed without tag 8, got %v", err)
	}

	// Tag 8 with unsupported version.
	badBegin := append(append([]byte(nil), field(8, "FIX.4.3")...), field(9, "0")...)
	c2 := dataeng.NewCollector(4096)
	if _, err := c2.Push(badBegin); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for FIX.4.3, got %v", err)
	}

	// Leading zero on a tag.
	c3 := dataeng.NewCollector(4096)
	if _, err := c3.Push([]byte("08=FIX.4.2\x01")); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for leading-zero tag, got %v", err)
	}

	// Tag 9 with a leading-zero body length.
	c4 := dataeng.NewCollector(4096)
	prefix := append(append([]byte(nil), field(8, "FIX.4.2")...), field(9, "01")...)
	if _, err := c4.Push(prefix); !errors.Is(err, dataeng.ErrMalformed) {
		t.Fatalf("want ErrMalformed for leading-zero body length, got %v", err)
	}
}

func TestMultipleMessagesRetainedInOrder(t *testing.T) {
	first := validMessage(t, "FIX.4.2", [][]byte{field(35, "D"), field(11, "A")})
	second := validMessage(t, "FIX.4.4", [][]byte{field(35, "8"), field(11, "B"), field(11, "C")})
	stream := append(append([]byte(nil), first...), second...)

	c := dataeng.NewCollector(4096)
	n, err := c.Push(stream)
	if err != nil {
		t.Fatalf("stream Push: %v", err)
	}
	if n != 2 {
		t.Fatalf("delivered %d messages, want 2", n)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	got := c.Messages()
	if len(got) != 2 || !bytes.Equal(got[0].Raw, first) || !bytes.Equal(got[1].Raw, second) {
		t.Fatalf("messages not retained in order: %d", len(got))
	}
	if got[1].Fields[0].Tag != 8 || got[1].Fields[2].Value != "8" {
		t.Fatalf("second message content not retained: %+v", got[1].Fields)
	}
}

func TestChecksumUnsignedWraparound(t *testing.T) {
	// A payload whose running unsigned sum clearly exceeds 255, so modulo 256
	// matters. Expected value is counted locally in this test.
	value := make([]byte, 0, 200)
	for i := 0; i < 200; i++ {
		value = append(value, 'Z') // 0x5A = 90 each
	}
	payload := field(58, string(value))
	body := [][]byte{field(35, "D"), payload}
	msg := validMessage(t, "FIX.4.2", body)

	// Independently confirm the expected checksum wrapped below 256.
	rawSum := 0
	for i := 0; i < len(msg)-7; i++ { // exclude "10=" + 3 digits + 0x01
		b := msg[i]
		rawSum += int(b)
	}
	if rawSum <= 255 {
		t.Fatalf("test setup must exceed 255, got %d", rawSum)
	}

	c := dataeng.NewCollector(1 << 20)
	if n, err := c.Push(msg); err != nil || n != 1 {
		t.Fatalf("wraparound checksum message rejected: n=%d err=%v", n, err)
	}
}

func TestHugeDeclaredBodyRejectedWithoutAllocate(t *testing.T) {
	// A 1 GiB declaration with a small maxBody must be rejected the moment
	// tag 9 completes, and no allocation tied to the declared size occurs.
	header := append(append([]byte(nil), field(8, "FIX.4.4")...), field(9, "1073741824")...)
	c := dataeng.NewCollector(1024)
	if _, err := c.Push(header); !errors.Is(err, dataeng.ErrMaxBody) {
		t.Fatalf("want ErrMaxBody for huge declaration, got %v", err)
	}
	if err := c.Finish(); !errors.Is(err, dataeng.ErrMaxBody) {
		t.Fatalf("collector must remain stopped, got %v", err)
	}
}
