package dataeng

import (
	"bytes"
	"encoding/binary"
	"testing"
)

const testMaxPacket = 4096

// buildPacket 手工组包：1字节代码、1字节标识、大端uint16长度、16字节鉴别码，
// 随后原样拼接属性区。不经过被测组件。
func buildPacket(code, identifier byte, attrs []byte) []byte {
	pkt := make([]byte, 20+len(attrs))
	pkt[0] = code
	pkt[1] = identifier
	binary.BigEndian.PutUint16(pkt[2:4], uint16(len(pkt)))
	for i := 0; i < 16; i++ {
		pkt[4+i] = byte(0xA0 + i)
	}
	copy(pkt[20:], attrs)
	return pkt
}

// attr 手工组一个普通属性：类型、长度（含这两字节）、值。
func attr(typ byte, value ...byte) []byte {
	a := []byte{typ, byte(2 + len(value))}
	return append(a, value...)
}

// vendorAttr 手工组一个类型26属性：类型、长度、4字节大端厂商号、子属性区。
func vendorAttr(vendor uint32, subArea ...byte) []byte {
	a := []byte{26, byte(6 + len(subArea)), 0, 0, 0, 0}
	binary.BigEndian.PutUint32(a[2:6], vendor)
	return append(a, subArea...)
}

func collect(t *testing.T, maxPacket int) (*Collector, *[]Packet) {
	t.Helper()
	var got []Packet
	c := NewCollector(maxPacket, func(p Packet) { got = append(got, p) })
	return c, &got
}

func TestVendorSubAttributesParsed(t *testing.T) {
	// 厂商号 9，两个子属性：(1, "ab") 与 (2, "xyz")。
	sub := append(attr(1, 'a', 'b'), attr(2, 'x', 'y', 'z')...)
	attrs := append(attr(1, 'u', 's', 'e', 'r'), vendorAttr(9, sub...)...)
	pkt := buildPacket(4, 7, attrs)

	c, got := collect(t, testMaxPacket)
	if err := c.Push(pkt); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(*got) != 1 {
		t.Fatalf("delivered %d packets, want 1", len(*got))
	}
	p := (*got)[0]
	if p.Code != 4 || p.Identifier != 7 {
		t.Errorf("code=%d identifier=%d, want 4/7", p.Code, p.Identifier)
	}
	wantAuth := [16]byte{}
	for i := range wantAuth {
		wantAuth[i] = byte(0xA0 + i)
	}
	if p.Authenticator != wantAuth {
		t.Errorf("authenticator = %x, want %x", p.Authenticator, wantAuth)
	}
	if len(p.Attributes) != 2 {
		t.Fatalf("got %d attributes, want 2", len(p.Attributes))
	}
	if p.Attributes[0].Type != 1 || !bytes.Equal(p.Attributes[0].Value, []byte("user")) {
		t.Errorf("plain attribute = %+v, want type 1 value %q", p.Attributes[0], "user")
	}
	v := p.Attributes[1]
	if v.Type != 26 || v.VendorID != 9 {
		t.Fatalf("vendor attribute = %+v, want type 26 vendor 9", v)
	}
	if len(v.Sub) != 2 {
		t.Fatalf("got %d sub-attributes, want 2", len(v.Sub))
	}
	// 回归：子属性的长度字节不得落入值里。
	if v.Sub[0].Type != 1 || !bytes.Equal(v.Sub[0].Value, []byte("ab")) {
		t.Errorf("sub[0] = %+v, want type 1 value %q", v.Sub[0], "ab")
	}
	if v.Sub[1].Type != 2 || !bytes.Equal(v.Sub[1].Value, []byte("xyz")) {
		t.Errorf("sub[1] = %+v, want type 2 value %q", v.Sub[1], "xyz")
	}
}

func TestSubAttributeOverrunsVendorEnd(t *testing.T) {
	// 厂商属性总长9：厂商号后只剩3字节，子属性却声明长度5。
	bad := []byte{26, 9, 0, 0, 0, 9, 1, 5, 'x'}
	pkt := buildPacket(4, 1, bad)

	c, got := collect(t, testMaxPacket)
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push succeeded, want overrun failure")
	}
	if len(*got) != 0 {
		t.Fatalf("delivered %d packets, want 0", len(*got))
	}
}

func TestVendorAttributeLengthSix(t *testing.T) {
	// 类型26长度为6，低于最小值7。
	bad := []byte{26, 6, 0, 0, 0, 9}
	pkt := buildPacket(4, 1, bad)

	c, _ := collect(t, testMaxPacket)
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push succeeded, want length-6 vendor attribute failure")
	}
}

func TestAttributeLengthTwo(t *testing.T) {
	// 属性长度为2，低于最小值3。
	bad := []byte{5, 2}
	pkt := buildPacket(2, 3, bad)

	c, _ := collect(t, testMaxPacket)
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push succeeded, want length-2 attribute failure")
	}
}

func TestPacketSplitAcrossPushes(t *testing.T) {
	attrs := append(attr(1, 'a'), vendorAttr(9, attr(3, 'z')...)...)
	pkt := buildPacket(5, 8, attrs)

	c, got := collect(t, testMaxPacket)
	// 第一段停在厂商属性的子属性中间。
	cut := 20 + 3 + 8
	if err := c.Push(pkt[:cut]); err != nil {
		t.Fatalf("Push head: %v", err)
	}
	if len(*got) != 0 {
		t.Fatalf("delivered %d packets before completion, want 0", len(*got))
	}
	if err := c.Push(pkt[cut:]); err != nil {
		t.Fatalf("Push tail: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(*got) != 1 {
		t.Fatalf("delivered %d packets, want 1", len(*got))
	}
	v := (*got)[0].Attributes[1]
	if v.VendorID != 9 || len(v.Sub) != 1 || v.Sub[0].Type != 3 || !bytes.Equal(v.Sub[0].Value, []byte("z")) {
		t.Errorf("vendor attribute = %+v, want vendor 9 sub (3, %q)", v, "z")
	}
}

func TestFinishWithIncompletePacket(t *testing.T) {
	pkt := buildPacket(1, 1, attr(1, 'a', 'b'))

	c, got := collect(t, testMaxPacket)
	if err := c.Push(pkt[:len(pkt)-1]); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); err == nil {
		t.Fatal("Finish succeeded with incomplete packet")
	}
	// 失败后组件停止：后续 Push 与 Finish 都返回错误。
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push after failure succeeded, want sticky error")
	}
	if err := c.Finish(); err == nil {
		t.Fatal("Finish after failure succeeded, want sticky error")
	}
	if len(*got) != 0 {
		t.Fatalf("delivered %d packets, want 0", len(*got))
	}
}

func TestDeclaredLengthExceedsMaxPacket(t *testing.T) {
	// 只送4字节头，声明长度超过 maxPacket，必须在长度可读后立即拒绝。
	head := []byte{1, 1, 0x10, 0x00}

	c, _ := collect(t, 100)
	if err := c.Push(head); err == nil {
		t.Fatal("Push succeeded, want rejection once length bytes are readable")
	}
}

func TestDeclaredLengthBelowHeader(t *testing.T) {
	head := []byte{1, 1, 0, 19}

	c, _ := collect(t, testMaxPacket)
	if err := c.Push(head); err == nil {
		t.Fatal("Push succeeded, want failure for length below 20")
	}
}

func TestInvalidCode(t *testing.T) {
	pkt := buildPacket(3, 1, nil)

	c, _ := collect(t, testMaxPacket)
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push succeeded, want failure for code 3")
	}
}

func TestAttributeExceedsRemaining(t *testing.T) {
	// 属性声明长度10，但属性区只有4字节。
	bad := []byte{1, 10, 'a', 'b'}
	pkt := buildPacket(1, 1, bad)

	c, _ := collect(t, testMaxPacket)
	if err := c.Push(pkt); err == nil {
		t.Fatal("Push succeeded, want failure for attribute exceeding remainder")
	}
}

func TestDeliveredPacketsRetainedAfterFailure(t *testing.T) {
	good := buildPacket(1, 1, attr(1, 'o', 'k'))
	bad := buildPacket(9, 2, nil)
	stream := append(good, bad...)

	c, got := collect(t, testMaxPacket)
	if err := c.Push(stream); err == nil {
		t.Fatal("Push succeeded, want failure for second packet")
	}
	if len(*got) != 1 {
		t.Fatalf("delivered %d packets, want 1 retained", len(*got))
	}
	if (*got)[0].Code != 1 || !bytes.Equal((*got)[0].Attributes[0].Value, []byte("ok")) {
		t.Errorf("retained packet = %+v, want code 1 with value %q", (*got)[0], "ok")
	}
}

func TestMultiplePacketsInOnePush(t *testing.T) {
	stream := append(buildPacket(1, 1, attr(1, 'a')), buildPacket(2, 2, attr(2, 'b'))...)

	c, got := collect(t, testMaxPacket)
	if err := c.Push(stream); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(*got) != 2 {
		t.Fatalf("delivered %d packets, want 2", len(*got))
	}
}
