package dataeng

import (
	"fmt"
	"sort"
	"sync"
)

// BitRange is a half-open range [Start,End) of bits in the compressed payload.
// Payload bit zero is the most significant bit of the first byte after the
// 13-byte header.
type BitRange struct {
	Start uint64
	End   uint64
}

// QueryStats reports the work actually performed by one query.  Payload ranges
// cover only compressed bits that were read; skipped ordinal fields are not
// reported as reads.
type QueryStats struct {
	BlockHeadersRead uint64
	BlocksDecoded    uint64
	CacheHits        uint64
	PayloadBitRanges []BitRange
}

func (s *QueryStats) recordHeader(start, end uint64) {
	s.BlockHeadersRead++
	s.recordRange(start, end)
}

func (s *QueryStats) recordRange(start, end uint64) {
	if start >= end {
		return
	}
	n := len(s.PayloadBitRanges)
	if n > 0 {
		last := &s.PayloadBitRanges[n-1]
		if start <= last.End {
			if end > last.End {
				last.End = end
			}
			return
		}
	}
	s.PayloadBitRanges = append(s.PayloadBitRanges, BitRange{Start: start, End: end})
}

type checkpoint struct {
	block            uint64
	logicalStart     uint64
	payloadBitOffset uint64
	onesBefore       uint64
}

func (c checkpoint) zerosBefore() uint64 {
	return c.logicalStart - c.onesBefore
}

// CheckpointInfo is read-only metadata for one directory entry.  Offset is a
// bit offset into the compressed payload.
type CheckpointInfo struct {
	Block            uint64
	LogicalStart     uint64
	PayloadBitOffset uint64
	OnesBefore       uint64
}

type blockCache struct {
	valid   bool
	block   uint64
	m       uint8
	c       uint8
	pattern uint64
}

type blockHeader struct {
	c            int
	classEnd     uint64
	ordinalWidth uint
	next         uint64
}

// Index is an immutable compressed snapshot plus its checkpoint directory and
// a single-entry decoded block cache.  Query methods are safe for concurrent
// use.
type Index struct {
	b       int
	s       uint32
	n       uint64
	payload []byte
	total   uint64
	dir     []checkpoint

	mu    sync.Mutex
	cache blockCache
}

// Len returns the logical sequence length N.
func (ix *Index) Len() uint64 { return ix.n }

// TotalOnes returns the total number of one bits in the logical sequence.
func (ix *Index) TotalOnes() uint64 { return ix.total }

// TotalZeros returns the total number of zero bits in the logical sequence.
func (ix *Index) TotalZeros() uint64 { return ix.n - ix.total }

// BlockWidth returns b.
func (ix *Index) BlockWidth() int { return ix.b }

// CheckpointInterval returns S.
func (ix *Index) CheckpointInterval() int { return int(ix.s) }

// BlockCount returns ceil(N/b).
func (ix *Index) BlockCount() uint64 {
	return (ix.n + uint64(ix.b) - 1) / uint64(ix.b)
}

// CheckpointCount returns the number of directory entries.
func (ix *Index) CheckpointCount() int { return len(ix.dir) }

// CheckpointAt returns directory entry i, if it exists.
func (ix *Index) CheckpointAt(i int) (CheckpointInfo, bool) {
	if i < 0 || i >= len(ix.dir) {
		return CheckpointInfo{}, false
	}
	cp := ix.dir[i]
	return CheckpointInfo{
		Block:            cp.block,
		LogicalStart:     cp.logicalStart,
		PayloadBitOffset: cp.payloadBitOffset,
		OnesBefore:       cp.onesBefore,
	}, true
}

func (ix *Index) blockLen(block uint64) int {
	remaining := ix.n - block*uint64(ix.b)
	if remaining > uint64(ix.b) {
		return ix.b
	}
	return int(remaining)
}

func (ix *Index) checkpointForBlock(block uint64) checkpoint {
	return ix.dir[block/uint64(ix.s)]
}

func (ix *Index) scanHeader(off uint64, m int, stats *QueryStats) (blockHeader, error) {
	cb := classWidth(ix.b)
	classValue, err := readBits(ix.payload, off, cb)
	if err != nil {
		return blockHeader{}, err
	}
	c := int(classValue)
	if c > m {
		return blockHeader{}, fmt.Errorf("%w: c=%d > m=%d", ErrMalformedPayload, c, m)
	}
	stats.recordHeader(off, off+uint64(cb))

	combinations := binomial(m, c)
	width := minWidth(combinations)
	return blockHeader{
		c:            c,
		classEnd:     off + uint64(cb),
		ordinalWidth: width,
		next:         off + uint64(cb) + uint64(width),
	}, nil
}

func (ix *Index) decodeBlock(block uint64, m int, h blockHeader, stats *QueryStats) (uint64, error) {
	if ix.cache.valid &&
		ix.cache.block == block &&
		int(ix.cache.m) == m &&
		int(ix.cache.c) == h.c {
		stats.CacheHits++
		return ix.cache.pattern, nil
	}

	var ordinal uint64
	if h.ordinalWidth > 0 {
		value, err := readBits(ix.payload, h.classEnd, h.ordinalWidth)
		if err != nil {
			return 0, err
		}
		ordinal = value
		stats.recordRange(h.classEnd, h.classEnd+uint64(h.ordinalWidth))
	}
	pattern, err := unrankOrdinal(m, h.c, ordinal)
	if err != nil {
		return 0, err
	}

	stats.BlocksDecoded++
	ix.cache = blockCache{
		valid:   true,
		block:   block,
		m:       uint8(m),
		c:       uint8(h.c),
		pattern: pattern,
	}
	return pattern, nil
}

// Access returns the logical bit at zero-based position i.
func (ix *Index) Access(i uint64) (uint8, error) {
	bit, _, err := ix.AccessWithStats(i)
	return bit, err
}

// AccessWithStats is Access with an exact report of headers read, blocks
// decoded, cache hits and compressed payload bit ranges.
func (ix *Index) AccessWithStats(i uint64) (uint8, QueryStats, error) {
	var stats QueryStats
	if i >= ix.n {
		return 0, stats, fmt.Errorf("%w: Access(%d) with N=%d", ErrOutOfRange, i, ix.n)
	}

	ix.mu.Lock()
	defer ix.mu.Unlock()

	block := i / uint64(ix.b)
	cp := ix.checkpointForBlock(block)
	off := cp.payloadBitOffset

	// Skip complete blocks between the checkpoint and the target.  Reading the
	// class is enough to know how wide the unread ordinal is.
	for blockIdx := cp.block; blockIdx < block; blockIdx++ {
		m := ix.blockLen(blockIdx)
		h, err := ix.scanHeader(off, m, &stats)
		if err != nil {
			return 0, stats, err
		}
		off = h.next
	}

	m := ix.blockLen(block)
	h, err := ix.scanHeader(off, m, &stats)
	if err != nil {
		return 0, stats, err
	}
	pattern, err := ix.decodeBlock(block, m, h, &stats)
	if err != nil {
		return 0, stats, err
	}
	j := int(i - block*uint64(ix.b))
	return uint8((pattern >> uint(m-1-j)) & 1), stats, nil
}

// Rank1 returns the number of one bits in the half-open prefix [0,end).
func (ix *Index) Rank1(end uint64) (uint64, error) {
	rank, _, err := ix.Rank1WithStats(end)
	return rank, err
}

// Rank1WithStats is Rank1 with exact query work statistics.
func (ix *Index) Rank1WithStats(end uint64) (uint64, QueryStats, error) {
	var stats QueryStats
	if end > ix.n {
		return 0, stats, fmt.Errorf("%w: Rank1(%d) with N=%d", ErrOutOfRange, end, ix.n)
	}
	if end == 0 {
		return 0, stats, nil
	}

	ix.mu.Lock()
	defer ix.mu.Unlock()

	lastBlock := (end - 1) / uint64(ix.b)
	cp := ix.checkpointForBlock(lastBlock)
	off := cp.payloadBitOffset
	count := cp.onesBefore

	for blockIdx := cp.block; blockIdx <= lastBlock; blockIdx++ {
		m := ix.blockLen(blockIdx)
		h, err := ix.scanHeader(off, m, &stats)
		if err != nil {
			return 0, stats, err
		}
		if blockIdx < lastBlock {
			count += uint64(h.c)
			off = h.next
			continue
		}

		within := int(end - blockIdx*uint64(ix.b))
		if within == m {
			count += uint64(h.c)
			break
		}
		pattern, err := ix.decodeBlock(blockIdx, m, h, &stats)
		if err != nil {
			return 0, stats, err
		}
		count += patternOnesUpTo(pattern, m, within)
		break
	}
	return count, stats, nil
}

// Rank0 returns the number of zero bits in the half-open prefix [0,end).
func (ix *Index) Rank0(end uint64) (uint64, error) {
	rank, _, err := ix.Rank0WithStats(end)
	return rank, err
}

// Rank0WithStats is Rank0 with exact query work statistics.
func (ix *Index) Rank0WithStats(end uint64) (uint64, QueryStats, error) {
	ones, stats, err := ix.Rank1WithStats(end)
	if err != nil {
		return 0, stats, err
	}
	return end - ones, stats, nil
}

// Select1 returns the zero-based position of the k-th one bit.  If k is
// negative an error is returned.  If k is at least the total number of ones,
// found is false and pos is zero.
func (ix *Index) Select1(k int64) (pos uint64, found bool, err error) {
	pos, found, _, err = ix.selectWithStats(k, true)
	return pos, found, err
}

// Select1WithStats is Select1 with exact query work statistics.
func (ix *Index) Select1WithStats(k int64) (pos uint64, found bool, stats QueryStats, err error) {
	return ix.selectWithStats(k, true)
}

// Select0 returns the zero-based position of the k-th zero bit.  If k is
// negative an error is returned.  If k is at least the total number of zeros,
// found is false and pos is zero.
func (ix *Index) Select0(k int64) (pos uint64, found bool, err error) {
	pos, found, _, err = ix.selectWithStats(k, false)
	return pos, found, err
}

// Select0WithStats is Select0 with exact query work statistics.
func (ix *Index) Select0WithStats(k int64) (pos uint64, found bool, stats QueryStats, err error) {
	return ix.selectWithStats(k, false)
}

func (ix *Index) selectWithStats(k int64, wantOne bool) (uint64, bool, QueryStats, error) {
	var stats QueryStats
	if k < 0 {
		return 0, false, stats, fmt.Errorf("%w: negative select index %d", ErrOutOfRange, k)
	}

	total := ix.total
	if !wantOne {
		total = ix.n - ix.total
	}
	if uint64(k) >= total {
		return 0, false, stats, nil
	}

	ix.mu.Lock()
	defer ix.mu.Unlock()

	target := uint64(k)
	// Rightmost checkpoint whose cumulative relevant count is <= k.  Taking
	// the rightmost entry is essential when several checkpoints share the
	// same cumulative rank.
	dirIndex := sort.Search(len(ix.dir), func(i int) bool {
		base := ix.dir[i].onesBefore
		if !wantOne {
			base = ix.dir[i].zerosBefore()
		}
		return base > target
	}) - 1
	if dirIndex < 0 {
		return 0, false, stats, fmt.Errorf("%w: select directory start", ErrMalformedPayload)
	}

	cp := ix.dir[dirIndex]
	off := cp.payloadBitOffset
	count := cp.onesBefore
	if !wantOne {
		count = cp.zerosBefore()
	}

	endBlock := cp.block + uint64(ix.s)
	if blockCount := ix.BlockCount(); endBlock > blockCount {
		endBlock = blockCount
	}

	for blockIdx := cp.block; blockIdx < endBlock; blockIdx++ {
		m := ix.blockLen(blockIdx)
		h, err := ix.scanHeader(off, m, &stats)
		if err != nil {
			return 0, false, stats, err
		}

		relevant := h.c
		if !wantOne {
			relevant = m - h.c
		}
		if count+uint64(relevant) > target {
			pattern, err := ix.decodeBlock(blockIdx, m, h, &stats)
			if err != nil {
				return 0, false, stats, err
			}
			local := int(target - count)
			j, ok := selectInPattern(pattern, m, local, wantOne)
			if !ok {
				return 0, false, stats, fmt.Errorf(
					"%w: block %d lacks selected bit %d", ErrMalformedPayload, blockIdx, local)
			}
			return blockIdx*uint64(ix.b) + uint64(j), true, stats, nil
		}

		count += uint64(relevant)
		off = h.next
	}

	return 0, false, stats, fmt.Errorf("%w: select scan ended before rank %d", ErrMalformedPayload, target)
}
