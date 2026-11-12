package dataeng

import (
	"context"
	"crypto/sha256"
	"errors"
	"hash"
	"io"
)

// Options 配置一个读取器。零值 Mode 即严格模式；限制为 0 表示不限制。
type Options struct {
	// Mode 选择 EOF 残尾策略：Strict（默认）或 Recovery。
	Mode Mode

	// MaxRecordBytes 限制单条逻辑记录的重组字节数；超限立即停止，不会先缓存巨量数据。
	MaxRecordBytes int

	// MaxTotalBytes 限制通过回调交付的逻辑载荷累计字节数；超限立即停止。
	MaxTotalBytes int64

	// Resume 非空时从该检查点恢复。恢复会重新扫描绑定前缀，核验 SHA256 并
	// 确认该位置确为完整逻辑记录边界；不是仅比较调用方提供的摘要。
	Resume *Checkpoint
}

// Reader 顺序读取一条物理日志。它不是并发安全的：同一时刻只能有一个 Read 在跑。
type Reader struct {
	eng     *engine
	src     io.Reader
	ctx     context.Context
	buf     []byte
	readErr error
	trunc   *Truncation
}

// NewReader 构造读取器。r 必须从物理文件偏移 0 开始提供完整字节流；即使提供
// Resume，读取器也会先消费并核验检查点绑定的整个前缀，再从边界处继续。
func NewReader(ctx context.Context, r io.Reader, cb Callback, opts Options) (*Reader, error) {
	if opts.Mode != Strict && opts.Mode != Recovery {
		return nil, &Error{Kind: ErrInvalidOption, Offset: 0, Err: errInvalidOption}
	}
	if opts.MaxRecordBytes < 0 || opts.MaxTotalBytes < 0 {
		return nil, &Error{Kind: ErrInvalidOption, Offset: 0, Err: errInvalidOption}
	}

	rd := &Reader{src: r, ctx: ctx}

	var resumeHash [32]byte
	var verifier *engine
	if opts.Resume != nil {
		cp := opts.Resume
		if cp.PrefixBytes < 0 {
			return nil, &Error{Kind: ErrCheckpoint, Offset: 0, Err: errCheckpoint}
		}

		// 用独立的仅核验引擎扫描整个绑定前缀：执行全部 CRC/类型/片序/填充校验，
		// 不交付、不计数产出，并确认扫描恰好停在空闲（逻辑记录边界）状态。
		verifier = newEngine(Strict, opts.MaxRecordBytes, 0, nil, sha256.New())
		verifier.verifyOnly = true

		lr := io.LimitReader(r, cp.PrefixBytes)
		buf := make([]byte, 32*1024)
		for verifier.pos < cp.PrefixBytes {
			readLen := len(buf)
			if remaining := cp.PrefixBytes - verifier.pos; remaining < int64(readLen) {
				readLen = int(remaining)
			}
			n, err := lr.Read(buf[:readLen])
			if n > 0 {
				if _, ferr := verifier.feed(ctx, buf[:n]); ferr != nil {
					return nil, markCheckpoint(ferr)
				}
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
		}

		if verifier.pos != cp.PrefixBytes {
			return nil, &Error{Kind: ErrCheckpoint, Offset: verifier.pos, Err: errCheckpoint}
		}
		// 不能从 MIDDLE 等非边界位置开始拼接：核验结束必须处于空闲且无残字节。
		if verifier.assembling || len(verifier.buf) > 0 {
			return nil, &Error{Kind: ErrCheckpoint, Offset: cp.PrefixBytes, Err: errCheckpoint}
		}
		// 空前缀（位置 0、尚无确认记录）是合法的起始边界。
		if verifier.cpPos != cp.PrefixBytes && !(cp.PrefixBytes == 0 && verifier.confirmed == 0) {
			return nil, &Error{Kind: ErrCheckpoint, Offset: cp.PrefixBytes, Err: errCheckpoint}
		}
		copy(resumeHash[:], verifier.cpHasher.Sum(nil))
		wantHash := cp.PrefixSHA256
		if cp.PrefixBytes == 0 {
			wantHash = sha256.Sum256(nil)
		}
		if resumeHash != wantHash {
			return nil, &Error{Kind: ErrCheckpoint, Offset: cp.PrefixBytes, Err: errCheckpoint}
		}
	}

	var hasher hash.Hash
	if opts.Resume != nil {
		// 复用核验引擎的主 hasher 状态，继续喂入的字节自然追加到同一摘要；
		// cpHasher 同样沿用，使后续检查点在已确认前缀上继续累积。
		hasher = verifier.hasher
	}
	eng := newEngine(opts.Mode, opts.MaxRecordBytes, opts.MaxTotalBytes, cb, hasher)
	if opts.Resume != nil {
		eng.pos = opts.Resume.PrefixBytes
		eng.cpPos = opts.Resume.PrefixBytes
		eng.cpHash = resumeHash
		eng.cpHasher = verifier.cpHasher
		eng.confirmed = verifier.confirmed
	}
	rd.eng = eng
	return rd, nil
}

// Read 拉取并处理一段数据。它持续调用底层 io.Reader 直到没有更多完整片可处理，
// 每个闭合且 CRC 通过的逻辑记录通过构造时的回调交付。
//
// 返回 io.EOF 表示干净结束；恢复模式下若真实 EOF 丢弃了未完成尾记录，第一次
// 结束读取返回 nil（截断报告经 Truncation 获取），其后再读返回 io.EOF。
// 任何损坏、超限或回调错误都会以 *Error 立即终止，此后读取返回 ErrTerminated。
func (r *Reader) Read() error {
	if r.readErr != nil {
		if errors.Is(r.readErr, io.EOF) {
			return r.readErr
		}
		return &Error{Kind: ErrTerminated, Offset: r.eng.pos, Err: errTerminated}
	}

	for {
		if err := r.ctx.Err(); err != nil {
			r.readErr = err
			return err
		}

		if r.buf == nil {
			r.buf = make([]byte, 32*1024)
		}
		n, err := r.src.Read(r.buf)
		if n > 0 {
			if _, ferr := r.eng.feed(r.ctx, r.buf[:n]); ferr != nil {
				r.readErr = ferr
				return ferr
			}
		}
		if err == io.EOF {
			return r.finish()
		}
		if err != nil {
			r.readErr = err
			return err
		}
	}
}

func (r *Reader) finish() error {
	trunc, ferr := r.eng.finish()
	if ferr != nil {
		r.readErr = ferr
		return ferr
	}

	if trunc != nil {
		r.trunc = trunc
		r.readErr = io.EOF
		return nil // 首次：报告截断而非 EOF，让宿主有机会取 Truncation
	}
	r.readErr = io.EOF
	return io.EOF
}

// Checkpoint 返回当前已确认逻辑记录边界处的检查点。ok 为 false 表示尚无任何
// 记录被确认（仅在交付零条记录时出现）。回调一旦失败，读取器终止，本方法不会
// 返回包含该失败记录的边界。
func (r *Reader) Checkpoint() (Checkpoint, bool) {
	if r.eng.terminated {
		return Checkpoint{}, false
	}
	if r.eng.confirmed == 0 {
		return Checkpoint{}, false
	}
	return Checkpoint{PrefixBytes: r.eng.cpPos, PrefixSHA256: r.eng.cpHash}, true
}

// Position 返回引擎已经吸收（校验并计入前缀哈希）的物理字节数。
func (r *Reader) Position() int64 { return r.eng.pos }

// Truncation 返回恢复模式下真实 EOF 尾记录的截断报告；无截断或严格模式下为 nil。
// 该报告在读取结束后稳定存在，可重复获取。
func (r *Reader) Truncation() *Truncation {
	return r.trunc
}

func markCheckpoint(err error) *Error {
	var pe *Error
	offset := int64(0)
	if errors.As(err, &pe) {
		offset = pe.Offset
	}
	return &Error{Kind: ErrCheckpoint, Offset: offset, Err: err}
}
