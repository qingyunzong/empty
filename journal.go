package formal

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const (
	frameMagic       uint32 = 0x46435047 // "FCPG"
	frameVersion     uint16 = 1
	frameHeaderSize         = 24
	maxFramePayload         = 256 << 20
	maxRecordsPerTxn        = 1_000_000
)

type entryKind uint8

const (
	entryBegin entryKind = iota + 1
	entryPrepare
	entryCommit
	entryAbort
	entryAck
)

func (k entryKind) valid() bool {
	return k >= entryBegin && k <= entryAck
}

func (k entryKind) String() string {
	switch k {
	case entryBegin:
		return "begin"
	case entryPrepare:
		return "prepare"
	case entryCommit:
		return "commit"
	case entryAbort:
		return "abort"
	case entryAck:
		return "ack"
	default:
		return fmt.Sprintf("entry-kind(%d)", uint8(k))
	}
}

type journalEntry struct {
	seq     uint64
	kind    entryKind
	txnID   TxnID
	digest  [32]byte
	count   int
	records []Record
}

type journal interface {
	append(journalEntry) (uint64, error)
	entries() ([]journalEntry, error)
	close() error
}

type fileLog struct {
	mu     sync.Mutex
	file   *os.File
	size   int64
	seq    uint64
	closed bool
	broken error
}

func openFileLog(path string) (*fileLog, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("formal: create journal directory: %w", err)
	}

	_, statErr := os.Stat(path)
	newFile := errors.Is(statErr, os.ErrNotExist)
	if statErr != nil && !newFile {
		return nil, fmt.Errorf("formal: stat journal: %w", statErr)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("formal: open journal: %w", err)
	}
	if newFile {
		if err := syncDirectory(dir); err != nil {
			_ = f.Close()
			return nil, err
		}
	}

	log := &fileLog{file: f}
	entries, validEnd, err := readFrames(f)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("formal: stat open journal: %w", err)
	}
	if validEnd < info.Size() {
		if err := f.Truncate(validEnd); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("formal: truncate torn journal tail: %w", err)
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("formal: sync repaired journal: %w", err)
		}
	}
	log.size = validEnd
	if len(entries) > 0 {
		log.seq = entries[len(entries)-1].seq
	}
	return log, nil
}

func (l *fileLog) append(entry journalEntry) (uint64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		return 0, ErrClosed
	}
	if l.broken != nil {
		return 0, l.broken
	}

	entry.seq = l.seq + 1
	frame, err := encodeFrame(entry)
	if err != nil {
		return 0, err
	}

	oldSize := l.size
	n, err := l.file.Write(frame)
	if err == nil && n != len(frame) {
		err = io.ErrShortWrite
	}
	if err != nil {
		rollbackErr := l.file.Truncate(oldSize)
		syncErr := l.file.Sync()
		l.broken = errors.Join(fmt.Errorf("formal: append journal: %w", err), rollbackErr, syncErr)
		return 0, l.broken
	}
	if err := l.file.Sync(); err != nil {
		_ = l.file.Truncate(oldSize)
		_ = l.file.Sync()
		l.broken = fmt.Errorf("formal: sync journal: %w", err)
		return 0, l.broken
	}

	l.seq = entry.seq
	l.size += int64(len(frame))
	return entry.seq, nil
}

func (l *fileLog) entries() ([]journalEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		return nil, ErrClosed
	}
	entries, validEnd, err := readFrames(l.file)
	if err != nil {
		return nil, err
	}
	if validEnd != l.size {
		return nil, fmt.Errorf("%w: journal changed outside the coordinator", ErrCorruptLog)
	}
	return entries, nil
}

func (l *fileLog) close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		return nil
	}
	l.closed = true
	syncErr := l.file.Sync()
	closeErr := l.file.Close()
	return errors.Join(syncErr, closeErr)
}

func readFrames(f *os.File) ([]journalEntry, int64, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, 0, fmt.Errorf("formal: seek journal: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		return nil, 0, fmt.Errorf("formal: stat journal: %w", err)
	}
	size := info.Size()

	var entries []journalEntry
	var offset int64
	var lastSeq uint64
	header := make([]byte, frameHeaderSize)

	for offset < size {
		if size-offset < frameHeaderSize {
			return entries, offset, nil
		}
		if _, err := io.ReadFull(f, header); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return entries, offset, nil
			}
			return nil, 0, fmt.Errorf("formal: read journal header: %w", err)
		}

		magic := binary.BigEndian.Uint32(header[0:4])
		version := binary.BigEndian.Uint16(header[4:6])
		kind := entryKind(header[6])
		seq := binary.BigEndian.Uint64(header[8:16])
		payloadLen := binary.BigEndian.Uint32(header[16:20])
		wantCRC := binary.BigEndian.Uint32(header[20:24])

		if magic != frameMagic || version != frameVersion || header[7] != 0 || !kind.valid() {
			return nil, 0, fmt.Errorf("%w: invalid frame header at offset %d", ErrCorruptLog, offset)
		}
		if payloadLen > maxFramePayload {
			return nil, 0, fmt.Errorf("%w: frame payload too large at offset %d", ErrCorruptLog, offset)
		}

		frameEnd := offset + frameHeaderSize + int64(payloadLen)
		if frameEnd > size {
			return entries, offset, nil
		}
		payload := make([]byte, int(payloadLen))
		if _, err := io.ReadFull(f, payload); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return entries, offset, nil
			}
			return nil, 0, fmt.Errorf("formal: read journal payload: %w", err)
		}

		h := crc32.NewIEEE()
		_, _ = h.Write(header[:20])
		_, _ = h.Write(payload)
		if h.Sum32() != wantCRC {
			if frameEnd == size {
				return entries, offset, nil
			}
			return nil, 0, fmt.Errorf("%w: checksum mismatch at offset %d", ErrCorruptLog, offset)
		}

		if seq != lastSeq+1 {
			return nil, 0, fmt.Errorf("%w: sequence %d after %d", ErrCorruptLog, seq, lastSeq)
		}
		entry, err := decodeEntryPayload(kind, payload)
		if err != nil {
			return nil, 0, fmt.Errorf("%w: entry at offset %d: %v", ErrCorruptLog, offset, err)
		}
		entry.seq = seq
		entries = append(entries, entry)
		lastSeq = seq
		offset = frameEnd
	}
	return entries, offset, nil
}

func encodeFrame(entry journalEntry) ([]byte, error) {
	payload, err := encodeEntryPayload(entry)
	if err != nil {
		return nil, err
	}
	if len(payload) > maxFramePayload {
		return nil, fmt.Errorf("formal: journal entry is too large: %d bytes", len(payload))
	}

	frame := make([]byte, frameHeaderSize+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], frameMagic)
	binary.BigEndian.PutUint16(frame[4:6], frameVersion)
	frame[6] = byte(entry.kind)
	binary.BigEndian.PutUint64(frame[8:16], entry.seq)
	binary.BigEndian.PutUint32(frame[16:20], uint32(len(payload)))
	copy(frame[frameHeaderSize:], payload)

	h := crc32.NewIEEE()
	_, _ = h.Write(frame[:20])
	_, _ = h.Write(payload)
	binary.BigEndian.PutUint32(frame[20:24], h.Sum32())
	return frame, nil
}

func encodeEntryPayload(entry journalEntry) ([]byte, error) {
	var buf bytes.Buffer
	writeBytes(&buf, []byte(entry.txnID))
	_, _ = buf.Write(entry.digest[:])
	writeUvarint(&buf, uint64(entry.count))

	if entry.kind == entryPrepare {
		if entry.count != len(entry.records) {
			return nil, fmt.Errorf("formal: prepare record count mismatch")
		}
		for _, record := range entry.records {
			writeBytes(&buf, []byte(record.ID))
			writeBytes(&buf, record.Data)
		}
	} else if len(entry.records) != 0 {
		return nil, fmt.Errorf("formal: %s entry cannot carry records", entry.kind)
	}
	return buf.Bytes(), nil
}

func decodeEntryPayload(kind entryKind, payload []byte) (journalEntry, error) {
	reader := bytes.NewReader(payload)
	txnBytes, err := readBytes(reader)
	if err != nil {
		return journalEntry{}, err
	}
	if len(txnBytes) == 0 {
		return journalEntry{}, fmt.Errorf("empty transaction identifier")
	}
	entry := journalEntry{kind: kind, txnID: TxnID(txnBytes)}
	if _, err := io.ReadFull(reader, entry.digest[:]); err != nil {
		return journalEntry{}, fmt.Errorf("read digest: %w", err)
	}
	count, err := binary.ReadUvarint(reader)
	if err != nil {
		return journalEntry{}, fmt.Errorf("read record count: %w", err)
	}
	if count > maxRecordsPerTxn {
		return journalEntry{}, fmt.Errorf("record count too large: %d", count)
	}
	entry.count = int(count)

	if kind == entryPrepare {
		entry.records = make([]Record, 0, entry.count)
		for i := 0; i < entry.count; i++ {
			id, err := readBytes(reader)
			if err != nil {
				return journalEntry{}, fmt.Errorf("read record %d id: %w", i, err)
			}
			data, err := readBytes(reader)
			if err != nil {
				return journalEntry{}, fmt.Errorf("read record %d data: %w", i, err)
			}
			entry.records = append(entry.records, Record{ID: string(id), Data: data})
		}
		if err := validateRecords(entry.records); err != nil {
			return journalEntry{}, err
		}
	}
	if reader.Len() != 0 {
		return journalEntry{}, fmt.Errorf("%d trailing payload bytes", reader.Len())
	}
	return entry, nil
}

func writeUvarint(buf *bytes.Buffer, value uint64) {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], value)
	_, _ = buf.Write(tmp[:n])
}

func writeBytes(buf *bytes.Buffer, value []byte) {
	writeUvarint(buf, uint64(len(value)))
	_, _ = buf.Write(value)
}

func readBytes(reader *bytes.Reader) ([]byte, error) {
	length, err := binary.ReadUvarint(reader)
	if err != nil {
		return nil, err
	}
	if length > uint64(reader.Len()) {
		return nil, io.ErrUnexpectedEOF
	}
	value := make([]byte, int(length))
	if _, err := io.ReadFull(reader, value); err != nil {
		return nil, err
	}
	return value, nil
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("formal: open journal directory: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("formal: sync journal directory: %w", err)
	}
	return nil
}
