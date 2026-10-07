package dedup

import (
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"
)

// TestRandomizedExactlyOnce runs randomized multi-producer traffic with
// gaps, duplicates, old messages, compactions and random power losses,
// and verifies the committed effect journal against a reference model
// that tracks the full set of sequence numbers.
func TestRandomizedExactlyOnce(t *testing.T) {
	const windowSize = 64
	producers := []string{"alpha", "beta", "gamma", "delta"}
	for seed := int64(0); seed < 8; seed++ {
		t.Run(fmt.Sprintf("seed_%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			fv := NewFaultVolume(NewMemVolume())
			fv.OnBoundary = func(Boundary) {
				if rng.Intn(400) == 0 {
					panic(errCrash)
				}
			}
			c, err := OpenConsumer(fv, windowSize, testEffect)
			if err != nil {
				t.Fatal(err)
			}
			ref := newRefModel(t)
			next := make(map[string]uint64)
			emitted := make(map[string][]uint64)
			decisions := make(map[Decision]int)
			crashes := 0

			for i := 0; i < 3000; i++ {
				p := producers[rng.Intn(len(producers))]
				var seq uint64
				switch r := rng.Intn(100); {
				case r < 55: // next contiguous sequence number
					seq = next[p]
					next[p]++
				case r < 70: // gap jump
					next[p] += uint64(rng.Intn(8)) + 1
					seq = next[p]
					next[p]++
				case r < 90 && len(emitted[p]) > 0: // duplicate or old
					seq = emitted[p][rng.Intn(len(emitted[p]))]
				default:
					seq = next[p]
					next[p]++
				}
				m := Message{Producer: p, Seq: seq}
				for {
					d, crashed := tryHandle(c, m)
					if !crashed {
						decisions[d]++
						switch d {
						case Accepted:
							if ref.seen(p, seq) {
								t.Fatalf("message %v accepted twice", m)
							}
							ref.commit(m)
						case Duplicate, TooOld:
							if !ref.seen(p, seq) {
								t.Fatalf("message %v reported %v but never committed", m, d)
							}
						}
						break
					}
					// Power loss: recover and reconcile the in-flight
					// message, exactly like a real consumer would.
					crashes++
					c = reopenConsumer(t, fv, windowSize)
					if c.Seen(p, seq) {
						ref.commit(m) // effect reached disk before the crash
						break
					}
					// Not committed: redeliver.
				}
				emitted[p] = append(emitted[p], seq)
				fv.TornAppend = rng.Intn(40)
				if rng.Intn(100) == 0 {
					if tryCompact(c) {
						crashes++
						c = reopenConsumer(t, fv, windowSize)
					}
				}
			}
			if crashes == 0 {
				t.Fatal("no crashes injected; test is not exercising recovery")
			}
			if decisions[Duplicate] == 0 || decisions[TooOld] == 0 {
				t.Fatalf("decision coverage incomplete: %v", decisions)
			}
			// Final reboot, then compare the full journal with the
			// full-sequence-set reference.
			c = reopenConsumer(t, fv, windowSize)
			assertJournalEqual(t, journalStrings(c), ref.journal)
			t.Logf("crashes=%d decisions=%v effects=%d", crashes, decisions, len(ref.journal))
		})
	}
}

// TestFileVolumeEndToEnd exercises the real file-backed volume,
// including restart, compaction and a mid-workload crash.
func TestFileVolumeEndToEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.log")
	const windowSize = 16

	open := func(v Volume) *Consumer {
		t.Helper()
		c, err := OpenConsumer(v, windowSize, testEffect)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}

	v, err := OpenFileVolume(path)
	if err != nil {
		t.Fatal(err)
	}
	fv := NewFaultVolume(v)
	c := open(fv)
	script := buildScript()
	want := runReference(script, windowSize)
	for i, m := range script[:8] {
		if _, err := c.Handle(m); err != nil {
			t.Fatal(err)
		}
		_ = i
	}
	if err := c.Compact(); err != nil {
		t.Fatal(err)
	}
	// Simulate a power loss on the real file: torn bytes may have
	// reached the disk, staged state is gone.
	fv.TornAppend = 5
	fv.OnBoundary = func(b Boundary) {
		if b == BoundaryBeforeSync {
			panic(errCrash)
		}
	}
	m := script[8]
	if _, crashed := tryHandle(c, m); !crashed {
		t.Fatal("expected injected crash")
	}
	fv.OnBoundary = nil
	c = reopenConsumer(t, fv, windowSize)
	if c.Seen(m.Producer, m.Seq) {
		t.Fatal("torn commit must not be visible after recovery")
	}
	for _, m := range script[8:] {
		if _, err := c.Handle(m); err != nil {
			t.Fatal(err)
		}
	}
	// Restart from a fresh file handle and verify.
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
	v2, err := OpenFileVolume(path)
	if err != nil {
		t.Fatal(err)
	}
	defer v2.Close()
	c2 := open(v2)
	assertJournalEqual(t, journalStrings(c2), want)
	if d, err := c2.Handle(script[len(script)-1]); err != nil || d != Duplicate {
		t.Fatalf("redelivery after restart = %v, %v; want Duplicate", d, err)
	}
	if d, err := c2.Handle(script[0]); err != nil || d != TooOld {
		t.Fatalf("old message after restart = %v, %v; want TooOld", d, err)
	}
}
