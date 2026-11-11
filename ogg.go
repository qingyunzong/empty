package q215

import (
	"errors"
)

// Ogg page layout constants, per RFC 3533.
const (
	capturePattern = "OggS"
	headerSize     = 27
	maxSegments    = 255
	maxPageSize    = headerSize + maxSegments + maxSegments*255

	// FlagContinued marks a page whose first segment continues a packet
	// started on an earlier page of the same logical bitstream.
	FlagContinued = 0x01
	// FlagBOS marks the beginning-of-stream page.
	FlagBOS = 0x02
	// FlagEOS marks the end-of-stream page.
	FlagEOS = 0x04
)

// Sentinel errors delivered through the error callback or returned by Close.
var (
	// ErrBadHeader reports a malformed page header (bad capture pattern,
	// unsupported version, reserved flag bits, or truncated structure).
	ErrBadHeader = errors.New("ogg: malformed page header")
	// ErrCRC reports that a page failed its CRC-32 check. No packets are
	// delivered from such a page.
	ErrCRC = errors.New("ogg: crc mismatch")
	// ErrContinuation reports that a page's continued flag does not match
	// the logical stream's pending-packet state.
	ErrContinuation = errors.New("ogg: continued flag mismatch")
	// ErrEOS reports that an end-of-stream page still leaves an unfinished
	// packet, or that data follows a closed stream.
	ErrEOS = errors.New("ogg: end-of-stream error")
	// ErrTruncated is returned by Close when one or more logical streams
	// still hold an unfinished packet.
	ErrTruncated = errors.New("ogg: truncated packet at end of input")
	// ErrClosed is returned by Write after Close has been called.
	ErrClosed = errors.New("ogg: writer already closed")
)

// PageSource identifies the Ogg page that completed a packet or caused an event.
type PageSource struct {
	// Serial is the page's stream serial number.
	Serial uint32
	// Sequence is the page's absolute segment (page) sequence number.
	Sequence uint32
	// Offset is the byte offset of the page capture pattern relative to the
	// start of the byte stream fed into the demuxer.
	Offset int64
}

// Packet is a reassembled Ogg packet delivered through the packet callback.
type Packet struct {
	// Data is the complete packet payload. It is safe to retain after the
	// callback returns; it never aliases the demuxer's internal buffer.
	Data []byte
	// Source identifies the page on which the packet was completed.
	Source PageSource
	// HasGranule reports whether Granule is meaningful. Only the last packet
	// completed on a page can carry a granule position, and only when the
	// page declares one.
	HasGranule bool
	// Granule is the granule position of the page's last completed packet.
	Granule int64
}

// Gap reports that one or more pages were lost for a logical stream. Any
// packet that was still open at the point of the gap has been discarded.
type Gap struct {
	// Serial is the affected logical bitstream.
	Serial uint32
	// Expected is the page sequence number that was expected next.
	Expected uint32
	// Got is the sequence number of the first page observed after the gap.
	Got uint32
	// Source identifies the page that revealed the gap.
	Source PageSource
}

// Config wires the demuxer to caller-supplied callbacks. Every callback may
// be nil; packet reassembly still runs so that Close can report state.
type Config struct {
	// OnPacket receives every fully reassembled packet, in stream order for
	// each serial. Packets from different serials arrive in page order.
	OnPacket func(Packet)
	// OnGap is invoked once for each detected page-sequence gap.
	OnGap func(Gap)
	// OnError receives non-fatal framing problems (bad headers, CRC failures,
	// flag mismatches, EOS violations). Processing always continues after an
	// error report and no partial data is ever delivered.
	OnError func(PageSource, error)
}

type streamState struct {
	partial    []byte // bytes of the packet currently being assembled
	have       bool   // a packet is open (partial may legitimately be empty)
	discarding bool   // skipping content of an open packet after a gap/error
	lastSeq    uint32
	seen       bool
	finished   bool
}

// Demuxer reassembles Ogg packets from an arbitrarily fragmented byte stream.
// It is safe for sequential use by a single goroutine.
type Demuxer struct {
	cfg     Config
	buf     []byte
	offset  int64 // stream offset of buf[0]
	closed  bool
	streams map[uint32]*streamState
}

// NewDemuxer creates a Demuxer delivering results through the given callbacks.
func NewDemuxer(cfg Config) *Demuxer {
	return &Demuxer{
		cfg:     cfg,
		streams: make(map[uint32]*streamState),
	}
}

// Write feeds arbitrary chunks of an Ogg byte stream. Complete pages are
// validated and reassembled as they arrive. It always returns len(p), nil;
// framing problems are reported through the error callback instead.
func (d *Demuxer) Write(p []byte) (int, error) {
	if d.closed {
		return 0, ErrClosed
	}
	if len(p) > 0 {
		d.buf = append(d.buf, p...)
	}
	for len(d.buf) >= headerSize {
		if string(d.buf[:4]) != capturePattern {
			d.resync()
			continue
		}
		nsegs := int(d.buf[26])
		pageLen := headerSize + nsegs + segmentSum(d.buf[27:27+nsegs])
		if len(d.buf) < pageLen {
			break // wait for the rest of the page
		}
		page := d.buf[:pageLen]
		if page[4] != 0 || page[5]&^uint8(FlagContinued|FlagBOS|FlagEOS) != 0 {
			src := PageSource{Offset: d.offset}
			d.fail(src, ErrBadHeader)
			d.drop(pageLen)
			continue
		}
		if crc32Ogg(page) != readUint32(page[22:26]) {
			src := PageSource{
				Serial:   readUint32(page[14:18]),
				Sequence: readUint32(page[18:22]),
				Offset:   d.offset,
			}
			d.fail(src, ErrCRC)
			d.drop(pageLen)
			continue
		}
		d.handlePage(page)
		d.drop(pageLen)
	}
	return len(p), nil
}

// Close marks the end of input. It returns ErrTruncated if any logical stream
// still holds an unfinished packet.
func (d *Demuxer) Close() error {
	if d.closed {
		return ErrClosed
	}
	d.closed = true
	for _, st := range d.streams {
		if st.have || st.discarding {
			return ErrTruncated
		}
	}
	return nil
}

// resync discards bytes up to and including the next capture pattern found
// at least one byte into the buffer. Leading garbage, if any, is reported as
// a bad-header event.
func (d *Demuxer) resync() {
	idx := indexCapture(d.buf, 1)
	if idx < 0 {
		keep := len(d.buf)
		if keep > len(capturePattern)-1 {
			keep = len(capturePattern) - 1
		}
		d.fail(PageSource{Offset: d.offset}, ErrBadHeader)
		d.drop(len(d.buf) - keep)
		return
	}
	d.fail(PageSource{Offset: d.offset}, ErrBadHeader)
	d.drop(idx)
}

func (d *Demuxer) drop(n int) {
	d.buf = d.buf[n:]
	d.offset += int64(n)
}

func (d *Demuxer) fail(src PageSource, err error) {
	if d.cfg.OnError != nil {
		d.cfg.OnError(src, err)
	}
}

func (d *Demuxer) emitGap(g Gap) {
	if d.cfg.OnGap != nil {
		d.cfg.OnGap(g)
	}
}

func (d *Demuxer) handlePage(page []byte) {
	headerType := page[5]
	granule := int64(readUint64(page[6:14]))
	serial := readUint32(page[14:18])
	sequence := readUint32(page[18:22])
	nsegs := int(page[26])
	lacing := page[27 : 27+nsegs]
	data := page[27+nsegs:]
	src := PageSource{Serial: serial, Sequence: sequence, Offset: d.offset}

	st := d.streams[serial]
	if st == nil {
		st = &streamState{}
		d.streams[serial] = st
	}

	if st.finished {
		d.fail(src, ErrEOS)
		*st = streamState{}
	}
	if st.seen {
		expected := st.lastSeq + 1
		if expected != sequence {
			d.emitGap(Gap{
				Serial:   serial,
				Expected: expected,
				Got:      sequence,
				Source:   src,
			})
			if st.have || st.discarding {
				st.partial = nil
				st.have = false
				st.discarding = true
			}
		}
	}
	st.lastSeq = sequence
	st.seen = true

	continued := headerType&FlagContinued != 0
	if st.discarding {
		if !continued {
			d.fail(src, ErrContinuation)
			st.discarding = false
		}
	} else if continued != st.have {
		d.fail(src, ErrContinuation)
		if continued {
			// Orphan continuation: ignore this page's packet content until
			// the first segment terminator.
			st.partial = nil
			st.have = false
			st.discarding = true
		} else {
			// The pending packet lost its continuation: abandon it and let
			// this page start fresh packets.
			st.partial = nil
			st.have = false
		}
	}

	completed := make([][]byte, 0, countTerminators(lacing))
	dataOff := 0
	for _, seg := range lacing {
		chunk := data[dataOff : dataOff+int(seg)]
		dataOff += int(seg)
		if st.discarding {
			if seg < 255 {
				st.discarding = false
			}
			continue
		}
		if !st.have {
			st.partial = append(st.partial[:0], chunk...)
			st.have = true
		} else {
			st.partial = append(st.partial, chunk...)
		}
		if seg < 255 {
			// Copy immediately: st.partial's backing array is reused for
			// subsequent packets, including zero-length ones.
			done := make([]byte, len(st.partial))
			copy(done, st.partial)
			completed = append(completed, done)
			st.partial = nil
			st.have = false
		}
	}

	for i, payload := range completed {
		pkt := Packet{
			Data:   payload,
			Source: src,
		}
		if i == len(completed)-1 && granule != -1 {
			pkt.HasGranule = true
			pkt.Granule = granule
		}
		if d.cfg.OnPacket != nil {
			d.cfg.OnPacket(pkt)
		}
	}

	if headerType&FlagEOS != 0 {
		if st.have || st.discarding {
			d.fail(src, ErrEOS)
		}
		*st = streamState{seen: true, lastSeq: sequence, finished: true}
	}
}

// segmentSum returns the total payload size declared by a lacing table.
func segmentSum(lacing []byte) int {
	total := 0
	for _, seg := range lacing {
		total += int(seg)
	}
	return total
}

// countTerminators returns the number of packets completed by a lacing table:
// every lacing value below 255, including 0 (an empty packet), closes one.
func countTerminators(lacing []byte) int {
	n := 0
	for _, seg := range lacing {
		if seg < 255 {
			n++
		}
	}
	return n
}

func indexCapture(b []byte, start int) int {
	for i := start; i+4 <= len(b); i++ {
		if b[i] == 'O' && string(b[i:i+4]) == capturePattern {
			return i
		}
	}
	return -1
}

func readUint32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

func readUint64(b []byte) uint64 {
	v := uint64(0)
	for i := 0; i < 8; i++ {
		v |= uint64(b[i]) << (8 * i)
	}
	return v
}

// crc32Ogg computes the Ogg framing CRC (poly 0x04c11db7, no reflection, no
// final xor) over a full page, treating the stored CRC field as zero.
func crc32Ogg(page []byte) uint32 {
	crc := uint32(0)
	for i, b := range page {
		if i >= 22 && i <= 25 {
			b = 0
		}
		crc ^= uint32(b) << 24
		for bit := 0; bit < 8; bit++ {
			if crc&0x80000000 != 0 {
				crc = (crc << 1) ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}
