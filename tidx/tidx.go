// Package tidx builds and verifies sidecar ("旁路") trajectory indexes for
// log files. An index records, for every line, its byte offset, byte length
// and a chained SHA-256 prefix digest:
//
//	digest[i] = SHA-256(digest[i-1] || lineBytes[i])   (digest[-1] = 32 zero bytes)
//
// The chain makes verification incremental: lines are re-hashed one at a
// time and the first line whose digest does not match the stored value
// marks the first untrusted interval; everything before it is trusted.
//
// All processing is streaming with a fixed-size buffer, so multi-byte
// (UTF-8) logs, a final line without a trailing newline, and arbitrarily
// long lines are handled without loading the file into memory. Splitting
// on the '\n' byte is UTF-8 safe because 0x0A never appears inside a
// multi-byte UTF-8 sequence.
package tidx

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Magic identifies the sidecar index format.
const Magic = "TIDX"

// Version is the on-disk format version.
const Version = 1

// DigestSize is the size of a chained digest in bytes.
const DigestSize = sha256.Size

// headerSize is the fixed header size in bytes:
// magic(4) + version(2) + flags(2) + fileSize(8) + lineCount(8) + finalDigest(32).
const headerSize = 4 + 2 + 2 + 8 + 8 + DigestSize

// recordSize is the fixed per-line record size:
// offset(8) + length(4) + digest(32).
const recordSize = 8 + 4 + DigestSize

// LineRec describes one indexed line.
type LineRec struct {
	Offset uint64           // byte offset of the line in the original file
	Length uint32           // byte length, including the trailing '\n' if present
	Digest [DigestSize]byte // chain digest after this line
}

// Index is the in-memory form of a sidecar trajectory index.
type Index struct {
	FileSize    uint64 // size of the original file when indexed
	Lines       []LineRec
	FinalDigest [DigestSize]byte // chain digest after the last line (zeros if empty)
}

// LineCount returns the number of indexed lines.
func (idx *Index) LineCount() uint64 { return uint64(len(idx.Lines)) }

// Encode serializes the index in the binary sidecar format.
func (idx *Index) Encode() []byte {
	buf := make([]byte, 0, headerSize+len(idx.Lines)*recordSize)
	hdr := make([]byte, headerSize)
	copy(hdr[0:4], Magic)
	binary.LittleEndian.PutUint16(hdr[4:6], Version)
	binary.LittleEndian.PutUint16(hdr[6:8], 0) // flags, reserved
	binary.LittleEndian.PutUint64(hdr[8:16], idx.FileSize)
	binary.LittleEndian.PutUint64(hdr[16:24], uint64(len(idx.Lines)))
	copy(hdr[24:56], idx.FinalDigest[:])
	buf = append(buf, hdr...)
	rec := make([]byte, recordSize)
	for _, ln := range idx.Lines {
		binary.LittleEndian.PutUint64(rec[0:8], ln.Offset)
		binary.LittleEndian.PutUint32(rec[8:12], ln.Length)
		copy(rec[12:44], ln.Digest[:])
		buf = append(buf, rec...)
	}
	return buf
}

// Decode parses a serialized index.
func Decode(data []byte) (*Index, error) {
	if len(data) < headerSize {
		return nil, errors.New("tidx: index too short")
	}
	if string(data[0:4]) != Magic {
		return nil, errors.New("tidx: bad magic")
	}
	if v := binary.LittleEndian.Uint16(data[4:6]); v != Version {
		return nil, fmt.Errorf("tidx: unsupported version %d", v)
	}
	idx := &Index{
		FileSize: binary.LittleEndian.Uint64(data[8:16]),
	}
	lineCount := binary.LittleEndian.Uint64(data[16:24])
	copy(idx.FinalDigest[:], data[24:56])
	if lineCount > (uint64(len(data))-headerSize)/recordSize {
		return nil, errors.New("tidx: truncated index records")
	}
	idx.Lines = make([]LineRec, lineCount)
	off := headerSize
	for i := range idx.Lines {
		idx.Lines[i].Offset = binary.LittleEndian.Uint64(data[off : off+8])
		idx.Lines[i].Length = binary.LittleEndian.Uint32(data[off+8 : off+12])
		copy(idx.Lines[i].Digest[:], data[off+12:off+44])
		off += recordSize
	}
	return idx, nil
}

// WriteFile serializes the index and atomically writes it to path.
// The original log file is never touched: the index is pure sidecar data.
func (idx *Index) WriteFile(path string) error {
	return writeFileAtomic(path, idx.Encode())
}

// ReadFile loads a sidecar index from path.
func ReadFile(path string) (*Index, error) {
	data, err := readFileAll(path)
	if err != nil {
		return nil, err
	}
	return Decode(data)
}

// nextLine streams one line from r into w (which may be nil) and returns
// the line's byte length and whether it was terminated by '\n'. It uses
// bufio ReadSlice semantics via the lineReader so arbitrarily long lines
// are processed in fixed-size fragments. io.EOF is returned only when no
// bytes remain at all.
func nextLine(r io.Reader, w io.Writer) (n int64, eol bool, err error) {
	lr := getLineReader(r)
	for {
		frag, ferr := lr.ReadSlice('\n')
		if len(frag) > 0 {
			if w != nil {
				if _, werr := w.Write(frag); werr != nil {
					return n, false, werr
				}
			}
			n += int64(len(frag))
		}
		switch ferr {
		case nil:
			return n, true, nil
		case errBufferFull:
			continue // long line: keep streaming fragments
		case io.EOF:
			if n > 0 {
				return n, false, nil // final line without trailing newline
			}
			return 0, false, io.EOF
		default:
			return n, false, ferr
		}
	}
}

// chainDigest computes SHA-256(prev || lineBytes) by streaming the line
// from r into the hasher. Returns the line length, newline flag and digest.
func chainDigest(r io.Reader, prev [DigestSize]byte) (n int64, eol bool, digest [DigestSize]byte, err error) {
	h := sha256.New()
	h.Write(prev[:])
	n, eol, err = nextLine(r, h)
	if err != nil {
		return n, eol, digest, err
	}
	copy(digest[:], h.Sum(nil))
	return n, eol, digest, nil
}
