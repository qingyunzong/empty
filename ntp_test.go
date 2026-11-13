package dataeng_test

import (
	"encoding/binary"
	"errors"
	"testing"

	dataeng "example.org/dataeng/q0360"
)

const headerLen = 48

// Fixture builders construct every wire byte by hand. The component under
// test is never used to generate the expected packets.

func leapVersionMode(leap, version, mode uint8) uint8 {
	return leap<<6 | version<<3 | mode
}

func makeHeader(first uint8) []byte {
	buf := make([]byte, 48)
	precision := int8(-20)
	buf[0] = first
	buf[1] = 2                                        // stratum
	buf[2] = 6                                        // poll interval exponent
	buf[3] = byte(precision)                          // precision exponent
	binary.BigEndian.PutUint32(buf[4:8], 0x11223344)  // root delay
	binary.BigEndian.PutUint32(buf[8:12], 0x55667788) // root dispersion
	copy(buf[12:16], []byte{10, 20, 30, 40})
	putTS(buf[16:24], 100, 1000)
	putTS(buf[24:32], 200, 2000)
	putTS(buf[32:40], 300, 3000)
	putTS(buf[40:48], 400, 4000)
	return buf
}

func putTS(b []byte, seconds, fraction uint32) {
	binary.BigEndian.PutUint32(b[0:4], seconds)
	binary.BigEndian.PutUint32(b[4:8], fraction)
}

// appendExtension appends an extension whose declared length includes the
// 4-byte type/length header.
func appendExtension(buf []byte, typ uint16, length int) []byte {
	head := make([]byte, 4)
	binary.BigEndian.PutUint16(head[0:2], typ)
	binary.BigEndian.PutUint16(head[2:4], uint16(length))
	buf = append(buf, head...)
	value := make([]byte, length-4)
	for i := range value {
		value[i] = byte(i + 1)
	}
	return append(buf, value...)
}

// appendMAC appends a key identifier plus a digest of digestLen bytes.
func appendMAC(buf []byte, keyID uint32, digestLen int) []byte {
	out := make([]byte, 4+digestLen)
	binary.BigEndian.PutUint32(out[0:4], keyID)
	for i := 4; i < len(out); i++ {
		out[i] = byte(0xA0 + i)
	}
	return append(buf, out...)
}

// pushChunks fragments one datagram across many boundary-less feeds, then
// calls Finish so a possible header-only packet is resolved at stream end.
func pushChunks(p *dataeng.Parser, data []byte, size int) error {
	for start := 0; start < len(data); start += size {
		end := start + size
		if end > len(data) {
			end = len(data)
		}
		if err := p.Feed(data[start:end]); err != nil {
			return err
		}
	}
	return p.Finish()
}

// The last 20 bytes are a MAC, not an extension. The key identifier's low
// half is 16, which a buggy parser would accept as an extension length and
// then misread the digest as another field.
func TestMAC20NotTreatedAsExtension(t *testing.T) {
	data := appendMAC(makeHeader(leapVersionMode(0, 4, 4)), 0x00010010, 16)

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(data); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkts := p.Packets()
	if len(pkts) != 1 {
		t.Fatalf("delivered %d packets, want 1", len(pkts))
	}
	pkt := pkts[0]
	if !pkt.HasMAC {
		t.Fatal("HasMAC = false, want true")
	}
	if len(pkt.Extensions) != 0 {
		t.Fatalf("parsed %d extensions, want 0 (tail is a MAC)", len(pkt.Extensions))
	}
	if pkt.KeyID != 0x00010010 {
		t.Fatalf("KeyID = %#x, want %#x", pkt.KeyID, 0x00010010)
	}
	if len(pkt.Digest) != 16 {
		t.Fatalf("digest length = %d, want 16", len(pkt.Digest))
	}
	if pkt.Digest[0] != 0xA4 || pkt.Digest[15] != 0xB3 {
		t.Fatalf("digest content mismatch: % x", pkt.Digest)
	}
}

func TestMAC24AndNoMAC(t *testing.T) {
	withMAC := appendMAC(makeHeader(leapVersionMode(3, 4, 3)), 0xDEADBEEF, 20)
	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(withMAC); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkt := p.Packets()[0]
	if !pkt.HasMAC || pkt.KeyID != 0xDEADBEEF || len(pkt.Digest) != 20 {
		t.Fatalf("24-byte MAC parsed incorrectly: %+v", pkt)
	}
	if pkt.Leap != 3 || pkt.Mode != 3 {
		t.Fatalf("leap/mode = %d/%d, want 3/3", pkt.Leap, pkt.Mode)
	}

	noMAC := makeHeader(leapVersionMode(0, 4, 4))
	p2 := dataeng.NewParser(dataeng.Config{})
	if err := p2.Push(noMAC); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := p2.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	plain := p2.Packets()[0]
	if plain.HasMAC || len(plain.Extensions) != 0 {
		t.Fatalf("header-only packet parsed incorrectly: %+v", plain)
	}
	if plain.Stratum != 2 || plain.Poll != 6 || plain.Precision != -20 {
		t.Fatalf("fixed header fields wrong: %+v", plain)
	}
	if plain.RootDelay != 0x11223344 || plain.RootDispersion != 0x55667788 {
		t.Fatalf("root delay/dispersion wrong: %#x %#x", plain.RootDelay, plain.RootDispersion)
	}
	if plain.TransmitTime.Seconds != 400 || plain.TransmitTime.Fraction != 4000 {
		t.Fatalf("transmit timestamp wrong: %+v", plain.TransmitTime)
	}
}

// An extension length that is not a multiple of 4 must be rejected as soon as
// the 4-byte extension header is readable, even before the value arrives.
func TestExtensionLengthNotMultipleOfFour(t *testing.T) {
	data := makeHeader(leapVersionMode(0, 4, 4))
	data = appendExtension(data, 1, 18) // 18 is not divisible by 4
	data = append(data, 1, 2, 3, 4, 5, 6, 7, 8)

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	err := p.Push(data)
	if !errors.Is(err, dataeng.ErrExtensionLen) {
		t.Fatalf("err = %v, want ErrExtensionLen", err)
	}
	if p.Err() != dataeng.ErrExtensionLen {
		t.Fatalf("Err() = %v, want ErrExtensionLen", p.Err())
	}
	if len(p.Packets()) != 0 {
		t.Fatalf("delivered packets after failure: %d", len(p.Packets()))
	}
	// A failure stops the component; later calls report the same error.
	if err := p.Push([]byte{0}); !errors.Is(err, dataeng.ErrExtensionLen) {
		t.Fatalf("Push after failure = %v, want ErrExtensionLen", err)
	}
	if err := p.Finish(); !errors.Is(err, dataeng.ErrExtensionLen) {
		t.Fatalf("Finish after failure = %v, want ErrExtensionLen", err)
	}
}

func TestExtensionTooShort(t *testing.T) {
	data := makeHeader(leapVersionMode(0, 4, 4))
	data = appendExtension(data, 1, 12) // below the 16-byte minimum
	data = append(data, make([]byte, 20)...)

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(data); !errors.Is(err, dataeng.ErrExtensionLen) {
		t.Fatalf("err = %v, want ErrExtensionLen", err)
	}
}

func TestVersionNotFour(t *testing.T) {
	for _, first := range []uint8{
		leapVersionMode(0, 3, 4), // NTPv3
		leapVersionMode(0, 5, 4), // NTPv5
		leapVersionMode(0, 0, 4),
	} {
		data := makeHeader(first)
		p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
		if err := p.Push(data); !errors.Is(err, dataeng.ErrVersion) {
			t.Fatalf("first=%#02x: err = %v, want ErrVersion", first, err)
		}
	}
}

func TestModeMustBeClientOrServer(t *testing.T) {
	for _, mode := range []uint8{0, 1, 2, 5, 6, 7} {
		data := makeHeader(leapVersionMode(0, 4, mode))
		p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
		if err := p.Push(data); !errors.Is(err, dataeng.ErrMode) {
			t.Fatalf("mode=%d: err = %v, want ErrMode", mode, err)
		}
	}
	for _, mode := range []uint8{3, 4} {
		data := makeHeader(leapVersionMode(0, 4, mode))
		p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
		if err := p.Push(data); err != nil {
			t.Fatalf("mode=%d: %v", mode, err)
		}
	}
}

// A split Push may stop inside the header, an extension value, or the MAC.
// Every independent chunking must reassemble to the same packet.
func TestPacketSplitAcrossPushes(t *testing.T) {
	fixtures := map[string][]byte{
		"headerOnly": makeHeader(leapVersionMode(0, 4, 4)),
		"mac20":      appendMAC(makeHeader(leapVersionMode(0, 4, 4)), 0x00010010, 16),
		"mac24":      appendMAC(makeHeader(leapVersionMode(0, 4, 3)), 0x00020002, 20),
		"extAndMac": appendMAC(
			appendExtension(makeHeader(leapVersionMode(0, 4, 4)), 0x0007, 16),
			0x00010010, 16),
		"twoExts": appendMAC(
			appendExtension(
				appendExtension(makeHeader(leapVersionMode(0, 4, 4)), 0x0011, 16),
				0x0022, 20),
			0x00030004, 16),
	}
	chunkSizes := []int{1, 2, 3, 5, 7, 13, 16, 31, 47, 48, 49, 63, 100, 4096}

	for name, data := range fixtures {
		for _, size := range chunkSizes {
			p := dataeng.NewParser(dataeng.Config{MaxPacket: 4096})
			if err := pushChunks(p, data, size); err != nil {
				t.Fatalf("%s chunk=%d: Push: %v", name, size, err)
			}
			pkts := p.Packets()
			if len(pkts) != 1 {
				t.Fatalf("%s chunk=%d: delivered %d packets", name, size, len(pkts))
			}
			pkt := pkts[0]
			if pkt.Version != 4 || pkt.Stratum != 2 {
				t.Fatalf("%s chunk=%d: header fields wrong: %+v", name, size, pkt)
			}
		}
	}
}

func TestPushPausesInsideExtension(t *testing.T) {
	full := appendMAC(
		appendExtension(makeHeader(leapVersionMode(0, 4, 4)), 0x0007, 16),
		0x00010010, 16)

	// Stop after only 6 bytes of the 16-byte extension.
	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(full[:54]); err != nil {
		t.Fatalf("partial Push: %v", err)
	}
	if len(p.Packets()) != 0 {
		t.Fatal("packet delivered while extension incomplete")
	}
	if err := p.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish = %v, want ErrIncomplete", err)
	}

	// A fresh parser that keeps pushing completes normally.
	healthy := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := healthy.Push(full[:54]); err != nil {
		t.Fatalf("partial Push: %v", err)
	}
	if err := healthy.Push(full[54:]); err != nil {
		t.Fatalf("remaining Push: %v", err)
	}
	if err := healthy.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkt := healthy.Packets()[0]
	if len(pkt.Extensions) != 1 || pkt.Extensions[0].Type != 0x0007 ||
		pkt.Extensions[0].Length != 16 || len(pkt.Extensions[0].Value) != 12 {
		t.Fatalf("extension parsed incorrectly: %+v", pkt.Extensions)
	}
	if !pkt.HasMAC || len(pkt.Digest) != 16 {
		t.Fatalf("MAC parsed incorrectly: %+v", pkt)
	}
}

// The declared extension length exceeds the host maxPacket: reject once the
// length field is readable, without allocating according to the declaration.
func TestExtensionExceedsMaxPacket(t *testing.T) {
	data := makeHeader(leapVersionMode(0, 4, 4))
	// Only the 4-byte extension header is present, declaring 512 bytes which
	// exceeds the host cap of 256. Pad enough raw bytes (no valid 20/24 MAC
	// framing) so more than 24 bytes remain and the length is consulted; it
	// must be rejected without honoring the declaration or allocating 512.
	head := make([]byte, 4)
	binary.BigEndian.PutUint16(head[0:2], 1)
	binary.BigEndian.PutUint16(head[2:4], 512)
	data = append(data, head...)
	data = append(data, make([]byte, 32)...)

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 256})
	err := p.Push(data)
	if !errors.Is(err, dataeng.ErrExtensionLarge) {
		t.Fatalf("err = %v, want ErrExtensionLarge", err)
	}
}

// A declared length within maxPacket but beyond the bytes present means the
// packet is simply incomplete until more arrives, then Finish must fail.
func TestExtensionLongerThanAvailableIsIncomplete(t *testing.T) {
	data := makeHeader(leapVersionMode(0, 4, 4))
	data = appendExtension(data, 1, 32)
	// Cut the stream in the middle of the extension value: the remainder is
	// not a multiple of 4, so it cannot be a legal tail.
	data = data[:len(data)-3]

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(data); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := p.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish = %v, want ErrIncomplete", err)
	}
}

// After extensions, a tail that is not 0/20/24 bytes can never complete.
func TestInvalidTailCount(t *testing.T) {
	// 48-byte header plus a whole, 4-byte-aligned tail of 16 bytes. Sixteen
	// is not 0/20/24 and 16 <= 24 so no extension can be read: an illegal tail.
	data := make([]byte, headerLen+16)
	copy(data, makeHeader(leapVersionMode(0, 4, 4)))

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	if err := p.Push(data); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := p.Finish(); !errors.Is(err, dataeng.ErrTrailingBytes) {
		t.Fatalf("Finish = %v, want ErrTrailingBytes", err)
	}
}

func TestMultiplePacketsAndRetentionAfterFailure(t *testing.T) {
	first := makeHeader(leapVersionMode(0, 4, 4))
	second := appendMAC(makeHeader(leapVersionMode(0, 4, 3)), 0x00010010, 16)
	bad := makeHeader(leapVersionMode(0, 4, 4))
	// Keep >24 bytes after the header so the extension length is consulted;
	// 18 is neither a multiple of 4 nor at least 16.
	head := make([]byte, 4)
	binary.BigEndian.PutUint16(head[0:2], 1)
	binary.BigEndian.PutUint16(head[2:4], 18)
	bad = append(bad, head...)
	bad = append(bad, make([]byte, 30)...)

	p := dataeng.NewParser(dataeng.Config{MaxPacket: 1024})
	// Each datagram is pushed separately; the header-only packet is finalized
	// only once the next Push proves it is not a prefix of a larger packet.
	if err := p.Push(first); err != nil {
		t.Fatalf("first Push: %v", err)
	}
	if err := p.Push(second); err != nil {
		t.Fatalf("second Push: %v", err)
	}
	err := p.Push(bad)
	if !errors.Is(err, dataeng.ErrExtensionLen) {
		t.Fatalf("err = %v, want ErrExtensionLen", err)
	}
	// Already delivered packets are retained after the component stops.
	delivered := p.Packets()
	if len(delivered) != 2 {
		t.Fatalf("retained %d packets, want 2", len(delivered))
	}
	if delivered[1].KeyID != 0x00010010 || !delivered[1].HasMAC {
		t.Fatalf("second packet retained incorrectly: %+v", delivered[1])
	}
}

func TestOnPacketCallbackInOrder(t *testing.T) {
	first := makeHeader(leapVersionMode(0, 4, 4))
	second := makeHeader(leapVersionMode(0, 4, 3))

	var seen []uint8
	p := dataeng.NewParser(dataeng.Config{
		MaxPacket: 1024,
		OnPacket:  func(pkt *dataeng.Packet) { seen = append(seen, pkt.Mode) },
	})
	if err := p.Push(first); err != nil {
		t.Fatalf("first Push: %v", err)
	}
	if err := p.Push(second); err != nil {
		t.Fatalf("second Push: %v", err)
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(seen) != 2 || seen[0] != 4 || seen[1] != 3 {
		t.Fatalf("callback modes = %v, want [4 3]", seen)
	}
}
