package dataeng

import (
	"bytes"
	"math/rand"
	"strings"
	"testing"
)

func TestFragmentBridgesGapsAndMergesBothNeighbors(t *testing.T) {
	message := NewMessage()
	if err := message.Expect("1", 10); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 0, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 8, []byte("ij")); err != nil {
		t.Fatal(err)
	}
	if err := message.AddBytes("1", 2, []byte("cdefghij")); err != nil {
		t.Fatal(err)
	}
	status, _ := message.Status("1")
	if status.Chunks != 1 {
		t.Fatalf("chunks = %d, want 1", status.Chunks)
	}
	got, err := message.SectionBytes("1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "abcdefghij" {
		t.Fatalf("got %q", got)
	}
}

func TestRandomFragmentsMatchCoverageModel(t *testing.T) {
	const size = 200
	base := []byte(strings.Repeat("0123456789", size/10))
	random := rand.New(rand.NewSource(1))

	for trial := 0; trial < 50; trial++ {
		message := NewMessage()
		if err := message.Expect("1", size); err != nil {
			t.Fatal(err)
		}

		for add := 0; add < 30; add++ {
			start := random.Intn(size)
			length := 1 + random.Intn(size-start)
			fragment := base[start : start+length]
			if err := message.AddBytes("1", int64(start), fragment); err != nil {
				t.Fatalf("trial %d add %d: %v", trial, add, err)
			}
		}
		if err := message.AddBytes("1", 0, base); err != nil {
			t.Fatalf("trial %d: filling remaining bytes: %v", trial, err)
		}

		got, err := message.SectionBytes("1")
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if !bytes.Equal(got, base) {
			t.Fatalf("trial %d: content mismatch", trial)
		}

		status, _ := message.Status("1")
		if !status.Complete || status.Received != size {
			t.Fatalf("trial %d: status = %+v", trial, status)
		}
	}
}

func TestRandomGapsMatchCoverageModel(t *testing.T) {
	const size = 100
	base := []byte(strings.Repeat("x", size))
	random := rand.New(rand.NewSource(2))

	for trial := 0; trial < 50; trial++ {
		message := NewMessage()
		if err := message.Expect("1", size); err != nil {
			t.Fatal(err)
		}

		covered := make([]bool, size)
		for add := 0; add < 8; add++ {
			start := random.Intn(size)
			length := 1 + random.Intn(size-start)
			if err := message.AddBytes("1", int64(start), base[start:start+length]); err != nil {
				t.Fatal(err)
			}
			for i := start; i < start+length; i++ {
				covered[i] = true
			}
		}

		var want []Range
		for i := 0; i < size; i++ {
			if covered[i] {
				continue
			}
			j := i
			for j < size && !covered[j] {
				j++
			}
			want = append(want, Range{Start: int64(i), End: int64(j)})
			i = j
		}
		got := message.Gaps("1")
		if len(got) != len(want) {
			t.Fatalf("trial %d: gaps = %v, want %v", trial, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("trial %d: gaps = %v, want %v", trial, got, want)
			}
		}
		if message.SectionComplete("1") != (len(want) == 0) {
			t.Fatalf("trial %d: unexpected completion state", trial)
		}
	}
}
