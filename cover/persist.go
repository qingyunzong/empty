package cover

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sort"
)

// On-disk record layout (all integers little-endian):
//
//	magic   4 bytes  "CVRC"
//	length  uint32    payload length in bytes
//	crc     uint32    CRC-32 (Castagnoli) of payload
//	payload runID(16) | digest(32) | nEdges uint32 | nEdges * (edge uint32 | count uint64)
//
// The log is append-only. Recovery stops at the first truncated or
// corrupt record, so a crash mid-write never loses earlier data.
var logMagic = [4]byte{'C', 'V', 'R', 'C'}

const (
	logHeaderLen = 4 + 4 + 4 // magic + length + crc
	maxRecordLen = 1 << 30
)

// LogWriter appends run records to an append-only coverage log.
type LogWriter struct {
	w *bufio.Writer
}

// NewLogWriter wraps w (typically an *os.File opened with O_APPEND).
func NewLogWriter(w io.Writer) *LogWriter {
	return &LogWriter{w: bufio.NewWriter(w)}
}

// Append encodes and writes one run record.
func (lw *LogWriter) Append(rec RunRecord) error {
	ids := make([]EdgeID, 0, len(rec.Counts))
	for id := range rec.Counts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	payload := make([]byte, 0, 16+32+4+len(ids)*12)
	payload = append(payload, rec.RunID[:]...)
	payload = append(payload, rec.Source[:]...)
	payload = binary.LittleEndian.AppendUint32(payload, uint32(len(ids)))
	for _, id := range ids {
		payload = binary.LittleEndian.AppendUint32(payload, uint32(id))
		payload = binary.LittleEndian.AppendUint64(payload, rec.Counts[id])
	}

	header := make([]byte, 0, logHeaderLen)
	header = append(header, logMagic[:]...)
	header = binary.LittleEndian.AppendUint32(header, uint32(len(payload)))
	header = binary.LittleEndian.AppendUint32(header, crc32.Checksum(payload, crc32.MakeTable(crc32.Castagnoli)))

	if _, err := lw.w.Write(header); err != nil {
		return err
	}
	_, err := lw.w.Write(payload)
	return err
}

// Flush flushes buffered records to the underlying writer.
func (lw *LogWriter) Flush() error { return lw.w.Flush() }

// Recover reads every intact record in the log at path and merges it
// into a new store. A truncated or corrupt tail (e.g. from a crash
// mid-write) is ignored. It returns the store and the number of
// records read from disk (including duplicates skipped by the store).
func Recover(path string) (*Store, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	return RecoverFrom(f)
}

// RecoverFrom is Recover for an arbitrary reader.
func RecoverFrom(r io.Reader) (*Store, int, error) {
	br := bufio.NewReader(r)
	store := NewStore()
	read := 0
	table := crc32.MakeTable(crc32.Castagnoli)
	for {
		header := make([]byte, logHeaderLen)
		if _, err := io.ReadFull(br, header); err != nil {
			break // clean EOF or truncated header: stop
		}
		if [4]byte(header[:4]) != logMagic {
			break // corrupt tail
		}
		length := binary.LittleEndian.Uint32(header[4:8])
		if length > maxRecordLen {
			break
		}
		wantCRC := binary.LittleEndian.Uint32(header[8:12])
		payload := make([]byte, length)
		if _, err := io.ReadFull(br, payload); err != nil {
			break // truncated payload
		}
		if crc32.Checksum(payload, table) != wantCRC {
			break // corrupt payload
		}
		rec, err := decodeRecord(payload)
		if err != nil {
			break
		}
		if _, err := store.Merge(rec); err != nil {
			return nil, read, fmt.Errorf("cover: recover record %d: %w", read, err)
		}
		read++
	}
	return store, read, nil
}

func decodeRecord(payload []byte) (RunRecord, error) {
	var rec RunRecord
	if len(payload) < 16+32+4 {
		return rec, fmt.Errorf("payload too short: %d bytes", len(payload))
	}
	copy(rec.RunID[:], payload[:16])
	copy(rec.Source[:], payload[16:48])
	n := binary.LittleEndian.Uint32(payload[48:52])
	rest := payload[52:]
	if uint64(n)*12 != uint64(len(rest)) {
		return rec, fmt.Errorf("payload length mismatch: %d edges, %d bytes left", n, len(rest))
	}
	rec.Counts = make(map[EdgeID]uint64, n)
	for i := uint32(0); i < n; i++ {
		id := EdgeID(binary.LittleEndian.Uint32(rest[i*12 : i*12+4]))
		c := binary.LittleEndian.Uint64(rest[i*12+4 : i*12+12])
		rec.Counts[id] = c
	}
	return rec, nil
}
