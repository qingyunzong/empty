package mask

import (
	"errors"
	"fmt"
	"io"
)

// Streamer 支持增量块输入的脱敏。
//
// 安全保证：在任何 Write 返回时，尚未完整到达（未判定）的敏感字段
// 既不会以原文形式泄露，也不会提前输出替换内容——同长替换和摘要替换
// 都等到字段全部字节到齐后才发出；已确定不属于任何范围的字节即时通过。
type Streamer struct {
	opts     Options
	maskByte byte
	merged   []Range

	w io.Writer

	buf       []byte // 已接收、尚未输出的原始字节（对应 flushed 之后的偏移）
	flushed   int    // 已处理到的原始偏移
	nextRange int    // 下一个待处理的合并后范围下标
	segs      []segment
	outLen    int // 已输出的字节数
	closed    bool
	err       error
}

// NewStreamer 创建流式脱敏器，结果写入 w。
// ranges 使用原始输入的字节偏移；opts.Mode 必须显式选择。
func NewStreamer(w io.Writer, ranges []Range, opts Options) (*Streamer, error) {
	if opts.Mode != ModeSameLength && opts.Mode != ModeDigest {
		return nil, ErrModeUnset
	}
	maskByte := opts.MaskByte
	if maskByte == 0 {
		maskByte = '*'
	}
	return &Streamer{
		opts:     opts,
		maskByte: maskByte,
		merged:   MergeRanges(ranges),
		w:        w,
	}, nil
}

// Write 喂入下一块原始字节。返回写入的块长度；出错后流不可用。
func (s *Streamer) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	if s.closed {
		s.err = errors.New("mask: Close 之后不能再 Write")
		return 0, s.err
	}
	s.buf = append(s.buf, p...)
	if err := s.flushReady(false); err != nil {
		s.err = err
		return 0, err
	}
	return len(p), nil
}

// Close 结束输入，校验所有范围并冲刷剩余输出。
// 之后可调用 PositionMap 获取完整双向位置图。
func (s *Streamer) Close() error {
	if s.err != nil {
		return s.err
	}
	if s.closed {
		return nil
	}
	s.closed = true
	total := s.flushed + len(s.buf)
	if err := ValidateRanges(s.merged, total); err != nil {
		s.err = err
		return err
	}
	if err := s.flushReady(true); err != nil {
		s.err = err
		return err
	}
	return nil
}

// PositionMap 返回截至目前的双向位置图；完整结果应在 Close 之后读取。
func (s *Streamer) PositionMap() PositionMap {
	return PositionMap{segs: append([]segment(nil), s.segs...)}
}

// emit 输出一段字节并记录位置图段。origLen 是原始长度，kept 表示是否原样保留。
func (s *Streamer) emit(origStart int, data []byte, origLen int, kept bool) error {
	if _, err := s.w.Write(data); err != nil {
		return fmt.Errorf("mask: 写入输出失败: %w", err)
	}
	s.segs = append(s.segs, segment{
		OrigStart: origStart, OrigEnd: origStart + origLen,
		OutStart: s.outLen, OutEnd: s.outLen + len(data),
		Kept: kept,
	})
	s.outLen += len(data)
	return nil
}

// flushReady 冲刷所有“已判定”的字节。
// final 为 true 时（Close 阶段）冲刷全部剩余内容。
func (s *Streamer) flushReady(final bool) error {
	for {
		received := s.flushed + len(s.buf)
		if s.nextRange < len(s.merged) {
			r := s.merged[s.nextRange]
			// 范围起点之前的非敏感字节可以安全输出。
			keepTo := r.Start
			if keepTo > received {
				keepTo = received
			}
			if keepTo > s.flushed {
				if err := s.emitKept(keepTo); err != nil {
					return err
				}
			}
			// 敏感字段必须全部到齐（已判定）才输出替换内容。
			if received < r.End {
				if !final {
					return nil
				}
				return fmt.Errorf("mask: 输入在范围 [%d, %d) 内提前结束", r.Start, r.End)
			}
			if err := s.emitMasked(r); err != nil {
				return err
			}
			s.nextRange++
			continue
		}
		// 没有更多范围：之后的字节必然是非敏感的，即时输出。
		if len(s.buf) > 0 {
			if err := s.emitKept(s.flushed + len(s.buf)); err != nil {
				return err
			}
		}
		return nil
	}
}

// emitKept 将 [s.flushed, to) 的原始字节原样输出。
func (s *Streamer) emitKept(to int) error {
	n := to - s.flushed
	if n <= 0 {
		return nil
	}
	data := s.buf[:n]
	if err := s.emit(s.flushed, data, n, true); err != nil {
		return err
	}
	s.buf = s.buf[n:]
	s.flushed = to
	return nil
}

// emitMasked 输出一个完整到达的敏感范围的替换内容。
func (s *Streamer) emitMasked(r Range) error {
	n := r.End - s.flushed
	field := s.buf[:n]
	var repl []byte
	switch s.opts.Mode {
	case ModeSameLength:
		repl = make([]byte, len(field))
		for i := range repl {
			repl[i] = s.maskByte
		}
	case ModeDigest:
		repl = digestOf(field)
	}
	if err := s.emit(s.flushed, repl, n, false); err != nil {
		return err
	}
	s.buf = s.buf[n:]
	s.flushed = r.End
	return nil
}
