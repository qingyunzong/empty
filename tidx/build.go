package tidx

import (
	"io"
	"os"
)

// Build streams r and constructs the sidecar index. The reader is consumed
// exactly once; memory use is O(line count) for the records plus a small
// fixed buffer regardless of line length.
func Build(r io.Reader) (*Index, error) {
	lr := getLineReader(r)
	idx := &Index{}
	var prev [DigestSize]byte
	var off uint64
	for {
		n, _, digest, err := chainDigest(lr, prev)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if n > 1<<32-1 {
			// Line longer than uint32: still indexed, length saturated is
			// unacceptable, so fail loudly instead of corrupting the index.
			return nil, errLineTooLong
		}
		idx.Lines = append(idx.Lines, LineRec{
			Offset: off,
			Length: uint32(n),
			Digest: digest,
		})
		prev = digest
		off += uint64(n)
	}
	idx.FileSize = off
	idx.FinalDigest = prev
	return idx, nil
}

// BuildFile opens path read-only and builds its index. The file itself is
// never modified.
func BuildFile(path string) (*Index, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Build(f)
}

type stringError string

func (e stringError) Error() string { return string(e) }

const errLineTooLong = stringError("tidx: single line exceeds 4 GiB, cannot index")
