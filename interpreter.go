package dataeng

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
)

// interpreter holds the per-window state. Every window builds a fresh
// interpreter, so the near ring, same table, baseline chunk cache and target
// are fully isolated between windows.
type interpreter struct {
	baseline Baseline
	window   *Window

	target []byte
	near   [4]int64
	same   [3][256]int64

	// chunk caches one baseline read so repeated byte fetches inside the same
	// region do not each touch ReaderAt. It resets with the interpreter.
	chunkStart int64
	chunk      []byte
	chunkValid bool
}

const baselineChunkSize = 4096

// dictionaryLen is S + len(target): the logical dictionary size at this point.
func (it *interpreter) dictionaryLen() int64 {
	n, ok := add64(it.window.Span, int64(len(it.target)))
	if !ok {
		panic("dataeng: internal dictionary length overflow")
	}
	return n
}

// readByte returns the dictionary byte at address a. Addresses [0, S) map to
// the baseline interval; addresses [S, S+len(target)) map to the growing
// target. The check runs on every fetched byte, so a COPY whose source reaches
// into the bytes it is currently producing works byte by byte, while any
// position that does not exist yet is rejected.
func (it *interpreter) readByte(a int64) (byte, error) {
	if a < 0 {
		return 0, fmt.Errorf("%w: negative address %d", ErrAddress, a)
	}
	if a >= it.dictionaryLen() {
		return 0, fmt.Errorf("%w: address %d has no byte yet (dictionary len %d)",
			ErrAddress, a, it.dictionaryLen())
	}

	if a < it.window.Span {
		return it.readBaselineByte(a)
	}
	targetIndex, ok := sub64(a, it.window.Span)
	if !ok {
		return 0, fmt.Errorf("%w: target index overflow at %d", ErrOverflow, a)
	}
	return it.target[targetIndex], nil
}

// readBaselineByte serves one baseline-interval byte through a small cache.
func (it *interpreter) readBaselineByte(intervalAddress int64) (byte, error) {
	absolute, ok := add64(it.window.BaseOffset, intervalAddress)
	if !ok {
		return 0, fmt.Errorf("%w: baseline offset overflow at %d", ErrOverflow, intervalAddress)
	}

	if it.chunkValid &&
		absolute >= it.chunkStart &&
		absolute < it.chunkStart+int64(len(it.chunk)) {
		return it.chunk[absolute-it.chunkStart], nil
	}

	chunkStart := absolute - absolute%baselineChunkSize
	remaining, ok := sub64(it.baseline.Length, chunkStart)
	if !ok || remaining <= 0 {
		return 0, fmt.Errorf("%w: baseline cache offset %d", ErrOverflow, chunkStart)
	}
	size := int64(baselineChunkSize)
	if remaining < size {
		size = remaining
	}
	buf := make([]byte, size)
	n, err := it.baseline.ReaderAt.ReadAt(buf, chunkStart)
	if err != nil && !(n == int(size) && isEOF(err)) {
		return 0, fmt.Errorf("dataeng: baseline read failed: %w", err)
	}
	if n != int(size) {
		return 0, fmt.Errorf("dataeng: baseline short read at %d: got %d want %d",
			chunkStart, n, size)
	}
	it.chunkStart = chunkStart
	it.chunk = buf
	it.chunkValid = true
	return buf[absolute-chunkStart], nil
}

// resolve fixes the dictionary address for one COPY. On success it advances
// the near ring and writes the same table exactly once, before any source byte
// is read, matching the specified update order.
func (it *interpreter) resolve(c Copy) (int64, error) {
	var address int64
	switch c.Mode {
	case CopySelf:
		address = c.Operand

	case CopyHere:
		base, ok := add64(it.window.Span, int64(len(it.target)))
		if !ok {
			return 0, fmt.Errorf("%w: HERE base overflow", ErrOverflow)
		}
		a, ok := sub64(base, c.Operand)
		if !ok || a < 0 {
			return 0, fmt.Errorf("%w: HERE resolves negative at operand %d", ErrAddress, c.Operand)
		}
		address = a

	case CopyNear:
		a, ok := add64(it.near[c.OperandSlot], c.Operand)
		if !ok {
			return 0, fmt.Errorf("%w: NEAR overflow", ErrOverflow)
		}
		if a < 0 {
			return 0, fmt.Errorf("%w: NEAR resolves negative", ErrAddress)
		}
		address = a

	case CopySame:
		address = it.same[c.OperandSlot][c.Operand]

	default:
		return 0, fmt.Errorf("%w: %d", ErrBadMode, c.Mode)
	}

	if address < 0 || address >= it.dictionaryLen() {
		return 0, fmt.Errorf("%w: resolved address %d outside dictionary len %d",
			ErrAddress, address, it.dictionaryLen())
	}

	it.near[0], it.near[1], it.near[2], it.near[3] =
		it.near[1], it.near[2], it.near[3], address

	flat := address % 768
	if flat < 0 {
		return 0, fmt.Errorf("%w: same index negative", ErrAddress)
	}
	row := flat / 256
	col := flat % 256
	it.same[row][col] = address

	return address, nil
}

// appendByte extends the target, enforcing the per-window and total limits
// before each byte.
func (it *interpreter) appendByte(ctx context.Context, limits Limits, total int64, b byte) (int64, error) {
	if int64(len(it.target)) >= it.window.TargetLength {
		return total, fmt.Errorf("%w: window %q overran T=%d", ErrLength, it.window.ID, it.window.TargetLength)
	}
	next, ok := add64(total, 1)
	if !ok {
		return total, fmt.Errorf("%w: total output overflow", ErrOverflow)
	}
	if limits.MaxTotalBytes > 0 && next > limits.MaxTotalBytes {
		return total, fmt.Errorf("%w: total output would exceed %d", ErrLimit, limits.MaxTotalBytes)
	}
	it.target = append(it.target, b)
	return next, nil
}

// runWindow interprets one window and returns its target plus SHA256. It never
// touches the store, so a failure leaves no partial resource behind.
func runWindow(ctx context.Context, b Baseline, w *Window, limits Limits, total int64) ([]byte, [32]byte, error) {
	it := &interpreter{
		baseline: b,
		window:   w,
		target:   make([]byte, 0, boundedCap(w.TargetLength, limits.MaxWindowBytes)),
	}

	for idx, ins := range w.Instructions {
		if err := ctx.Err(); err != nil {
			return nil, [32]byte{}, err
		}
		switch op := ins.(type) {
		case Add:
			for _, b := range op.Bytes {
				var err error
				total, err = it.appendByte(ctx, limits, total, b)
				if err != nil {
					return nil, [32]byte{}, err
				}
			}

		case Run:
			var count int64
			for count < op.Count {
				var err error
				total, err = it.appendByte(ctx, limits, total, op.Byte)
				if err != nil {
					return nil, [32]byte{}, err
				}
				count++
			}

		case Copy:
			address, err := it.resolve(op)
			if err != nil {
				return nil, [32]byte{}, fmt.Errorf("window %q COPY[%d]: %w", w.ID, idx, err)
			}
			var copied int64
			for copied < op.Length {
				source, ok := add64(address, copied)
				if !ok {
					return nil, [32]byte{}, fmt.Errorf("window %q COPY[%d]: %w", w.ID, idx, ErrOverflow)
				}
				value, err := it.readByte(source)
				if err != nil {
					return nil, [32]byte{}, fmt.Errorf("window %q COPY[%d]: %w", w.ID, idx, err)
				}
				total, err = it.appendByte(ctx, limits, total, value)
				if err != nil {
					return nil, [32]byte{}, err
				}
				copied++
			}

		default:
			return nil, [32]byte{}, fmt.Errorf("%w: %T", ErrUnknownInstruction, ins)
		}
	}

	if int64(len(it.target)) != w.TargetLength {
		return nil, [32]byte{}, fmt.Errorf("%w: window %q produced %d bytes, T=%d",
			ErrLength, w.ID, len(it.target), w.TargetLength)
	}

	digest := sha256.Sum256(it.target)
	if digest != w.TargetSHA256 {
		return nil, [32]byte{}, fmt.Errorf("%w: window %q", ErrTargetDigest, w.ID)
	}
	return it.target, digest, nil
}

func boundedCap(targetLength, maxWindow int64) int {
	capHint := targetLength
	if maxWindow > 0 && maxWindow < capHint {
		capHint = maxWindow
	}
	if capHint > 1<<30 {
		return 1 << 30
	}
	return int(capHint)
}

func isEOF(err error) bool {
	return err == io.EOF
}
