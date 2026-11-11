package q215

import (
	"bytes"
	"errors"
	"testing"
)

func TestInterleavedSerialsIndependent(t *testing.T) {
	const (
		serA uint32 = 1
		serB uint32 = 2
	)
	pa := fill(400, 20)
	pb := fill(400, 40)

	// A opens a 400-byte packet; B interleaves a complete stream; A resumes.
	aLacing, aSegs := lacingOpenFor(pa[:255])
	pageA0 := buildPage(serA, 0, FlagBOS, -1, aLacing, aSegs)
	pageB0 := packetPage(serB, 0, FlagBOS, 400, pb)
	pageB1 := packetPage(serB, 1, FlagEOS, 400, nil)
	aLacing2, aSegs2 := lacingFor(pa[255:])
	pageA1 := buildPage(serA, 1, FlagContinued|FlagEOS, 800, aLacing2, aSegs2)

	stream := bytes.Join([][]byte{pageA0, pageB0, pageB1, pageA1}, nil)
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 5); err != nil {
		t.Fatal(err)
	}
	checkExpected(t, r.packets, []expectedPacket{
		{serB, pb, true, 400},
		{serB, nil, true, 400},
		{serA, pa, true, 800},
	})
}

func TestGapDiscardsOpenPacket(t *testing.T) {
	const serial uint32 = 55
	open := fill(255, 30)
	good := fill(60, 31)

	// Page 0 opens a packet; page 1 is lost; page 2 continues the lost tail.
	lacing, segs := lacingOpenFor(open)
	page0 := buildPage(serial, 0, FlagBOS, -1, lacing, segs)
	lacing2, segs2 := lacingFor(good)
	page2 := buildPage(serial, 2, FlagContinued, 123, lacing2, segs2)
	page3 := packetPage(serial, 3, FlagEOS, 123, nil)

	stream := bytes.Join([][]byte{page0, page2, page3}, nil)
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 4); err != nil {
		t.Fatal(err)
	}
	if len(r.gaps) != 1 {
		t.Fatalf("gaps: got %d, want 1 (%v)", len(r.gaps), r.gaps)
	}
	g := r.gaps[0]
	if g.Serial != serial || g.Expected != 1 || g.Got != 2 {
		t.Fatalf("gap fields wrong: %+v", g)
	}
	// The discarded open packet is never delivered; the content on page 2 is
	// orphan tail and must also be dropped. Only the EOS empty packet survives.
	if len(r.packets) != 1 || len(r.packets[0].Data) != 0 {
		t.Fatalf("packets after gap: %+v", r.packets)
	}
	if len(r.errs) != 0 {
		t.Fatalf("unexpected errors: %v", r.errs)
	}
}

func TestContinuedFlagMismatch(t *testing.T) {
	const serial uint32 = 77
	payload := fill(10, 40)

	t.Run("missingContinuation", func(t *testing.T) {
		open := fill(255, 41)
		lacing, segs := lacingOpenFor(open)
		page0 := buildPage(serial, 0, FlagBOS, -1, lacing, segs)
		// Page 1 lacks FlagContinued while a packet is still open.
		page1 := packetPage(serial, 1, FlagEOS, 10, payload)
		r := &recorder{}
		if err := feedChunks(t, r.config(), bytes.Join([][]byte{page0, page1}, nil), 2); err != nil {
			t.Fatal(err)
		}
		if len(r.packets) != 1 || !bytes.Equal(r.packets[0].Data, payload) {
			t.Fatalf("abandoned packet dropped, fresh packet delivered: %+v", r.packets)
		}
		if !containsErr(r.errs, ErrContinuation) {
			t.Fatalf("want ErrContinuation, got %v", r.errs)
		}
	})

	t.Run("orphanContinuation", func(t *testing.T) {
		// Orphan continued page with no open packet: its content is dropped
		// until the first terminator; a later clean page still works.
		orphan := fill(300, 42)
		lacing := []byte{255, 45}
		segs := [][]byte{orphan[:255], orphan[255:]}
		page0 := buildPage(serial, 0, FlagBOS|FlagContinued, -1, lacing, segs)
		page1 := packetPage(serial, 1, FlagEOS, 10, payload)
		r := &recorder{}
		if err := feedChunks(t, r.config(), bytes.Join([][]byte{page0, page1}, nil), 2); err != nil {
			t.Fatal(err)
		}
		if !containsErr(r.errs, ErrContinuation) {
			t.Fatalf("want ErrContinuation, got %v", r.errs)
		}
		if len(r.packets) != 1 || !bytes.Equal(r.packets[0].Data, payload) {
			t.Fatalf("only the clean packet should arrive, got %+v", r.packets)
		}
	})
}

func TestCRCFailureDeliversNothing(t *testing.T) {
	const serial uint32 = 88
	bad := packetPage(serial, 0, FlagBOS, 10, fill(10, 50))
	bad[len(bad)-1] ^= 0xFF // corrupt payload; stored CRC no longer matches

	good := packetPage(serial, 1, FlagEOS, 20, fill(20, 51))
	stream := bytes.Join([][]byte{bad, good}, nil)

	for _, chunks := range [][]int{{1}, {3}, {64}, {len(stream)}} {
		r := &recorder{}
		if err := feedChunks(t, r.config(), stream, chunks...); err != nil {
			t.Fatal(err)
		}
		if !containsErr(r.errs, ErrCRC) {
			t.Fatalf("chunks %v: want ErrCRC, got %v", chunks, r.errs)
		}
		if len(r.packets) != 1 || len(r.packets[0].Data) != 20 {
			t.Fatalf("chunks %v: corrupted page must deliver no packet, got %+v", chunks, r.packets)
		}
		if r.packets[0].Source.Sequence != 1 {
			t.Fatalf("surviving packet must come from the good page: %+v", r.packets[0])
		}
	}
}

func TestCRCFailureResyncsAcrossGarbage(t *testing.T) {
	const serial uint32 = 99
	bad := packetPage(serial, 0, FlagBOS, 10, fill(10, 60))
	bad[22] ^= 0x01
	good := packetPage(serial, 1, FlagBOS|FlagEOS, 20, fill(20, 61))
	stream := bytes.Join([][]byte{{0xDE, 0xAD, 0xBE}, bad, {0x00, 0x00}, good}, nil)

	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 1); err != nil {
		t.Fatal(err)
	}
	if !containsErr(r.errs, ErrCRC) || !containsErr(r.errs, ErrBadHeader) {
		t.Fatalf("want CRC and header errors, got %v", r.errs)
	}
	if len(r.packets) != 1 || !bytes.Equal(r.packets[0].Data, fill(20, 61)) {
		t.Fatalf("only good page packet expected: %+v", r.packets)
	}
	if r.packets[0].Source.Offset != int64(3+len(bad)+2) {
		t.Fatalf("offset wrong: %d", r.packets[0].Source.Offset)
	}
}

func TestCRCFailureWithFakeCaptureInside(t *testing.T) {
	const serial uint32 = 101
	// A page whose payload contains a fake "OggS"; the framing length still
	// defines the true boundary, so the whole page is skipped on bad CRC.
	payload := make([]byte, 40)
	copy(payload[10:14], capturePattern)
	bad := packetPage(serial, 0, FlagBOS, 10, payload)
	bad[30] ^= 0xFF // flip a payload byte without touching the embedded pattern

	good := packetPage(serial, 1, FlagEOS, 20, fill(20, 62))
	stream := bytes.Join([][]byte{bad, good}, nil)

	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 1); err != nil {
		t.Fatal(err)
	}
	if !containsErr(r.errs, ErrCRC) {
		t.Fatalf("want ErrCRC, got %v", r.errs)
	}
	if len(r.packets) != 1 || !bytes.Equal(r.packets[0].Data, fill(20, 62)) {
		t.Fatalf("embedded fake capture must not split the bad page: %+v", r.packets)
	}
}

func TestEOSHalfPacketAndTruncation(t *testing.T) {
	const serial uint32 = 111

	t.Run("eosLeavesHalfPacket", func(t *testing.T) {
		open := fill(255, 70)
		lacing, segs := lacingOpenFor(open)
		page := buildPage(serial, 0, FlagBOS|FlagEOS, -1, lacing, segs)
		r := &recorder{}
		if err := feedChunks(t, r.config(), page, 2); err != nil {
			t.Fatal(err)
		}
		if !containsErr(r.errs, ErrEOS) {
			t.Fatalf("want ErrEOS, got %v", r.errs)
		}
		if len(r.packets) != 0 {
			t.Fatalf("half packet must not be delivered, got %d", len(r.packets))
		}
	})

	t.Run("closeWithOpenPacket", func(t *testing.T) {
		open := fill(255, 71)
		lacing, segs := lacingOpenFor(open)
		page := buildPage(serial, 0, FlagBOS, -1, lacing, segs)
		r := &recorder{}
		err := feedChunks(t, r.config(), page, 2)
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("err = %v, want ErrTruncated", err)
		}
	})

	t.Run("dataAfterEOS", func(t *testing.T) {
		page0 := packetPage(serial, 0, FlagBOS|FlagEOS, 1, []byte{1})
		page1 := packetPage(serial, 1, 0, 2, []byte{2})
		r := &recorder{}
		if err := feedChunks(t, r.config(), bytes.Join([][]byte{page0, page1}, nil), 8); err != nil {
			t.Fatal(err)
		}
		if !containsErr(r.errs, ErrEOS) {
			t.Fatalf("want ErrEOS for data after EOS, got %v", r.errs)
		}
	})
}

func TestPageSourceOffsets(t *testing.T) {
	const serial uint32 = 123
	p0 := packetPage(serial, 0, FlagBOS, 5, fill(5, 80))
	p1 := packetPage(serial, 1, FlagEOS, 9, fill(9, 81))
	stream := bytes.Join([][]byte{p0, p1}, nil)
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 1); err != nil {
		t.Fatal(err)
	}
	wantOffsets := []int64{0, int64(len(p0))}
	for i, off := range wantOffsets {
		if r.packets[i].Source.Offset != off {
			t.Errorf("packet %d offset = %d, want %d", i, r.packets[i].Source.Offset, off)
		}
		if r.packets[i].Source.Sequence != uint32(i) {
			t.Errorf("packet %d sequence wrong", i)
		}
	}
}

func TestGranuleOnlyOnLastCompletePacket(t *testing.T) {
	const serial uint32 = 124
	p10 := fill(10, 90)
	p20 := fill(20, 91)
	stream := buildPage(serial, 0, FlagBOS|FlagEOS, 777,
		[]byte{10, 20}, [][]byte{p10, p20})
	r := &recorder{}
	if err := feedChunks(t, r.config(), stream, 4); err != nil {
		t.Fatal(err)
	}
	if r.packets[0].HasGranule {
		t.Fatal("non-final packet must not carry a granule position")
	}
	last := r.packets[1]
	if !last.HasGranule || last.Granule != 777 {
		t.Fatalf("last packet granule wrong: %+v", last)
	}
}

func TestWriteAfterCloseAndNilCallbacks(t *testing.T) {
	d := NewDemuxer(Config{})
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Write([]byte("OggS")); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after close: %v", err)
	}
	if err := d.Close(); !errors.Is(err, ErrClosed) {
		t.Fatalf("double close: %v", err)
	}
}

func TestCRCIndependentReference(t *testing.T) {
	// Recompute with a table-driven implementation that shares no code with
	// the production bitwise routine; both must agree on every fixture page.
	stream, _ := buildInterleavedStream()
	table := make([]uint32, 256)
	for i := range table {
		crc := uint32(i) << 24
		for bit := 0; bit < 8; bit++ {
			if crc&0x80000000 != 0 {
				crc = crc<<1 ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
		table[i] = crc
	}
	reference := func(page []byte) uint32 {
		crc := uint32(0)
		for i, b := range page {
			if i >= 22 && i <= 25 {
				b = 0
			}
			crc = crc<<8 ^ table[byte(crc>>24)^b]
		}
		return crc
	}
	for len(stream) > 0 {
		nsegs := int(stream[26])
		pageLen := headerSize + nsegs + segmentSum(stream[27:27+nsegs])
		page := stream[:pageLen]
		got := readUint32(page[22:26])
		if ref := reference(page); ref != got || crc32Ogg(page) != got {
			t.Fatalf("CRC disagreement: stored=%x ref=%x bitwise=%x",
				got, ref, crc32Ogg(page))
		}
		stream = stream[pageLen:]
	}
}

func containsErr(errs []error, target error) bool {
	for _, err := range errs {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}
