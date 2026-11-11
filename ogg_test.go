package q215

import (
	"bytes"
	"math/rand"
	"testing"
)

// buildPage assembles one Ogg page from lacing values and payload segments.
func buildPage(serial, sequence uint32, flags byte, granule int64, lacing []byte, segs [][]byte) []byte {
	nsegs := len(lacing)
	dataLen := 0
	for _, s := range segs {
		dataLen += len(s)
	}
	page := make([]byte, headerSize+nsegs+dataLen)
	copy(page[0:4], capturePattern)
	page[4] = 0
	page[5] = flags
	putUint64(page[6:14], uint64(granule))
	putUint32(page[14:18], serial)
	putUint32(page[18:22], sequence)
	page[26] = byte(nsegs)
	copy(page[27:27+nsegs], lacing)
	off := 27 + nsegs
	for _, s := range segs {
		copy(page[off:], s)
		off += len(s)
	}
	putUint32(page[22:26], crc32Ogg(page))
	return page
}

// lacingFor splits payload into 255-byte lacing segments, closing the packet
// with its final (possibly zero) lacing value.
func lacingFor(payload []byte) ([]byte, [][]byte) {
	var lacing []byte
	var segs [][]byte
	rest := payload
	for len(rest) >= 255 {
		lacing = append(lacing, 255)
		segs = append(segs, rest[:255])
		rest = rest[255:]
	}
	lacing = append(lacing, byte(len(rest)))
	segs = append(segs, rest)
	return lacing, segs
}

// lacingOpenFor encodes payload as only full 255-byte segments, so the packet
// remains open across a page boundary (no terminating lacing value).
func lacingOpenFor(payload []byte) ([]byte, [][]byte) {
	if len(payload)%255 != 0 {
		panic("open lacing requires a multiple of 255 bytes")
	}
	var lacing []byte
	var segs [][]byte
	for len(payload) > 0 {
		lacing = append(lacing, 255)
		segs = append(segs, payload[:255])
		payload = payload[255:]
	}
	return lacing, segs
}

// packetPage encodes one page containing exactly one packet.
func packetPage(serial, sequence uint32, flags byte, granule int64, payload []byte) []byte {
	lacing, segs := lacingFor(payload)
	return buildPage(serial, sequence, flags, granule, lacing, segs)
}

func putUint32(b []byte, v uint32) {
	b[0] = byte(v)
	b[1] = byte(v >> 8)
	b[2] = byte(v >> 16)
	b[3] = byte(v >> 24)
}

func putUint64(b []byte, v uint64) {
	for i := 0; i < 8; i++ {
		b[i] = byte(v >> (8 * i))
	}
}

func fill(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = seed + byte(i%7)
	}
	return b
}

type recorder struct {
	packets []Packet
	gaps    []Gap
	errs    []error
}

func (r *recorder) config() Config {
	return Config{
		OnPacket: func(p Packet) { r.packets = append(r.packets, p) },
		OnGap:    func(g Gap) { r.gaps = append(r.gaps, g) },
		OnError:  func(_ PageSource, err error) { r.errs = append(r.errs, err) },
	}
}

// feedChunks writes stream in cycling chunk sizes, then closes the demuxer.
func feedChunks(t *testing.T, cfg Config, stream []byte, chunks ...int) error {
	t.Helper()
	d := NewDemuxer(cfg)
	pos, i := 0, 0
	for pos < len(stream) {
		n := chunks[i%len(chunks)]
		i++
		if n > len(stream)-pos {
			n = len(stream) - pos
		}
		if _, err := d.Write(stream[pos : pos+n]); err != nil {
			t.Fatalf("write: %v", err)
		}
		pos += n
	}
	return d.Close()
}

type expectedPacket struct {
	serial     uint32
	data       []byte
	hasGranule bool
	granule    int64
}

// buildInterleavedStream creates a two-stream fixture exercising every
// lacing edge: multi-packet pages, cross-page packets, an exact-255-byte
// packet, and in-page empty packets.
func buildInterleavedStream() ([]byte, []expectedPacket) {
	const (
		serA uint32 = 0xA11CE
		serB uint32 = 0xB0B
	)
	p100 := fill(100, 1)
	p200 := fill(200, 2)
	p255 := fill(255, 3)
	p256 := fill(256, 4)
	p300 := fill(300, 5)
	p700 := fill(700, 6)

	var stream []byte
	var want []expectedPacket

	// A0: BOS, one 100-byte packet.
	stream = append(stream, packetPage(serA, 0, FlagBOS, 100, p100)...)
	want = append(want, expectedPacket{serA, p100, true, 100})

	// B0: BOS with a packet and an empty packet on the same page.
	stream = append(stream, buildPage(serB, 0, FlagBOS, 100,
		[]byte{100, 0}, [][]byte{p100, {}})...)
	want = append(want, expectedPacket{serB, p100, false, 0})
	want = append(want, expectedPacket{serB, []byte{}, true, 100})

	// A1: three packets on one page (200, empty, 200).
	stream = append(stream, buildPage(serA, 1, 0, 500,
		[]byte{200, 0, 200}, [][]byte{p200, {}, p200})...)
	want = append(want, expectedPacket{serA, p200, false, 0})
	want = append(want, expectedPacket{serA, []byte{}, false, 0})
	want = append(want, expectedPacket{serA, p200, true, 500})

	// A2: first 510 bytes of a 700-byte packet; the packet stays open.
	lacing, segs := lacingOpenFor(p700[:510])
	stream = append(stream, buildPage(serA, 2, 0, -1, lacing, segs)...)

	// B1: exact 255-byte packet and two empty packets on one page.
	stream = append(stream, buildPage(serB, 1, 0, 355,
		[]byte{255, 0, 0, 0}, [][]byte{p255, {}, {}, {}, {}})...)
	want = append(want, expectedPacket{serB, p255, false, 0})
	want = append(want, expectedPacket{serB, []byte{}, false, 0})
	want = append(want, expectedPacket{serB, []byte{}, true, 355})

	// A3: continuation completing the 700-byte packet, then a 256-byte one.
	partLacing, partSegs := lacingFor(p700[510:])
	p256Lacing, p256Segs := lacingFor(p256)
	stream = append(stream, buildPage(serA, 3, FlagContinued, 1200,
		append(partLacing, p256Lacing...), append(partSegs, p256Segs...))...)
	want = append(want, expectedPacket{serA, p700, false, 0})
	want = append(want, expectedPacket{serA, p256, true, 1200})

	// B2: first 255 bytes of a 300-byte packet.
	lacing, segs = lacingOpenFor(p300[:255])
	stream = append(stream, buildPage(serB, 2, 0, -1, lacing, segs)...)

	// B3: continuation completing it, with EOS.
	lacing, segs = lacingFor(p300[255:])
	stream = append(stream, buildPage(serB, 3, FlagContinued|FlagEOS, 655, lacing, segs)...)
	want = append(want, expectedPacket{serB, p300, true, 655})

	// A4: EOS with a final 100-byte packet.
	stream = append(stream, packetPage(serA, 4, FlagEOS, 1300, p100)...)
	want = append(want, expectedPacket{serA, p100, true, 1300})

	return stream, want
}

func checkExpected(t *testing.T, got []Packet, want []expectedPacket) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("packet count: got %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		g := got[i]
		if g.Source.Serial != w.serial {
			t.Errorf("packet %d serial: got %x, want %x", i, g.Source.Serial, w.serial)
		}
		if !bytes.Equal(g.Data, w.data) {
			t.Errorf("packet %d data mismatch (len %d vs %d)", i, len(g.Data), len(w.data))
		}
		if g.HasGranule != w.hasGranule || (w.hasGranule && g.Granule != w.granule) {
			t.Errorf("packet %d granule: got (%v,%d), want (%v,%d)",
				i, g.HasGranule, g.Granule, w.hasGranule, w.granule)
		}
	}
}

func TestReassemblyAllChunkings(t *testing.T) {
	stream, want := buildInterleavedStream()
	chunkSets := [][]int{
		{1}, {2}, {3}, {7}, {13}, {64}, {1000},
		{1, 2, 3, 5, 11},
		{27, 255, 256, 1024},
		{len(stream)},
	}
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 20; trial++ {
		chunkSets = append(chunkSets, []int{1 + rng.Intn(512)})
	}
	for ci, chunks := range chunkSets {
		r := &recorder{}
		if err := feedChunks(t, r.config(), stream, chunks...); err != nil {
			t.Fatalf("chunk set %d close: %v", ci, err)
		}
		checkExpected(t, r.packets, want)
		if len(r.errs) != 0 {
			t.Fatalf("chunk set %d unexpected errors: %v", ci, r.errs)
		}
		if len(r.gaps) != 0 {
			t.Fatalf("chunk set %d unexpected gaps: %v", ci, r.gaps)
		}
	}
}

func TestExact255And256Packets(t *testing.T) {
	const serial uint32 = 7
	p255 := fill(255, 9)
	p256 := fill(256, 10)
	stream := bytes.Join([][]byte{
		packetPage(serial, 0, FlagBOS, 255, p255),
		packetPage(serial, 1, 0, 511, p256),
		packetPage(serial, 2, FlagEOS, 511, nil),
	}, nil)
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 1); err != nil {
		t.Fatal(err)
	}
	checkExpected(t, r.packets, []expectedPacket{
		{serial, p255, true, 255},
		{serial, p256, true, 511},
		{serial, nil, true, 511},
	})
}

func TestInPageEmptyPackets(t *testing.T) {
	const serial uint32 = 9
	p50 := fill(50, 11)
	stream := buildPage(serial, 0, FlagBOS|FlagEOS, 50,
		[]byte{0, 0, 0, 0, 50}, [][]byte{{}, {}, {}, {}, p50})
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 3); err != nil {
		t.Fatal(err)
	}
	if len(r.packets) != 5 {
		t.Fatalf("got %d packets, want 5", len(r.packets))
	}
	for i := 0; i < 4; i++ {
		if len(r.packets[i].Data) != 0 || r.packets[i].HasGranule {
			t.Fatalf("empty packet %d malformed: %+v", i, r.packets[i])
		}
	}
	last := r.packets[4]
	if !bytes.Equal(last.Data, p50) || !last.HasGranule || last.Granule != 50 {
		t.Fatalf("last packet wrong: %+v", last)
	}
}
