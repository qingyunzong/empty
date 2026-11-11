package q270

import (
	"bytes"
	"errors"
	"testing"
)

func putBE16(b []byte, v uint16) {
	b[0] = byte(v >> 8)
	b[1] = byte(v)
}

// record wraps a handshake payload in a TLS handshake record.
func record(version uint16, payload []byte) []byte {
	rec := make([]byte, 0, recordHeaderLen+len(payload))
	hdr := [recordHeaderLen]byte{recordTypeHandshake, byte(version >> 8), byte(version),
		byte(len(payload) >> 8), byte(len(payload))}
	rec = append(rec, hdr[:]...)
	return append(rec, payload...)
}

// handshake wraps a ClientHello body in a 4-byte handshake header.
func handshake(body []byte) []byte {
	h := make([]byte, 0, handshakeHeaderLen+len(body))
	h = append(h, handshakeTypeClientHello,
		byte(len(body)>>16), byte(len(body)>>8), byte(len(body)))
	return append(h, body...)
}

func appendExt(block []byte, typ uint16, data []byte) []byte {
	block = append(block, byte(typ>>8), byte(typ), byte(len(data)>>8), byte(len(data)))
	return append(block, data...)
}

// buildBody constructs a well-formed ClientHello body.
func buildBody(sid []byte, suites []uint16, methods []uint8, sni string, alpn []string) []byte {
	var ext []byte
	if sni != "" {
		name := []byte(sni)
		entry := make([]byte, 0, 3+len(name))
		entry = append(entry, sniHostName, byte(len(name)>>8), byte(len(name)))
		entry = append(entry, name...)
		list := make([]byte, 2+len(entry))
		putBE16(list, uint16(len(entry)))
		copy(list[2:], entry)
		ext = appendExt(ext, extServerName, list)
	}
	if alpn != nil {
		var list []byte
		for _, p := range alpn {
			list = append(list, byte(len(p)))
			list = append(list, p...)
		}
		full := make([]byte, 2+len(list))
		putBE16(full, uint16(len(list)))
		copy(full[2:], list)
		ext = appendExt(ext, extALPN, full)
	}

	body := make([]byte, 0, 256)
	body = append(body, 0x03, 0x03) // client_version TLS 1.2
	body = append(body, make([]byte, 32)...)
	body = append(body, byte(len(sid)))
	body = append(body, sid...)
	cs := make([]byte, 2*len(suites))
	for i, s := range suites {
		putBE16(cs[2*i:], s)
	}
	body = append(body, byte(len(cs)>>8), byte(len(cs)))
	body = append(body, cs...)
	body = append(body, byte(len(methods)))
	body = append(body, methods...)
	body = append(body, byte(len(ext)>>8), byte(len(ext)))
	body = append(body, ext...)
	return body
}

func validStream() []byte {
	body := buildBody([]byte{0xab, 0xcd}, []uint16{0x1301, 0x1302, 0xc02f},
		[]uint8{0, 1}, "example.com", []string{"h2", "http/1.1"})
	return record(0x0301, handshake(body))
}

// feedChunks feeds the stream in fixed-size byte chunks.
func feedChunks(t *testing.T, r *Reader, stream []byte, size int) *ClientHelloInfo {
	t.Helper()
	var got *ClientHelloInfo
	for i := 0; i < len(stream); i += size {
		end := i + size
		if end > len(stream) {
			end = len(stream)
		}
		info, err := r.Feed(stream[i:end])
		if err != nil {
			t.Fatalf("chunk at %d: unexpected error: %v", i, err)
		}
		if end < len(stream) && info != nil {
			t.Fatalf("chunk at %d: ClientHello reported before all bytes fed", i)
		}
		if end == len(stream) {
			got = info
		}
	}
	if got == nil {
		t.Fatal("ClientHello never completed")
	}
	return got
}

type recordingRouter struct {
	calls int
	infos []ClientHelloInfo
}

func (r *recordingRouter) RouteClientHello(info ClientHelloInfo) {
	r.calls++
	r.infos = append(r.infos, info)
}

func assertParsed(t *testing.T, info *ClientHelloInfo, raw []byte) {
	t.Helper()
	if info == nil {
		t.Fatal("expected ClientHelloInfo, got nil")
	}
	if !bytes.Equal(info.SessionID, []byte{0xab, 0xcd}) {
		t.Fatalf("session id = %v", info.SessionID)
	}
	wantSuites := []uint16{0x1301, 0x1302, 0xc02f}
	if len(info.CipherSuites) != len(wantSuites) {
		t.Fatalf("cipher suites = %v", info.CipherSuites)
	}
	for i := range wantSuites {
		if info.CipherSuites[i] != wantSuites[i] {
			t.Fatalf("cipher suite %d = %x", i, info.CipherSuites[i])
		}
	}
	if !bytes.Equal(info.CompressionMethods, []uint8{0, 1}) {
		t.Fatalf("compression methods = %v", info.CompressionMethods)
	}
	if info.ServerName != "example.com" {
		t.Fatalf("server name = %q", info.ServerName)
	}
	if len(info.ALPN) != 2 || info.ALPN[0] != "h2" || info.ALPN[1] != "http/1.1" {
		t.Fatalf("alpn = %v", info.ALPN)
	}
	if info.ExtensionsLength == 0 {
		t.Fatal("extensions length not recorded")
	}
	if !bytes.Equal(info.Raw, raw) {
		t.Fatalf("raw replay bytes mismatch:\n got % x\nwant % x", info.Raw, raw)
	}
}

func TestFeedFullAndChunked(t *testing.T) {
	stream := validStream()
	for _, size := range []int{1, 2, 3, 5, 7, 13, 64, 4096} {
		router := &recordingRouter{}
		r := NewReader(Config{Router: router})
		info := feedChunks(t, r, stream, size)
		assertParsed(t, info, stream)
		if router.calls != 1 {
			t.Fatalf("chunk size %d: router calls = %d, want 1", size, router.calls)
		}
		if len(r.Unconsumed()) != 0 {
			t.Fatalf("chunk size %d: unexpected unconsumed bytes", size)
		}
	}
}

func TestMessageSpanningRecords(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "a.example", []string{"h2"})
	hs := handshake(body)

	// Split at every possible byte boundary across two records.
	for cut := 1; cut < len(hs); cut++ {
		stream := append(record(0x0301, hs[:cut]), record(0x0301, hs[cut:])...)
		router := &recordingRouter{}
		r := NewReader(Config{Router: router})
		info, err := r.Feed(stream)
		if err != nil {
			t.Fatalf("cut %d: %v", cut, err)
		}
		if info == nil {
			t.Fatalf("cut %d: incomplete parse", cut)
		}
		if router.calls != 1 {
			t.Fatalf("cut %d: router calls = %d", cut, router.calls)
		}
		if !bytes.Equal(info.Raw, stream) {
			t.Fatalf("cut %d: raw bytes mismatch", cut)
		}
	}
}

func TestHandshakeHeaderSpanningRecords(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	hs := handshake(body)
	// Only 2 of the 4 handshake header bytes land in the first record.
	stream := append(record(0x0301, hs[:2]), record(0x0301, hs[2:])...)
	r := NewReader(Config{})
	info, err := r.Feed(stream)
	if err != nil || info == nil {
		t.Fatalf("err=%v info=%v", err, info)
	}
	if !bytes.Equal(info.Raw, stream) {
		t.Fatal("raw bytes mismatch")
	}
}

func TestMultipleMessagesInOneRecord(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "one.example", nil)
	first := handshake(body)
	secondHS := handshake(buildBody(nil, []uint16{0x1301}, []uint8{0}, "two.example", nil))
	// One record carries the complete first message plus part of the second.
	trailing := secondHS[:10]
	payload := append(append([]byte(nil), first...), trailing...)
	stream := record(0x0301, payload)

	router := &recordingRouter{}
	r := NewReader(Config{Router: router})
	info, err := r.Feed(stream)
	if err != nil {
		t.Fatal(err)
	}
	if router.calls != 1 {
		t.Fatalf("router calls = %d", router.calls)
	}
	wantRaw := stream[:recordHeaderLen+len(first)]
	if !bytes.Equal(info.Raw, wantRaw) {
		t.Fatal("raw must contain only the first message record prefix")
	}
	if !bytes.Equal(r.Unconsumed(), trailing) {
		t.Fatalf("unconsumed = % x, want % x", r.Unconsumed(), trailing)
	}

	// A fresh Reader replays the preserved trailing bytes plus the remainder
	// without any byte loss.
	continued := append(append([]byte(nil), r.Unconsumed()...), secondHS[10:]...)
	replay := record(0x0301, continued)
	r2 := NewReader(Config{})
	info2, err := r2.Feed(replay)
	if err != nil || info2 == nil {
		t.Fatalf("trailing replay failed: err=%v info=%v", err, info2)
	}
	if info2.ServerName != "two.example" {
		t.Fatalf("second server name = %q", info2.ServerName)
	}
}

func TestTrailingRecordPreserved(t *testing.T) {
	first := validStream()
	second := record(0x0301,
		handshake(buildBody(nil, []uint16{0x1301}, []uint8{0}, "later.example", nil)))
	stream := append(append([]byte(nil), first...), second...)

	r := NewReader(Config{})
	info, err := r.Feed(stream)
	if err != nil || info == nil {
		t.Fatalf("err=%v info=%v", err, info)
	}
	if !bytes.Equal(r.Unconsumed(), second) {
		t.Fatal("following record must be retained verbatim")
	}
	r2 := NewReader(Config{})
	info2, err := r2.Feed(r.Unconsumed())
	if err != nil || info2 == nil || info2.ServerName != "later.example" {
		t.Fatalf("replay of preserved record failed: err=%v info=%v", err, info2)
	}
}

func TestRawSurvivesBufferReuse(t *testing.T) {
	stream := validStream()
	r := NewReader(Config{})
	info, err := r.Feed(stream)
	if err != nil || info == nil {
		t.Fatal(err)
	}
	if !bytes.Equal(info.Raw, stream) {
		t.Fatal("raw copy diverged")
	}
	if _, err := r.Feed([]byte{0}); !errors.Is(err, ErrAlreadyRead) {
		t.Fatalf("after-read err = %v, want ErrAlreadyRead", err)
	}
}

func sniExtData(host string) []byte {
	name := []byte(host)
	entry := make([]byte, 0, 3+len(name))
	entry = append(entry, sniHostName, byte(len(name)>>8), byte(len(name)))
	entry = append(entry, name...)
	list := make([]byte, 2+len(entry))
	putBE16(list, uint16(len(entry)))
	copy(list[2:], entry)
	return list
}

// bodyWithBlock builds a ClientHello body whose extension block is supplied
// verbatim, allowing construction of duplicate or malformed extensions.
func bodyWithBlock(suites []uint16, block []byte) []byte {
	body := make([]byte, 0, 256)
	body = append(body, 0x03, 0x03)
	body = append(body, make([]byte, 32)...)
	body = append(body, 0) // empty session id
	cs := make([]byte, 2*len(suites))
	for i, s := range suites {
		putBE16(cs[2*i:], s)
	}
	body = append(body, byte(len(cs)>>8), byte(len(cs)))
	body = append(body, cs...)
	body = append(body, 1, 0) // one compression method: null
	body = append(body, byte(len(block)>>8), byte(len(block)))
	body = append(body, block...)
	return body
}

// expectErrorChunks feeds a malformed stream in several chunk sizes and
// asserts the target sentinel is always returned and the router never fires.
func expectErrorChunks(t *testing.T, stream []byte, target error) {
	t.Helper()
	for _, size := range []int{1, 2, 4, 9, 37, len(stream)} {
		router := &recordingRouter{}
		r := NewReader(Config{Router: router})
		var err error
		for i := 0; i < len(stream); i += size {
			end := i + size
			if end > len(stream) {
				end = len(stream)
			}
			var info *ClientHelloInfo
			info, err = r.Feed(stream[i:end])
			if info != nil {
				t.Fatalf("chunk %d: malformed stream produced a result", size)
			}
			if err != nil {
				break
			}
		}
		if !errors.Is(err, target) {
			t.Fatalf("chunk %d: err = %v, want %v", size, err, target)
		}
		if router.calls != 0 {
			t.Fatalf("chunk %d: router fired %d times on invalid input", size, router.calls)
		}
	}
}

func TestDuplicateSNIExtensionRejected(t *testing.T) {
	data := sniExtData("dup.example")
	var block []byte
	block = appendExt(block, extServerName, data)
	block = appendExt(block, extServerName, data)
	stream := record(0x0301, handshake(bodyWithBlock([]uint16{0xc02f}, block)))
	expectErrorChunks(t, stream, ErrDuplicateExtension)
}

func TestDuplicateALPNExtensionRejected(t *testing.T) {
	var list []byte
	for _, p := range []string{"h2", "http/1.1"} {
		list = append(list, byte(len(p)))
		list = append(list, p...)
	}
	full := make([]byte, 2+len(list))
	putBE16(full, uint16(len(list)))
	copy(full[2:], list)
	var block []byte
	block = appendExt(block, extALPN, full)
	block = appendExt(block, extALPN, full)
	stream := record(0x0301, handshake(bodyWithBlock([]uint16{0xc02f}, block)))
	expectErrorChunks(t, stream, ErrDuplicateExtension)
}

func TestMultipleSNIHostsRejected(t *testing.T) {
	name1, name2 := []byte("a.example"), []byte("b.example")
	var entries []byte
	for _, n := range [][]byte{name1, name2} {
		entries = append(entries, sniHostName, byte(len(n)>>8), byte(len(n)))
		entries = append(entries, n...)
	}
	list := make([]byte, 2+len(entries))
	putBE16(list, uint16(len(entries)))
	copy(list[2:], entries)
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extServerName, list))))
	expectErrorChunks(t, stream, ErrInvalidClientHello)
}

func TestExtensionDataOverflowRejected(t *testing.T) {
	// Declare an extension longer than the enclosing extension block.
	block := []byte{0x00, 0x00, 0xff, 0xff, 0x01}
	stream := record(0x0301, handshake(bodyWithBlock([]uint16{0xc02f}, block)))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestOuterExtensionLengthOverflowRejected(t *testing.T) {
	body := bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extServerName, sniExtData("x.io")))
	// Inflate the 2-byte extension block length (last two bytes before block).
	blockStart := len(body) - (4 + 2 + 3 + len("x.io"))
	body[blockStart-2] = 0xff
	body[blockStart-1] = 0xff
	stream := record(0x0301, handshake(body))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestSessionIDOverflowRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	body[34] = 250 // session_id length exceeds remaining body
	stream := record(0x0301, handshake(body))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestCipherSuitesOverflowRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	// cipher_suites length sits right after the (empty) session id.
	idx := 35
	body[idx] = 0x7f
	body[idx+1] = 0xfe
	stream := record(0x0301, handshake(body))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestOddCipherSuitesLengthRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	idx := 35
	body[idx] = 0
	body[idx+1] = 3
	stream := record(0x0301, handshake(body))
	expectErrorChunks(t, stream, ErrInvalidClientHello)
}

func TestCompressionMethodsOverflowRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	// Locate compression_methods length: after 2-byte cs length + 2 cs bytes.
	idx := 35 + 2 + 2
	body[idx] = 200
	stream := record(0x0301, handshake(body))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestSNIListLengthOverflowRejected(t *testing.T) {
	data := sniExtData("x.io")
	putBE16(data, uint16(len(data)+10)) // list length escapes extension data
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extServerName, data))))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestALPNEntryOverflowRejected(t *testing.T) {
	data := []byte{0, 4, 2, 'h', '2'} // claims 4 protocol bytes, provides 2
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extALPN, data))))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestRecordLengthOverflowRejected(t *testing.T) {
	stream := validStream()
	// Inflate the record's payload length beyond the bytes present.
	stream[3] = 0xff
	stream[4] = 0xff
	router := &recordingRouter{}
	r := NewReader(Config{Router: router})
	info, err := r.Feed(stream)
	if err != nil || info != nil {
		t.Fatalf("want incomplete (nil,nil), got info=%v err=%v", info, err)
	}
	if router.calls != 0 {
		t.Fatal("router fired on truncated record")
	}
}

func TestHandshakeLengthOverflowRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	hs := handshake(body)
	// Inflate the 3-byte handshake body length.
	hs[1] = 0x7f
	hs[2] = 0xff
	hs[3] = 0xff
	stream := record(0x0301, hs)
	router := &recordingRouter{}
	r := NewReader(Config{Router: router})
	// The inflated length is itself beyond the configured message budget and
	// must be rejected without routing.
	info, err := r.Feed(stream)
	if !errors.Is(err, ErrMessageTooLarge) || info != nil {
		t.Fatalf("want ErrMessageTooLarge, got info=%v err=%v", info, err)
	}
	if router.calls != 0 {
		t.Fatal("router fired on over-budget handshake message")
	}

	// Within budget, an inflated-but-truncated message stays incomplete and
	// must not route.
	hs2 := handshake(body)
	hs2[3] = byte(len(body) + 40)
	stream2 := record(0x0301, hs2[:4+len(body)])
	router2 := &recordingRouter{}
	r2 := NewReader(Config{Router: router2, MaxHandshakeMessage: len(body) + 100})
	info2, err2 := r2.Feed(stream2)
	if err2 != nil || info2 != nil {
		t.Fatalf("want incomplete (nil,nil), got info=%v err=%v", info2, err2)
	}
	if router2.calls != 0 {
		t.Fatal("router fired on truncated handshake message")
	}
}

func TestUnexpectedRecordTypeRejected(t *testing.T) {
	good := validStream()
	bad := append([]byte{20, 0x03, 0x03, 0, 1, 0x01}, good...) // change_cipher_spec
	expectErrorChunks(t, bad, ErrUnexpectedRecord)
}

func TestUnexpectedHandshakeTypeRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	hs := handshake(body)
	hs[0] = 2 // ServerHello
	stream := record(0x0301, hs)
	expectErrorChunks(t, stream, ErrUnexpectedHandshake)
}

func TestMessageBudgetExceeded(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	hs := handshake(body)
	hs[3] = byte(len(body) + 50) // declared body exceeds a tiny budget
	stream := record(0x0301, hs[:4+len(body)])
	for _, size := range []int{1, 4, 17, len(stream)} {
		router := &recordingRouter{}
		r := NewReader(Config{
			Router:              router,
			MaxHandshakeMessage: len(body) + 10,
			MaxBuffered:         DefaultMaxBuffered,
		})
		var err error
		for i := 0; i < len(stream); i += size {
			end := i + size
			if end > len(stream) {
				end = len(stream)
			}
			var info *ClientHelloInfo
			info, err = r.Feed(stream[i:end])
			if info != nil {
				t.Fatalf("chunk %d: over-budget stream produced a result", size)
			}
			if err != nil {
				break
			}
		}
		if !errors.Is(err, ErrMessageTooLarge) {
			t.Fatalf("chunk %d: err = %v, want ErrMessageTooLarge", size, err)
		}
		if router.calls != 0 {
			t.Fatalf("chunk %d: router fired on over-budget message", size)
		}
	}
}

func TestBufferBudgetExceeded(t *testing.T) {
	stream := validStream()
	router := &recordingRouter{}
	r := NewReader(Config{Router: router, MaxBuffered: len(stream) - 1})
	info, err := r.Feed(stream)
	if !errors.Is(err, ErrMessageTooLarge) || info != nil {
		t.Fatalf("info=%v err=%v, want ErrMessageTooLarge", info, err)
	}
	if router.calls != 0 {
		t.Fatal("router fired when buffer budget exceeded")
	}
}

func TestNoExtensionsBody(t *testing.T) {
	// Body with no extension block at all (still legal TLS 1.2 structure).
	body := make([]byte, 0, 64)
	body = append(body, 0x03, 0x03)
	body = append(body, make([]byte, 32)...)
	body = append(body, 0)          // empty session id
	body = append(body, 0x00, 0x02) // one cipher suite
	body = append(body, 0xc0, 0x2f)
	body = append(body, 0x01, 0x00) // one compression method
	stream := record(0x0301, handshake(body))
	info, err := NewReader(Config{}).Feed(stream)
	if err != nil || info == nil {
		t.Fatalf("err=%v info=%v", err, info)
	}
	if info.ExtensionsLength != 0 || info.ServerName != "" || len(info.ALPN) != 0 {
		t.Fatalf("unexpected extension data: %+v", info)
	}
}

func TestRouterFunc(t *testing.T) {
	called := 0
	r := NewReader(Config{Router: RouterFunc(func(info ClientHelloInfo) {
		called++
		if info.ServerName != "example.com" {
			t.Fatalf("server name = %q", info.ServerName)
		}
	})})
	if _, err := r.Feed(validStream()); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("router func calls = %d", called)
	}
}

func TestManyTinyRecordsAndByteChunks(t *testing.T) {
	body := buildBody([]byte{1, 2, 3}, []uint16{0x1301, 0xc02f},
		[]uint8{0}, "frag.example", []string{"h2", "h3"})
	hs := handshake(body)

	// Pack the handshake into records carrying at most frag payload bytes.
	for _, frag := range []int{1, 2, 3, 4, 7} {
		var stream []byte
		for i := 0; i < len(hs); i += frag {
			end := i + frag
			if end > len(hs) {
				end = len(hs)
			}
			stream = append(stream, record(0x0301, hs[i:end])...)
		}
		router := &recordingRouter{}
		r := NewReader(Config{Router: router})
		info := feedChunks(t, r, stream, 1)
		assertParsedFragmented(t, info, stream)
		if router.calls != 1 {
			t.Fatalf("frag %d: router calls = %d", frag, router.calls)
		}
		if len(r.Unconsumed()) != 0 {
			t.Fatalf("frag %d: unconsumed bytes left", frag)
		}
	}
}

func assertParsedFragmented(t *testing.T, info *ClientHelloInfo, raw []byte) {
	t.Helper()
	if info == nil {
		t.Fatal("expected ClientHelloInfo, got nil")
	}
	if info.ServerName != "frag.example" || len(info.ALPN) != 2 {
		t.Fatalf("unexpected parsed info: %+v", info)
	}
	if !bytes.Equal(info.Raw, raw) {
		t.Fatal("fragmented raw replay bytes mismatch")
	}
}

func TestEmptySNIHostRejected(t *testing.T) {
	entry := []byte{sniHostName, 0x00, 0x00} // zero-length host_name
	list := make([]byte, 2+len(entry))
	putBE16(list, uint16(len(entry)))
	copy(list[2:], entry)
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extServerName, list))))
	expectErrorChunks(t, stream, ErrInvalidClientHello)
}

func TestUnknownSNINameTypeSkipped(t *testing.T) {
	host := []byte("ok.example")
	var entries []byte
	entries = append(entries, 9, 0x00, 0x02, 'x', 'y') // unknown type, ignored
	entries = append(entries, sniHostName, byte(len(host)>>8), byte(len(host)))
	entries = append(entries, host...)
	list := make([]byte, 2+len(entries))
	putBE16(list, uint16(len(entries)))
	copy(list[2:], entries)
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extServerName, list))))
	info, err := NewReader(Config{}).Feed(stream)
	if err != nil || info == nil {
		t.Fatalf("err=%v info=%v", err, info)
	}
	if info.ServerName != "ok.example" {
		t.Fatalf("server name = %q", info.ServerName)
	}
}

func TestEmptyALPNProtocolRejected(t *testing.T) {
	data := []byte{0x00, 0x03, 0x00, 0x01, 'h'} // zero-length name, outer length consistent
	stream := record(0x0301,
		handshake(bodyWithBlock([]uint16{0xc02f}, appendExt(nil, extALPN, data))))
	expectErrorChunks(t, stream, ErrInvalidClientHello)
}

func TestTruncatedBodyRejected(t *testing.T) {
	body := buildBody(nil, []uint16{0xc02f}, []uint8{0}, "", nil)
	hs := handshake(body[:20]) // body cut well before session_id length
	// Fix the declared length so the message completes but holds too few bytes.
	hs[1], hs[2], hs[3] = 0, byte(20>>8), byte(20)
	stream := record(0x0301, hs)
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}

func TestExtensionHeaderTruncatedRejected(t *testing.T) {
	block := []byte{0x00, 0x00, 0x00} // dangling extension header
	stream := record(0x0301, handshake(bodyWithBlock([]uint16{0xc02f}, block)))
	expectErrorChunks(t, stream, ErrLengthOutOfBounds)
}
