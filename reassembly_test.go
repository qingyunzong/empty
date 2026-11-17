package formal

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"testing"
	"time"
)

func testReassembler(t *testing.T, cfg Config) *Reassembler {
	t.Helper()
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

func key(tunnel uint64, packet uint32) Key {
	return Key{TunnelID: tunnel, PacketID: packet}
}

// checkInvariants verifies the accounting and heap bookkeeping after every
// operation. It deliberately recomputes charges from the stored segments
// instead of trusting the maintained counter.
func checkInvariants(t *testing.T, r *Reassembler) {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()

	var total int64
	for k, p := range r.packets {
		if p.key != k {
			t.Fatalf("packet %v stored under %v", p.key, k)
		}
		if p.index < 0 || p.index >= len(r.heap) || r.heap[p.index] != p {
			t.Fatalf("packet %v has bad heap index %d", k, p.index)
		}
		var payload int64
		lastEnd := 0
		for _, s := range p.segs {
			if len(s.data) == 0 {
				t.Fatalf("packet %v has empty segment", k)
			}
			if s.start < lastEnd {
				t.Fatalf("packet %v segments overlap or are unsorted: %d < %d", k, s.start, lastEnd)
			}
			lastEnd = s.end()
			payload += int64(len(s.data))
		}
		if payload != p.bytes {
			t.Fatalf("packet %v charges %d, segments hold %d", k, p.bytes, payload)
		}
		if p.totalKnown && p.maxEnd() > p.total {
			t.Fatalf("packet %v data ends at %d beyond total %d", k, p.maxEnd(), p.total)
		}
		total += p.bytes
	}
	if total != r.used {
		t.Fatalf("used=%d, per-packet sum=%d", r.used, total)
	}
	if r.used > r.maxMemory {
		t.Fatalf("used=%d exceeds cap=%d", r.used, r.maxMemory)
	}
	if len(r.heap) != len(r.packets) {
		t.Fatalf("heap has %d entries, map has %d", len(r.heap), len(r.packets))
	}
}

func TestOutOfOrderAndIsolation(t *testing.T) {
	r := testReassembler(t, Config{MaxMemory: 1 << 20, MaxPacketSize: 1 << 10, Timeout: time.Minute})
	payload := []byte("abcdefghijklmnopqrstuvwxyz")

	// The final fragment arrives first, so the total is known up front.
	add := func(off int, last bool) Result {
		t.Helper()
		res, err := r.AddAt(Fragment{
			Key:    key(7, 99),
			Offset: off,
			Data:   append([]byte(nil), payload[off:min(off+5, len(payload))]...),
			Last:   last,
		}, time.Unix(100, 0))
		if err != nil {
			t.Fatalf("Add offset %d: %v", off, err)
		}
		checkInvariants(t, r)
		return res
	}

	if res := add(25, true); res.Complete {
		t.Fatal("datagram completed with only the tail fragment")
	}
	add(10, false)
	add(20, false)
	add(15, false)
	add(0, false)

	// The same bytes on a different tunnel and packet must not interfere.
	other, err := r.AddAt(Fragment{
		Key: key(8, 99), Offset: 0, Data: []byte("xxxxx"), Last: true,
	}, time.Unix(101, 0))
	if err != nil {
		t.Fatalf("other tunnel: %v", err)
	}
	if !other.Complete || string(other.Data) != "xxxxx" {
		t.Fatalf("other tunnel result = %+v", other)
	}

	last, err := r.AddAt(Fragment{
		Key: key(7, 99), Offset: 5, Data: append([]byte(nil), payload[5:10]...),
	}, time.Unix(102, 0))
	if err != nil {
		t.Fatalf("final gap: %v", err)
	}
	if !last.Complete || !bytes.Equal(last.Data, payload) {
		t.Fatalf("reassembled %q, want %q", last.Data, payload)
	}
	if got := r.MemoryUsed(); got != 0 {
		t.Fatalf("memory after completion = %d, want 0", got)
	}
	checkInvariants(t, r)
}

func TestDuplicateAndIdenticalOverlap(t *testing.T) {
	r := testReassembler(t, Config{MaxMemory: 64, MaxPacketSize: 64, Timeout: time.Minute})
	k := key(1, 2)

	res, err := r.Add(Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 10})
	if err != nil || res.Complete {
		t.Fatalf("first fragment: res=%+v err=%v", res, err)
	}
	if used := r.MemoryUsed(); used != 4 {
		t.Fatalf("used=%d, want 4", used)
	}

	res, err = r.Add(Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 10})
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	if !res.Duplicate || res.NewBytes != 0 {
		t.Fatalf("duplicate result = %+v", res)
	}
	if used := r.MemoryUsed(); used != 4 {
		t.Fatalf("duplicate charged memory: %d", used)
	}

	// [2,10) agrees on bytes 2..4 and supplies the remaining bytes.
	res, err = r.Add(Fragment{Key: k, Offset: 2, Data: []byte("cdefghij"), Last: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || string(res.Data) != "abcdefghij" {
		t.Fatalf("result = %+v, data=%q", res, res.Data)
	}
	if res.NewBytes != 6 {
		t.Fatalf("new bytes=%d, want 6", res.NewBytes)
	}
	if r.MemoryUsed() != 0 {
		t.Fatalf("memory leaked: %d", r.MemoryUsed())
	}
	checkInvariants(t, r)
}

func TestExplicitTotalWithoutLastFlag(t *testing.T) {
	r := testReassembler(t, Config{MaxMemory: 32, MaxPacketSize: 32, Timeout: time.Minute})
	k := key(5, 6)
	res, err := r.Add(Fragment{Key: k, Offset: 5, Data: []byte("fghij"), Total: 10})
	if err != nil || res.Complete {
		t.Fatalf("tail: res=%+v err=%v", res, err)
	}
	res, err = r.Add(Fragment{Key: k, Offset: 0, Data: []byte("abcde"), Total: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || string(res.Data) != "abcdefghij" {
		t.Fatalf("res=%+v data=%q", res, res.Data)
	}

	_, err = r.Add(Fragment{Key: key(5, 7), Offset: 0, Data: []byte("abc"), Total: 4, Last: true})
	if !errors.Is(err, ErrInvalidFragment) {
		t.Fatalf("inconsistent Last/Total err=%v", err)
	}
}

func TestConflictsAreClassifiedAndDiscarded(t *testing.T) {
	t.Run("overlap", func(t *testing.T) {
		r := testReassembler(t, Config{MaxMemory: 64, MaxPacketSize: 64, Timeout: time.Minute})
		k := key(1, 1)
		mustAdd(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 8})
		_, err := r.Add(Fragment{Key: k, Offset: 2, Data: []byte("ZZZZ"), Total: 8})
		if !errors.Is(err, ErrOverlapConflict) {
			t.Fatalf("err=%v, want ErrOverlapConflict", err)
		}
		if r.Pending() != 0 || r.MemoryUsed() != 0 {
			t.Fatalf("conflict did not discard packet: pending=%d used=%d", r.Pending(), r.MemoryUsed())
		}
		if r.Stats().Conflicts != 1 {
			t.Fatalf("conflict counter=%d", r.Stats().Conflicts)
		}
		checkInvariants(t, r)
	})

	t.Run("total mismatch", func(t *testing.T) {
		r := testReassembler(t, Config{MaxMemory: 64, MaxPacketSize: 64, Timeout: time.Minute})
		k := key(1, 2)
		mustAdd(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 8})
		_, err := r.Add(Fragment{Key: k, Offset: 4, Data: []byte("ef"), Last: true})
		if !errors.Is(err, ErrTotalMismatch) {
			t.Fatalf("err=%v, want ErrTotalMismatch", err)
		}
		if r.MemoryUsed() != 0 {
			t.Fatalf("memory=%d after mismatch", r.MemoryUsed())
		}
	})

	t.Run("out of bounds", func(t *testing.T) {
		r := testReassembler(t, Config{MaxMemory: 64, MaxPacketSize: 64, Timeout: time.Minute})
		k := key(1, 3)
		mustAdd(t, r, Fragment{Key: k, Offset: 8, Data: []byte("ij"), Last: true})
		_, err := r.Add(Fragment{Key: k, Offset: 9, Data: []byte("xyz")})
		if !errors.Is(err, ErrFragmentOutOfBounds) {
			t.Fatalf("err=%v, want ErrFragmentOutOfBounds", err)
		}
		if r.MemoryUsed() != 0 {
			t.Fatalf("memory=%d after out-of-bounds", r.MemoryUsed())
		}
	})

	t.Run("invalid and too large", func(t *testing.T) {
		r := testReassembler(t, Config{MaxMemory: 16, MaxPacketSize: 16, Timeout: time.Minute})
		_, err := r.Add(Fragment{Key: key(1, 4), Offset: -1, Data: []byte("x")})
		if !errors.Is(err, ErrInvalidFragment) {
			t.Fatalf("negative offset err=%v", err)
		}
		_, err = r.Add(Fragment{Key: key(1, 4), Offset: 0, Data: make([]byte, 17)})
		if !errors.Is(err, ErrPacketTooLarge) {
			t.Fatalf("oversized err=%v", err)
		}
		_, err = r.Add(Fragment{Key: key(1, 4), Offset: 0, Total: 17})
		if !errors.Is(err, ErrPacketTooLarge) {
			t.Fatalf("oversized total err=%v", err)
		}
		if r.Stats().Rejected != 3 {
			t.Fatalf("rejected=%d", r.Stats().Rejected)
		}
	})
}

func TestTimeoutDoesNotSlide(t *testing.T) {
	t0 := time.Unix(1000, 0)
	r := testReassembler(t, Config{MaxMemory: 64, MaxPacketSize: 64, Timeout: 10 * time.Second})
	k := key(3, 4)

	mustAddAt(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 8}, t0)
	mustAddAt(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Total: 8}, t0.Add(9*time.Second))
	if got := r.ExpireAt(t0.Add(9 * time.Second)); len(got) != 0 {
		t.Fatalf("expired early: %v", got)
	}
	got := r.ExpireAt(t0.Add(10 * time.Second))
	if len(got) != 1 || got[0] != k {
		t.Fatalf("expired=%v, want [%v]", got, k)
	}
	if r.MemoryUsed() != 0 || r.Pending() != 0 {
		t.Fatalf("expiry leaked state: used=%d pending=%d", r.MemoryUsed(), r.Pending())
	}
	checkInvariants(t, r)

	// Expiration also runs on the receive path before a new fragment.
	mustAddAt(t, r, Fragment{Key: key(3, 5), Offset: 0, Data: []byte("ab"), Total: 4}, t0)
	res, err := r.AddAt(Fragment{Key: key(3, 6), Offset: 0, Data: []byte("cd"), Total: 4}, t0.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Expired) != 1 || res.Expired[0] != key(3, 5) {
		t.Fatalf("AddAt expired=%v", res.Expired)
	}
}

func TestEarliestDeadlineEvictionIsStable(t *testing.T) {
	t0 := time.Unix(2000, 0)
	r := testReassembler(t, Config{MaxMemory: 4, MaxPacketSize: 64, Timeout: time.Minute})

	mustAddAt(t, r, Fragment{Key: key(1, 1), Offset: 0, Data: []byte("aa")}, t0)
	mustAddAt(t, r, Fragment{Key: key(1, 2), Offset: 0, Data: []byte("bb")}, t0)
	res, err := r.AddAt(Fragment{Key: key(1, 3), Offset: 0, Data: []byte("cc")}, t0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Evicted) != 1 || res.Evicted[0] != key(1, 1) {
		t.Fatalf("same-deadline eviction=%v, want oldest arrival", res.Evicted)
	}
	if r.MemoryUsed() != 4 {
		t.Fatalf("used=%d, want 4", r.MemoryUsed())
	}

	res, err = r.AddAt(Fragment{Key: key(1, 4), Offset: 0, Data: []byte("dd")}, t0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Evicted) != 1 || res.Evicted[0] != key(1, 2) {
		t.Fatalf("second eviction=%v, want key 2", res.Evicted)
	}
	checkInvariants(t, r)

	r2 := testReassembler(t, Config{MaxMemory: 4, MaxPacketSize: 64, Timeout: time.Minute})
	mustAddAt(t, r2, Fragment{Key: key(2, 1), Offset: 0, Data: []byte("aa")}, t0.Add(time.Second))
	mustAddAt(t, r2, Fragment{Key: key(2, 2), Offset: 0, Data: []byte("bb")}, t0)
	res, err = r2.AddAt(Fragment{Key: key(2, 3), Offset: 0, Data: []byte("cc")}, t0.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Evicted) != 1 || res.Evicted[0] != key(2, 2) {
		t.Fatalf("deadline eviction=%v, want key 2", res.Evicted)
	}
}

func TestEvictionReleasesEveryCharge(t *testing.T) {
	t0 := time.Unix(3000, 0)
	r := testReassembler(t, Config{MaxMemory: 10, MaxPacketSize: 64, Timeout: time.Minute})
	k := key(9, 1)

	mustAddAt(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd")}, t0)
	mustAddAt(t, r, Fragment{Key: k, Offset: 8, Data: []byte("ij")}, t0)
	if r.MemoryUsed() != 6 {
		t.Fatalf("used=%d, want 6", r.MemoryUsed())
	}
	mustAddAt(t, r, Fragment{Key: key(9, 2), Offset: 0, Data: []byte("wxyz")}, t0)
	if r.MemoryUsed() != 10 {
		t.Fatalf("used=%d, want 10", r.MemoryUsed())
	}

	// Updating k needs 4 new bytes. Key 2 has the earliest deadline only if
	// it arrived first; here k's deadline is earlier, so it must be excluded
	// and key 2 is evicted.
	res, err := r.AddAt(Fragment{Key: k, Offset: 4, Data: []byte("efgh")}, t0.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Evicted) != 1 || res.Evicted[0] != key(9, 2) {
		t.Fatalf("evicted=%v, want key 2", res.Evicted)
	}
	if r.MemoryUsed() != 10 {
		t.Fatalf("used=%d, want 10", r.MemoryUsed())
	}
	checkInvariants(t, r)

	// The updated datagram can complete and release all ten bytes.
	res, err = r.AddAt(Fragment{Key: k, Offset: 6, Data: []byte("ghij"), Last: true}, t0.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || string(res.Data) != "abcdefghij" {
		t.Fatalf("complete=%v data=%q", res.Complete, res.Data)
	}
	if r.MemoryUsed() != 0 {
		t.Fatalf("memory leaked: %d", r.MemoryUsed())
	}
	checkInvariants(t, r)
}

func TestMemoryLimitAndExplicitRemoval(t *testing.T) {
	r := testReassembler(t, Config{MaxMemory: 4, MaxPacketSize: 64, Timeout: time.Minute})
	_, err := r.Add(Fragment{Key: key(1, 1), Offset: 0, Data: []byte("12345")})
	if !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("err=%v, want ErrMemoryLimit", err)
	}
	if r.MemoryUsed() != 0 || r.Pending() != 0 {
		t.Fatalf("rejected fragment left state")
	}

	mustAdd(t, r, Fragment{Key: key(1, 1), Offset: 0, Data: []byte("abc")})
	_, err = r.Add(Fragment{Key: key(1, 1), Offset: 3, Data: []byte("de")})
	if !errors.Is(err, ErrMemoryLimit) {
		t.Fatalf("existing packet err=%v, want ErrMemoryLimit", err)
	}
	if r.MemoryUsed() != 3 || r.Pending() != 1 {
		t.Fatalf("rejection changed existing state: used=%d pending=%d", r.MemoryUsed(), r.Pending())
	}
	if !r.Remove(key(1, 1)) {
		t.Fatal("Remove returned false")
	}
	if r.Remove(key(1, 1)) {
		t.Fatal("second Remove returned true")
	}
	if r.MemoryUsed() != 0 {
		t.Fatalf("Remove leaked %d bytes", r.MemoryUsed())
	}
	checkInvariants(t, r)
}

func TestZeroLengthDatagram(t *testing.T) {
	r := testReassembler(t, Config{MaxMemory: 16, MaxPacketSize: 16, Timeout: time.Minute})
	res, err := r.Add(Fragment{Key: key(1, 1), Last: true})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Complete || len(res.Data) != 0 {
		t.Fatalf("result=%+v", res)
	}
	if r.MemoryUsed() != 0 || r.Pending() != 0 {
		t.Fatalf("zero datagram left state")
	}
}

func TestConfigDefaultsClockAndReset(t *testing.T) {
	if _, err := New(Config{MaxMemory: -1}); err == nil {
		t.Fatal("negative MaxMemory accepted")
	}
	if _, err := New(Config{MaxPacketSize: -1}); err == nil {
		t.Fatal("negative MaxPacketSize accepted")
	}
	if _, err := New(Config{Timeout: -time.Second}); err == nil {
		t.Fatal("negative Timeout accepted")
	}

	now := time.Unix(7000, 0)
	r := testReassembler(t, Config{Clock: func() time.Time { return now }})
	if r.maxMemory != defaultMaxMemory || r.maxPacket != defaultMaxPacket || r.timeout != defaultTimeout {
		t.Fatalf("defaults = (%d, %d, %s)", r.maxMemory, r.maxPacket, r.timeout)
	}
	k := key(1, 1)
	mustAdd(t, r, Fragment{Key: k, Offset: 0, Data: []byte("ab"), Total: 4})
	if r.MemoryUsed() != 2 {
		t.Fatalf("used=%d", r.MemoryUsed())
	}
	now = now.Add(defaultTimeout)
	if got := r.Expire(); len(got) != 1 || got[0] != k {
		t.Fatalf("Expire=%v", got)
	}

	mustAdd(t, r, Fragment{Key: k, Offset: 0, Data: []byte("abcd"), Last: true})
	if r.Stats().Completed != 1 {
		t.Fatalf("completed=%d", r.Stats().Completed)
	}
	r.Reset()
	stats := r.Stats()
	if stats != (Stats{}) {
		t.Fatalf("stats after Reset=%+v", stats)
	}
	if r.MemoryUsed() != 0 || r.Pending() != 0 {
		t.Fatalf("Reset left state")
	}
	checkInvariants(t, r)
}

func TestErrorDetails(t *testing.T) {
	err := &FragmentError{Kind: ErrOverlapConflict, Key: key(3, 4), Detail: "offset=7"}
	if !errors.Is(err, ErrOverlapConflict) {
		t.Fatal("errors.Is lost classification")
	}
	if got := err.Error(); got != "reassembly: conflicting overlap: tunnel=3 packet=4: offset=7" {
		t.Fatalf("Error()=%q", got)
	}
	plain := &FragmentError{Kind: ErrMemoryLimit, Key: key(1, 2)}
	if got := plain.Error(); got != "reassembly: memory limit exceeded: tunnel=1 packet=2" {
		t.Fatalf("Error()=%q", got)
	}
	if got := key(1, 2).String(); got != "tunnel=1 packet=2" {
		t.Fatalf("Key.String()=%q", got)
	}
}

func TestRandomFragmentSequences(t *testing.T) {
	rng := rand.New(rand.NewSource(0x5eed))
	for tc := 0; tc < 500; tc++ {
		size := 1 + rng.Intn(4096)
		payload := make([]byte, size)
		rng.Read(payload)

		cfg := Config{
			MaxMemory:     int64(size + 64),
			MaxPacketSize: size,
			Timeout:       time.Hour,
		}
		r := testReassembler(t, cfg)
		k := key(uint64(rng.Intn(4)), uint32(rng.Intn(1000)))

		var frags []Fragment
		pos := 0
		for pos < size {
			overlap := 0
			if pos > 0 && rng.Intn(3) == 0 {
				overlap = rng.Intn(min(pos, 32) + 1)
			}
			start := pos - overlap
			maxLen := min(64, size-start)
			length := overlap + 1 + rng.Intn(maxLen-overlap)
			end := start + length
			if end > size {
				end = size
			}
			f := Fragment{
				Key:    k,
				Offset: start,
				Data:   append([]byte(nil), payload[start:end]...),
				Last:   end == size,
			}
			frags = append(frags, f)
			if rng.Intn(4) == 0 {
				frags = append(frags, Fragment{
					Key: f.Key, Offset: f.Offset,
					Data: append([]byte(nil), f.Data...), Last: f.Last,
				})
			}
			pos = end
		}
		rng.Shuffle(len(frags), func(i, j int) { frags[i], frags[j] = frags[j], frags[i] })

		var assembled []byte
		for i, f := range frags {
			res, err := r.AddAt(f, time.Unix(int64(tc*1000+i), 0))
			if err != nil {
				t.Fatalf("case %d fragment %d (%d+%d): %v", tc, i, f.Offset, len(f.Data), err)
			}
			checkInvariants(t, r)
			if res.Complete {
				if assembled != nil {
					t.Fatalf("case %d completed twice", tc)
				}
				assembled = res.Data
				if r.MemoryUsed() != 0 {
					t.Fatalf("case %d memory after completion=%d", tc, r.MemoryUsed())
				}
				break
			}
		}
		if !bytes.Equal(assembled, payload) {
			t.Fatalf("case %d assembled %d bytes, want %d", tc, len(assembled), len(payload))
		}
	}
}

func TestRandomConflictsAndMemoryConservation(t *testing.T) {
	rng := rand.New(rand.NewSource(0xc0ffee))
	for tc := 0; tc < 300; tc++ {
		cap := int64(32 + rng.Intn(480))
		r := testReassembler(t, Config{
			MaxMemory:     cap,
			MaxPacketSize: 256,
			Timeout:       time.Duration(1+rng.Intn(20)) * time.Second,
		})
		now := time.Unix(5000, 0)
		keys := []Key{key(1, 1), key(1, 2), key(2, 1)}
		payload := make([]byte, 128)
		rng.Read(payload)

		for step := 0; step < 300; step++ {
			now = now.Add(time.Duration(rng.Intn(4)) * time.Second)
			k := keys[rng.Intn(len(keys))]
			off := rng.Intn(len(payload))
			n := 1 + rng.Intn(min(48, len(payload)-off))

			switch rng.Intn(10) {
			case 0:
				r.ExpireAt(now)
			case 1:
				r.Remove(k)
			default:
				data := append([]byte(nil), payload[off:off+n]...)
				if rng.Intn(12) == 0 {
					data[rng.Intn(len(data))] ^= 0xff
				}
				_, err := r.AddAt(Fragment{Key: k, Offset: off, Data: data}, now)
				if err != nil &&
					!errors.Is(err, ErrOverlapConflict) &&
					!errors.Is(err, ErrMemoryLimit) &&
					!errors.Is(err, ErrFragmentOutOfBounds) &&
					!errors.Is(err, ErrTotalMismatch) {
					t.Fatalf("case %d step %d: unexpected error %v", tc, step, err)
				}
			}
			checkInvariants(t, r)
		}
		r.ExpireAt(now.Add(time.Hour))
		if r.MemoryUsed() != 0 || r.Pending() != 0 {
			t.Fatalf("case %d leaked: used=%d pending=%d", tc, r.MemoryUsed(), r.Pending())
		}
		checkInvariants(t, r)
	}
}

func TestRandomInterleavedDatagrams(t *testing.T) {
	rng := rand.New(rand.NewSource(0xfaceb00c))
	for tc := 0; tc < 100; tc++ {
		const packetCount = 24
		type expected struct {
			key     Key
			payload []byte
			done    bool
		}

		want := make([]expected, packetCount)
		var events []Fragment
		totalBytes := 0
		maxSize := 0
		for i := range want {
			size := 1 + rng.Intn(512)
			payload := make([]byte, size)
			rng.Read(payload)
			k := key(uint64(rng.Intn(8)), uint32(i))
			want[i] = expected{key: k, payload: payload}
			totalBytes += size
			if size > maxSize {
				maxSize = size
			}

			for off := 0; off < size; {
				n := 1 + rng.Intn(min(40, size-off))
				events = append(events, Fragment{
					Key:    k,
					Offset: off,
					Data:   append([]byte(nil), payload[off:off+n]...),
					Last:   off+n == size,
				})
				off += n
			}
		}
		rng.Shuffle(len(events), func(i, j int) { events[i], events[j] = events[j], events[i] })

		r := testReassembler(t, Config{
			MaxMemory:     int64(totalBytes),
			MaxPacketSize: maxSize,
			Timeout:       time.Hour,
		})
		for i, f := range events {
			res, err := r.AddAt(f, time.Unix(int64(tc*10000+i), 0))
			if err != nil {
				t.Fatalf("case %d event %d: %v", tc, i, err)
			}
			if !res.Complete {
				continue
			}
			found := false
			for j := range want {
				if want[j].key != f.Key {
					continue
				}
				if want[j].done {
					t.Fatalf("case %d datagram %v completed twice", tc, f.Key)
				}
				if !bytes.Equal(res.Data, want[j].payload) {
					t.Fatalf("case %d datagram %v assembled %d bytes, want %d", tc, f.Key, len(res.Data), len(want[j].payload))
				}
				want[j].done = true
				found = true
				break
			}
			if !found {
				t.Fatalf("case %d completed unknown datagram %v", tc, f.Key)
			}
			checkInvariants(t, r)
		}
		for i := range want {
			if !want[i].done {
				t.Fatalf("case %d datagram %v did not complete", tc, want[i].key)
			}
		}
		if r.MemoryUsed() != 0 {
			t.Fatalf("case %d leaked %d bytes", tc, r.MemoryUsed())
		}
	}
}

func mustAdd(t *testing.T, r *Reassembler, f Fragment) Result {
	t.Helper()
	res, err := r.Add(f)
	if err != nil {
		t.Fatalf("Add offset=%d len=%d: %v", f.Offset, len(f.Data), err)
	}
	checkInvariants(t, r)
	return res
}

func mustAddAt(t *testing.T, r *Reassembler, f Fragment, now time.Time) Result {
	t.Helper()
	res, err := r.AddAt(f, now)
	if err != nil {
		t.Fatalf("AddAt offset=%d len=%d: %v", f.Offset, len(f.Data), err)
	}
	checkInvariants(t, r)
	return res
}

func ExampleReassembler() {
	r, _ := New(Config{MaxMemory: 1 << 20, MaxPacketSize: 1 << 16, Timeout: 30 * time.Second})
	k := Key{TunnelID: 42, PacketID: 7}

	fragments := []Fragment{
		{Key: k, Offset: 3, Data: []byte("def"), Last: true},
		{Key: k, Offset: 0, Data: []byte("abc")},
	}
	for _, f := range fragments {
		res, err := r.Add(f)
		if err != nil {
			fmt.Println("error:", err)
			return
		}
		if res.Complete {
			fmt.Printf("%s\n", res.Data)
		}
	}
	// Output: abcdef
}
