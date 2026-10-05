package auditlog

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DuplicateSeqError reports two frames that share a sequence number but
// carry different payloads. Rebuilding an index must fail in this case;
// identical duplicates (e.g. retried appends) are tolerated.
type DuplicateSeqError struct {
	Seq           uint64
	FirstOffset   int64
	SecondOffset  int64
	FirstPayload  []byte
	SecondPayload []byte
}

func (e *DuplicateSeqError) Error() string {
	return fmt.Sprintf("auditlog: duplicate seq %d with different payloads at offsets %d and %d",
		e.Seq, e.FirstOffset, e.SecondOffset)
}

// Index maps sequence numbers to frame offsets. It is a derived,
// best-effort structure: it is allowed to lag the log, and Rebuild can
// always reconstruct it from the log itself.
type Index struct {
	Offsets map[uint64]int64
	// Covered is the number of leading log bytes the index accounts for.
	Covered int64
}

// IndexPath returns the conventional index path for a log file.
func IndexPath(logPath string) string { return logPath + ".idx" }

// LoadIndex reads an index file. A missing index yields an empty one.
func LoadIndex(path string) (*Index, error) {
	idx := &Index{Offsets: make(map[uint64]int64)}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return nil, err
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if fields[0] == "covered" && len(fields) == 2 {
			v, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("auditlog: bad index line %d: %w", lineNo, err)
			}
			idx.Covered = v
			continue
		}
		if len(fields) != 2 {
			return nil, fmt.Errorf("auditlog: bad index line %d: %q", lineNo, line)
		}
		seq, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("auditlog: bad index line %d: %w", lineNo, err)
		}
		off, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("auditlog: bad index line %d: %w", lineNo, err)
		}
		idx.Offsets[seq] = off
	}
	return idx, sc.Err()
}

// Save writes the index atomically (temp file + rename).
func (idx *Index) Save(path string) error {
	var buf bytes.Buffer
	for seq, off := range idx.Offsets {
		fmt.Fprintf(&buf, "%d %d\n", seq, off)
	}
	fmt.Fprintf(&buf, "covered %d\n", idx.Covered)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Update folds one newly appended frame into the index. Callers may skip
// updates freely (the index is allowed to lag); Rebuild restores
// consistency. A conflicting duplicate seq is an error.
func (idx *Index) Update(e Entry) error {
	if off, ok := idx.Offsets[e.Seq]; ok && off != e.Offset {
		return &DuplicateSeqError{Seq: e.Seq, FirstOffset: off, SecondOffset: e.Offset}
	}
	idx.Offsets[e.Seq] = e.Offset
	return nil
}

// Rebuild scans the whole log and constructs a fresh index. It fails
// with *DuplicateSeqError if two frames share a sequence number but
// differ in payload, and with *CorruptError on checksum failures.
// An incomplete tail is ignored (it is not yet a committed frame).
func Rebuild(logPath string) (*Index, error) {
	entries, _, _, err := ScanFile(logPath)
	if err != nil {
		return nil, err
	}
	idx := &Index{Offsets: make(map[uint64]int64)}
	seen := make(map[uint64]Entry)
	var covered int64
	for _, e := range entries {
		if prev, ok := seen[e.Seq]; ok {
			if !bytes.Equal(prev.Payload, e.Payload) {
				return nil, &DuplicateSeqError{
					Seq:           e.Seq,
					FirstOffset:   prev.Offset,
					SecondOffset:  e.Offset,
					FirstPayload:  prev.Payload,
					SecondPayload: e.Payload,
				}
			}
			// Identical retry: keep the first offset.
			continue
		}
		seen[e.Seq] = e
		idx.Offsets[e.Seq] = e.Offset
	}
	if len(entries) > 0 {
		last := entries[len(entries)-1]
		covered = last.Offset + int64(HeaderLen+len(last.Payload)+CRCLen)
	}
	idx.Covered = covered
	return idx, nil
}
