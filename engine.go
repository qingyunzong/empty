package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding"
	"encoding/binary"
	"hash"
)

// Callback 在每个完整逻辑记录闭合且 CRC 全部通过后被调用。
// 回调返回非 nil 错误会立即终止读取，之后不会颁发包含该记录的检查点。
type Callback func(rec Record) error

// engine 是与输入切块方式无关的流式状态机。任意大小的字节块按物理顺序通过
// feed 喂入；引擎只保留凑不齐下一头/载荷的残字节，绝不缓存声明巨量的数据。
// 输入结束时调用 finish 统一裁决 EOF 残尾。
type engine struct {
	mode        Mode
	limitRecord int
	limitTotal  int64
	cb          Callback

	// hasher 吸收全部已读字节；cpHasher 只吸收到最近确认边界的前缀，
	// 每次确认时从 hasher 的编码状态克隆，保证检查点摘要稳定不随后续读取漂移。
	hasher   hash.Hash
	cpHasher hash.Hash
	pos      int64

	// 尚未形成完整头/载荷的残字节，bufStart 是 buf[0] 的物理偏移。
	buf      []byte
	bufStart int64

	assembling bool
	logStart   int64
	payload    []byte
	ranges     []PayloadRange

	totalDelivered int64
	confirmed      int64
	cpPos          int64
	cpHash         [32]byte

	verifyOnly bool
	terminated bool
}

func newEngine(mode Mode, maxRecord int, maxTotal int64, cb Callback, hasher hash.Hash) *engine {
	if hasher == nil {
		hasher = sha256.New()
	}
	e := &engine{
		mode:        mode,
		limitRecord: maxRecord,
		limitTotal:  maxTotal,
		cb:          cb,
		hasher:      hasher,
		cpHasher:    sha256.New(),
	}
	e.cpHash = sha256.Sum256(nil)
	return e
}

func (e *engine) fail(kind ErrorKind, offset int64, cause error) *Error {
	e.terminated = true
	return &Error{Kind: kind, Offset: offset, Err: cause}
}

// feed 处理一个任意长度的输入块。返回的整数是本次已并入状态机的字节数；
// 未消费的残字节由引擎自持，调用方无需保留。
func (e *engine) feed(ctx context.Context, chunk []byte) (int, error) {
	consumed := 0

	// 合并历史残字节。残字节至多为一个完整片（头+载荷），因此不会无界增长。
	if len(e.buf) > 0 {
		merged := make([]byte, 0, len(e.buf)+len(chunk))
		merged = append(merged, e.buf...)
		merged = append(merged, chunk...)
		e.buf = nil
		chunk = merged
	}

	for len(chunk) > 0 {
		if err := ctx.Err(); err != nil {
			e.buf = append(e.buf, chunk...)
			return consumed, err
		}

		curPos := e.pos // 下一个待处理字节的物理偏移（历史残字节已在合并前置零）
		blockLeft := BlockSize - int(curPos%BlockSize)

		if blockLeft < HeaderSize {
			// 块内不足 7 字节的尾部：必须全零并跳过到块边界。
			n := blockLeft
			if n > len(chunk) {
				break // 等更多输入或 EOF 再核验全零
			}
			if off, ok := firstNonZero(chunk[:n]); ok {
				return consumed, e.fail(ErrBadPadding, curPos+int64(off), errBadPadding)
			}
			e.absorb(chunk[:n])
			consumed += n
			chunk = chunk[n:]
			continue
		}

		if len(chunk) < HeaderSize {
			break
		}

		hdrOff := curPos
		maskedCRC := binary.LittleEndian.Uint32(chunk[0:4])
		length := int(binary.LittleEndian.Uint16(chunk[4:6]))
		typ := FragmentType(chunk[6])

		if typ == Zero {
			// 完整零头：当前块剩余部分必须全零填充，不能当作空记录。
			n := blockLeft
			if n > len(chunk) {
				break // 等填满块剩余部分再核验
			}
			if off, ok := firstNonZero(chunk[:n]); ok {
				return consumed, e.fail(ErrBadPadding, hdrOff+int64(off), errBadPadding)
			}
			e.absorb(chunk[:n])
			consumed += n
			chunk = chunk[n:]
			continue
		}

		if typ < Full || typ > Last {
			return consumed, e.fail(ErrIllegalType, hdrOff, errIllegalType)
		}

		if length+HeaderSize > blockLeft {
			return consumed, e.fail(ErrBlockOverrun, hdrOff, errBlockOverrun)
		}

		if len(chunk) < HeaderSize+length {
			break
		}

		frag := chunk[HeaderSize : HeaderSize+length]
		if fragmentCRC(typ, frag) != maskedCRC {
			return consumed, e.fail(ErrCRC, hdrOff, errCRC)
		}

		n := HeaderSize + length
		e.absorb(chunk[:n])
		consumed += n
		if err := e.accept(ctx, typ, frag, hdrOff); err != nil {
			return consumed, err
		}
		chunk = chunk[n:]
	}

	if len(chunk) > 0 {
		// 残字节的物理起点是当前位置（已吸收部分都推进了 pos）。
		e.bufStart = e.pos
		e.buf = append(e.buf, chunk...)
	}
	return consumed, nil
}

// accept 在 CRC 通过后执行片序检查、载荷拼装与闭合交付。
func (e *engine) accept(ctx context.Context, typ FragmentType, frag []byte, hdrOff int64) error {
	payloadStart := hdrOff + HeaderSize

	switch typ {
	case Full:
		if e.assembling {
			return e.fail(ErrSequence, hdrOff, errSequence)
		}
		if e.limitRecord > 0 && len(frag) > e.limitRecord {
			return e.fail(ErrRecordTooLarge, hdrOff, errRecordTooLarge)
		}
		return e.deliver(ctx, frag, hdrOff, []PayloadRange{{Start: payloadStart, Length: int64(len(frag))}})

	case First:
		if e.assembling {
			return e.fail(ErrSequence, hdrOff, errSequence)
		}
		if e.limitRecord > 0 && len(frag) > e.limitRecord {
			return e.fail(ErrRecordTooLarge, hdrOff, errRecordTooLarge)
		}
		e.assembling = true
		e.logStart = hdrOff
		e.payload = append(e.payload[:0], frag...)
		e.ranges = append(e.ranges[:0], PayloadRange{Start: payloadStart, Length: int64(len(frag))})
		return nil

	case Middle:
		if !e.assembling {
			return e.fail(ErrSequence, hdrOff, errSequence)
		}
		if e.limitRecord > 0 && len(e.payload)+len(frag) > e.limitRecord {
			return e.fail(ErrRecordTooLarge, e.logStart, errRecordTooLarge)
		}
		e.payload = append(e.payload, frag...)
		e.ranges = append(e.ranges, PayloadRange{Start: payloadStart, Length: int64(len(frag))})
		return nil

	case Last:
		if !e.assembling {
			return e.fail(ErrSequence, hdrOff, errSequence)
		}
		if e.limitRecord > 0 && len(e.payload)+len(frag) > e.limitRecord {
			return e.fail(ErrRecordTooLarge, e.logStart, errRecordTooLarge)
		}
		payload := append(e.payload, frag...)
		ranges := append(e.ranges, PayloadRange{Start: payloadStart, Length: int64(len(frag))})
		logStart := e.logStart
		e.assembling = false
		e.payload = e.payload[:0]
		e.ranges = e.ranges[:0]
		return e.deliver(ctx, payload, logStart, ranges)

	default:
		return e.fail(ErrIllegalType, hdrOff, errIllegalType)
	}
}

// deliver 执行总产出限制与回调，并在确认成功后推进检查点边界。
func (e *engine) deliver(ctx context.Context, payload []byte, logStart int64, ranges []PayloadRange) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.limitTotal > 0 && e.totalDelivered+int64(len(payload)) > e.limitTotal {
		return e.fail(ErrTotalLimit, logStart, errTotalLimit)
	}

	if !e.verifyOnly && e.cb != nil {
		rec := Record{
			Payload:      payload,
			LogicalStart: logStart,
			Ranges:       ranges,
		}
		if err := e.cb(rec); err != nil {
			return e.fail(ErrCallback, logStart, err)
		}
	}

	e.totalDelivered += int64(len(payload))
	if !e.verifyOnly {
		e.confirmed++
	}

	// 检查点覆盖到该记录最后一个片载荷的物理末尾；ranges 至少含一个区间。
	last := ranges[len(ranges)-1]
	e.cpPos = last.Start + last.Length
	cloneHasher(e.hasher, e.cpHasher)
	copy(e.cpHash[:], e.cpHasher.Sum(nil))
	return nil
}

// cloneHasher 把 src 的内部状态复制到 dst，使两者在同一字节前缀上给出相同摘要。
// 标准库 sha256.digest 实现 encoding.BinaryMarshaler/Unmarshaler。
func cloneHasher(src, dst hash.Hash) {
	marshaler, ok := src.(encoding.BinaryMarshaler)
	if !ok {
		// 兜底：理论上不会发生，标准库 SHA256 始终支持状态编解码。
		dst.Reset()
		return
	}
	state, err := marshaler.MarshalBinary()
	if err != nil {
		dst.Reset()
		return
	}
	if unmarshaler, ok := dst.(encoding.BinaryUnmarshaler); ok {
		if err := unmarshaler.UnmarshalBinary(state); err != nil {
			dst.Reset()
		}
	}
}

// finish 在真实 EOF 裁决残尾与未闭合记录，返回恢复模式下的截断报告。
func (e *engine) finish() (*Truncation, *Error) {
	if e.terminated {
		return nil, nil
	}

	// 1) 裁决残字节。残字节要么是全零填充（合法），要么是真实截断的残头/残载荷。
	if len(e.buf) > 0 {
		start := e.bufStart
		tail := e.buf

		if off, ok := firstNonZero(tail); ok {
			// 含非零字节：不可能是零填充。区分残头与残载荷。
			kind := ErrTruncatedHeader
			cause := errTruncatedHeader
			reason := TruncatedHeader
			relPos := int64(0)

			if len(tail) >= HeaderSize {
				typ := FragmentType(tail[6])
				if typ == Zero {
					// 零头要求块剩余部分全零，但出现了非零字节。
					return nil, e.fail(ErrBadPadding, start+int64(off), errBadPadding)
				}
				if typ < Full || typ > Last {
					return nil, e.fail(ErrIllegalType, start, errIllegalType)
				}
				// 完整头但载荷未到齐：残载荷。
				kind = ErrTruncatedPayload
				cause = errTruncatedPayload
				reason = TruncatedPayload
				relPos = HeaderSize
			}

			if e.mode == Strict {
				return nil, e.fail(kind, start+relPos, cause)
			}

			logStart := start
			if e.assembling && e.logStart < logStart {
				logStart = e.logStart
			}
			e.discardBuf()
			e.resetAssembly()
			return &Truncation{
				Reason:       reason,
				LogicalStart: logStart,
				BytesDropped: e.pos - logStart,
			}, nil
		}

		// 全零残尾：合法填充（不足 7 字节的块尾，或零头后的零填充的前缀）。
		e.absorb(tail)
		e.buf = nil
	}

	// 2) 裁决未闭合的逻辑记录。
	if e.assembling {
		start := e.logStart
		if e.mode == Strict {
			return nil, e.fail(ErrUnclosedRecord, start, errUnclosedRecord)
		}
		e.resetAssembly()
		return &Truncation{
			Reason:       UnclosedRecord,
			LogicalStart: start,
			BytesDropped: e.pos - start,
		}, nil
	}
	return nil, nil
}

func (e *engine) discardBuf() {
	// 恢复模式丢弃的真实残尾仍计入已读取前缀哈希，保证位置与摘要连续。
	e.absorb(e.buf)
	e.buf = nil
}

func (e *engine) resetAssembly() {
	e.assembling = false
	e.payload = e.payload[:0]
	e.ranges = e.ranges[:0]
}

func (e *engine) absorb(p []byte) {
	e.hasher.Write(p)
	e.pos += int64(len(p))
}

func firstNonZero(p []byte) (int, bool) {
	for i, b := range p {
		if b != 0 {
			return i, true
		}
	}
	return 0, false
}
