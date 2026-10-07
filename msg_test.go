package msglib

import (
	"bytes"
	"encoding/binary"
	"errors"
	"reflect"
	"testing"
)

// 测试 schema：1=标量，2=列表，3=标量；其余 tag 均未知。
var testSchema = Schema{1: Scalar, 2: List, 3: Scalar}

func field(tag uint16, payload string) []byte {
	out := make([]byte, HeaderLen+len(payload))
	binary.BigEndian.PutUint16(out[0:2], tag)
	binary.BigEndian.PutUint32(out[2:6], uint32(len(payload)))
	copy(out[HeaderLen:], payload)
	return out
}

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}

func TestParseMergeRules(t *testing.T) {
	data := concat(
		field(1, "first"),
		field(2, "a"),
		field(1, "second"),
		field(2, "b"),
		field(1, "last"),
		field(3, "solo"),
	)
	msg, err := Parse(testSchema, data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := string(msg.Scalars[1]); got != "last" {
		t.Errorf("repeated scalar: got %q, want last occurrence %q", got, "last")
	}
	if got := string(msg.Scalars[3]); got != "solo" {
		t.Errorf("scalar tag 3: got %q, want %q", got, "solo")
	}
	wantList := [][]byte{[]byte("a"), []byte("b")}
	if !reflect.DeepEqual(msg.Lists[2], wantList) {
		t.Errorf("repeated list: got %q, want concatenated %q", msg.Lists[2], wantList)
	}
	if len(msg.Unknown) != 0 {
		t.Errorf("unexpected unknown fields: %+v", msg.Unknown)
	}
}

func TestUnknownTagsPreservedInOrder(t *testing.T) {
	data := concat(
		field(9, "u1"),
		field(1, "known"),
		field(7, "u2"),
		field(9, "u3"),
	)
	msg, err := Parse(testSchema, data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := []UnknownField{
		{Tag: 9, Value: []byte("u1")},
		{Tag: 7, Value: []byte("u2")},
		{Tag: 9, Value: []byte("u3")},
	}
	if !reflect.DeepEqual(msg.Unknown, want) {
		t.Errorf("unknown fields: got %+v, want %+v", msg.Unknown, want)
	}
}

func TestCanonicalEncodeOrder(t *testing.T) {
	// 输入故意乱序：tag 3 在 tag 1 之前，未知字段穿插其间。
	data := concat(
		field(9, "u1"),
		field(3, "c"),
		field(2, "x"),
		field(1, "a"),
		field(7, "u2"),
		field(2, "y"),
	)
	msg, err := Parse(testSchema, data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	got := msg.Encode()
	// 期望：已知 tag 升序（1,2,2,3），未知保持相对顺序（9,7）附后。
	want := concat(
		field(1, "a"),
		field(2, "x"),
		field(2, "y"),
		field(3, "c"),
		field(9, "u1"),
		field(7, "u2"),
	)
	if !bytes.Equal(got, want) {
		t.Errorf("canonical encode:\n got %v\nwant %v", got, want)
	}
}

func TestRoundTripStable(t *testing.T) {
	data := concat(
		field(5, "unknown-a"),
		field(2, "l1"),
		field(1, "s1"),
		field(1, "s2"),
		field(2, "l2"),
		field(4, "unknown-b"),
	)
	msg1, err := Parse(testSchema, data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	canon1 := msg1.Encode()
	msg2, err := Parse(testSchema, canon1)
	if err != nil {
		t.Fatalf("re-Parse: %v", err)
	}
	if canon2 := msg2.Encode(); !bytes.Equal(canon2, canon1) {
		t.Errorf("round trip not stable:\nfirst  %v\nsecond %v", canon1, canon2)
	}
	// 未知字段载荷字节在往返后逐位一致。
	if !reflect.DeepEqual(msg1.Unknown, msg2.Unknown) {
		t.Errorf("unknown fields changed across round trip: %+v vs %+v", msg1.Unknown, msg2.Unknown)
	}
}

func TestLengthOverflowRejectsWholePacket(t *testing.T) {
	good := field(1, "ok")
	// 头部声明 100 字节载荷，但包内没有对应数据。
	bad := make([]byte, HeaderLen)
	binary.BigEndian.PutUint16(bad[0:2], 1)
	binary.BigEndian.PutUint32(bad[2:6], 100)

	msg, err := Parse(testSchema, concat(good, bad))
	if !errors.Is(err, ErrLengthOverflow) {
		t.Fatalf("got err %v, want ErrLengthOverflow", err)
	}
	if msg != nil {
		t.Errorf("whole packet must be rejected, got partial message %+v", msg)
	}
}

func TestLengthAboveMaxRejected(t *testing.T) {
	bad := make([]byte, HeaderLen)
	binary.BigEndian.PutUint16(bad[0:2], 2)
	binary.BigEndian.PutUint32(bad[2:6], MaxPayload+1)
	if _, err := Parse(testSchema, bad); !errors.Is(err, ErrLengthOverflow) {
		t.Fatalf("got err %v, want ErrLengthOverflow", err)
	}
}

func TestTruncatedPacketRejected(t *testing.T) {
	full := field(1, "hello")
	for _, n := range []int{1, HeaderLen - 1, HeaderLen + 2, len(full) - 1} {
		if _, err := Parse(testSchema, full[:n]); err == nil {
			t.Errorf("truncated at %d bytes: expected error", n)
		}
	}
}

func TestChunkedDecoding(t *testing.T) {
	data := concat(
		field(9, "u1"),
		field(1, "one"),
		field(2, "a"),
		field(1, "two"),
		field(2, "b"),
		field(7, "u2"),
	)
	want, err := Parse(testSchema, data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	// 多种切块策略：逐字节、3 字节、不规则大块。
	chunkSizes := [][]int{
		{1},
		{3},
		{HeaderLen - 1, 1, 2},
		{len(data)},
		{7, 13, 1, 25},
	}
	for _, sizes := range chunkSizes {
		dec := NewDecoder(testSchema)
		pos := 0
		i := 0
		for pos < len(data) {
			n := sizes[i%len(sizes)]
			i++
			if n > len(data)-pos {
				n = len(data) - pos
			}
			if err := dec.Feed(data[pos : pos+n]); err != nil {
				t.Fatalf("chunk sizes %v: Feed: %v", sizes, err)
			}
			pos += n
		}
		got, err := dec.Finalize()
		if err != nil {
			t.Fatalf("chunk sizes %v: Finalize: %v", sizes, err)
		}
		if !reflect.DeepEqual(got.Scalars, want.Scalars) ||
			!reflect.DeepEqual(got.Lists, want.Lists) ||
			!reflect.DeepEqual(got.Unknown, want.Unknown) {
			t.Errorf("chunk sizes %v: chunked result differs from one-shot", sizes)
		}
	}
}

func TestChunkedLengthOverflowAndTruncation(t *testing.T) {
	// 声明长度超上限：流式解析同样立即拒绝整包。
	bad := make([]byte, HeaderLen)
	binary.BigEndian.PutUint16(bad[0:2], 1)
	binary.BigEndian.PutUint32(bad[2:6], MaxPayload+1)
	dec := NewDecoder(testSchema)
	if err := dec.Feed(bad); !errors.Is(err, ErrLengthOverflow) {
		t.Fatalf("got err %v, want ErrLengthOverflow", err)
	}
	if _, err := dec.Finalize(); !errors.Is(err, ErrLengthOverflow) {
		t.Fatalf("Finalize got err %v, want ErrLengthOverflow", err)
	}

	// 流结束时存在截断字段：拒绝整包。
	dec = NewDecoder(testSchema)
	if err := dec.Feed(field(1, "ok")); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if err := dec.Feed([]byte{0, 1, 0}); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if _, err := dec.Finalize(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("got err %v, want ErrTruncated", err)
	}
}

func TestEmptyPacket(t *testing.T) {
	msg, err := Parse(testSchema, nil)
	if err != nil {
		t.Fatalf("Parse(nil): %v", err)
	}
	if len(msg.Scalars) != 0 || len(msg.Lists) != 0 || len(msg.Unknown) != 0 {
		t.Errorf("empty packet should yield empty message, got %+v", msg)
	}
	if out := msg.Encode(); len(out) != 0 {
		t.Errorf("empty message should encode to empty, got %v", out)
	}
}
