package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"sort"
)

const indexMagic = "AULIDX01"

type indexEntry struct {
	Seq    uint64
	Offset int64
	Length uint32 // payload length
}

// buildIndex builds a seq -> offset index from scanned frames. The index is
// allowed to lag the log; rebuilding re-scans the log from scratch.
// Duplicate sequence numbers are tolerated only when the payload is
// byte-identical (idempotent re-delivery); duplicates with different
// content are rejected.
func buildIndex(frames []Frame) (map[uint64]indexEntry, error) {
	idx := make(map[uint64]indexEntry, len(frames))
	seen := make(map[uint64][]byte, len(frames))
	for _, fr := range frames {
		if prev, ok := seen[fr.Seq]; ok {
			if !bytes.Equal(prev, fr.Payload) {
				return nil, fmt.Errorf("duplicate sequence %d with different content at offset %d", fr.Seq, fr.Offset)
			}
			continue
		}
		seen[fr.Seq] = fr.Payload
		idx[fr.Seq] = indexEntry{Seq: fr.Seq, Offset: fr.Offset, Length: uint32(len(fr.Payload))}
	}
	return idx, nil
}

// Index file layout: 8-byte magic, uint32 count, then per entry
// uint64 seq, uint64 offset, uint32 payload length (all big-endian).
func writeIndex(path string, idx map[uint64]indexEntry) error {
	seqs := make([]uint64, 0, len(idx))
	for s := range idx {
		seqs = append(seqs, s)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	buf := new(bytes.Buffer)
	buf.WriteString(indexMagic)
	writeUint32(buf, uint32(len(seqs)))
	for _, s := range seqs {
		e := idx[s]
		writeUint64(buf, e.Seq)
		writeUint64(buf, uint64(e.Offset))
		writeUint32(buf, e.Length)
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func readIndex(path string) (map[uint64]indexEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 12 || string(data[:8]) != indexMagic {
		return nil, fmt.Errorf("bad index magic")
	}
	n := binary.BigEndian.Uint32(data[8:12])
	if len(data) != 12+int(n)*20 {
		return nil, fmt.Errorf("bad index length: %d", len(data))
	}
	idx := make(map[uint64]indexEntry, n)
	off := 12
	for i := uint32(0); i < n; i++ {
		e := indexEntry{
			Seq:    binary.BigEndian.Uint64(data[off:]),
			Offset: int64(binary.BigEndian.Uint64(data[off+8:])),
			Length: binary.BigEndian.Uint32(data[off+16:]),
		}
		idx[e.Seq] = e
		off += 20
	}
	return idx, nil
}

func writeUint32(buf *bytes.Buffer, v uint32) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	buf.Write(b[:])
}

func writeUint64(buf *bytes.Buffer, v uint64) {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	buf.Write(b[:])
}
