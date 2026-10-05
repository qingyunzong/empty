// Package authlib 提供基于预写日志（WAL）的令牌授权库。
//
// 语义保证：
//   - 一个令牌允许 k 次整数动作（Issue 时设定额度 k）。
//   - 扣次与业务提交处于同一日志事务：一条日志记录同时携带扣次 n
//     与业务效果 effect，append+fsync 成功才算提交，二者原子生效。
//   - 失败不扣次：任何校验失败或业务参数非法都不会写日志、不改状态。
//   - 重复 ID 不再扣：同一 txID 的提交幂等，第二次起返回 ErrDuplicate。
//   - 撤销与提交按锁内次序：所有变更在同一把互斥锁内串行化，
//     日志顺序即锁内获得锁的顺序。
//   - 崩溃恢复：重启后重放日志，撕裂的尾部记录被截断，
//     已 fsync 的事务精确生效一次。
package authlib

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
)

// 错误集合。
var (
	ErrUnknownToken  = errors.New("authlib: unknown token")
	ErrTokenExists   = errors.New("authlib: token already exists")
	ErrInsufficient  = errors.New("authlib: insufficient remaining count")
	ErrRevoked       = errors.New("authlib: token revoked")
	ErrDuplicate     = errors.New("authlib: duplicate transaction id")
	ErrInvalidAmount = errors.New("authlib: amount must be positive")
)

// CrashPoint 标识崩溃注入点，仅供测试使用。
type CrashPoint string

const (
	BeforeWrite CrashPoint = "beforeWrite" // 写日志前
	BeforeSync  CrashPoint = "beforeSync"  // 已写未 fsync
	AfterSync   CrashPoint = "afterSync"   // 已 fsync，未应用内存状态
	AfterApply  CrashPoint = "afterApply"  // 已应用内存状态，返回前
)

const (
	opIssue  = "issue"
	opCommit = "commit"
	opRevoke = "revoke"
)

// record 是一条日志事务记录。commit 记录把扣次 N 与业务效果 Effect
// 放进同一条记录，保证二者同生同灭。
type record struct {
	TxID   string `json:"txid"`
	Token  string `json:"token"`
	Op     string `json:"op"`
	N      int    `json:"n,omitempty"`
	Effect int    `json:"effect,omitempty"`
}

type tokenState struct {
	remaining int
	revoked   bool
}

// Store 是授权库主体，持有日志文件与内存状态。
type Store struct {
	mu        sync.Mutex
	f         *os.File
	offset    int64 // 已写入（有效）日志末尾偏移
	tokens    map[string]*tokenState
	seen      map[string]struct{} // 已提交的 txID
	effects   int64               // 业务效果累计计数
	crashHook func(CrashPoint)    // 测试注入点，生产为 nil
}

// SetCrashHook 设置崩溃注入钩子（仅测试用）。钩子内 panic 即模拟崩溃。
func (s *Store) SetCrashHook(h func(CrashPoint)) { s.crashHook = h }

func (s *Store) hook(p CrashPoint) {
	if s.crashHook != nil {
		s.crashHook(p)
	}
}

// Open 打开（必要时创建）日志文件并重放恢复状态。
// 重放时遇到撕裂/损坏的尾部记录即停止，并把文件截断到最后一条有效记录。
func Open(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Store{
		f:      f,
		tokens: make(map[string]*tokenState),
		seen:   make(map[string]struct{}),
	}
	if err := s.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

// recover 顺序扫描日志，应用有效记录，截断无效尾部。
func (s *Store) recover() error {
	if _, err := s.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var off int64
	for {
		rec, ok, err := readRecord(s.f)
		if err != nil {
			return err
		}
		if !ok { // EOF 或撕裂尾部
			break
		}
		s.apply(rec)
		off += recordSize(rec)
	}
	s.offset = off
	// 截断撕裂尾部，保证后续追加从有效末尾开始。
	if err := s.f.Truncate(off); err != nil {
		return err
	}
	_, err := s.f.Seek(off, io.SeekStart)
	return err
}

// apply 把一条已确认的记录应用到内存状态（恢复与正常提交共用）。
func (s *Store) apply(rec record) {
	switch rec.Op {
	case opIssue:
		s.tokens[rec.Token] = &tokenState{remaining: rec.N}
	case opCommit:
		t := s.tokens[rec.Token]
		t.remaining -= rec.N
		s.seen[rec.TxID] = struct{}{}
		s.effects += int64(rec.Effect)
	case opRevoke:
		if t, ok := s.tokens[rec.Token]; ok {
			t.revoked = true
		}
	}
}

// appendLog 把一条记录写入日志并 fsync，构成一个日志事务。
// 调用者必须持有锁。返回错误时表示记录未持久化，调用方不得改内存状态。
func (s *Store) appendLog(rec record) error {
	s.hook(BeforeWrite)
	buf := encodeRecord(rec)
	if _, err := s.f.Write(buf); err != nil {
		return err
	}
	s.hook(BeforeSync)
	if err := s.f.Sync(); err != nil {
		return err
	}
	s.hook(AfterSync)
	s.offset += int64(len(buf))
	return nil
}

// Issue 签发一个允许 k 次整数动作的令牌。
func (s *Store) Issue(tokenID string, k int) error {
	if k <= 0 {
		return ErrInvalidAmount
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tokens[tokenID]; ok {
		return ErrTokenExists
	}
	rec := record{Token: tokenID, Op: opIssue, N: k}
	if err := s.appendLog(rec); err != nil {
		return err
	}
	s.apply(rec)
	s.hook(AfterApply)
	return nil
}

// Use 在令牌 tokenID 上提交一次整数动作：扣 n 次并携带业务效果 effect。
// txID 为幂等键：重复提交返回 ErrDuplicate 且不再扣次、不重复计效果。
// 扣次与业务提交在同一日志记录中原子持久化；任何失败都不扣次。
func (s *Store) Use(tokenID, txID string, n, effect int) error {
	if n <= 0 || effect < 0 {
		return ErrInvalidAmount
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.seen[txID]; dup {
		return ErrDuplicate
	}
	t, ok := s.tokens[tokenID]
	if !ok {
		return ErrUnknownToken
	}
	if t.revoked {
		return ErrRevoked
	}
	if t.remaining < n {
		return ErrInsufficient
	}
	rec := record{TxID: txID, Token: tokenID, Op: opCommit, N: n, Effect: effect}
	if err := s.appendLog(rec); err != nil {
		return err // 日志事务失败：不扣次、不计效果
	}
	s.apply(rec)
	s.hook(AfterApply)
	return nil
}

// Revoke 撤销令牌。与 Use 共用同一把锁，因此撤销与提交的先后
// 严格等于锁内获得锁的次序，日志顺序即该次序。
func (s *Store) Revoke(tokenID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tokens[tokenID]; !ok {
		return ErrUnknownToken
	}
	rec := record{Token: tokenID, Op: opRevoke}
	if err := s.appendLog(rec); err != nil {
		return err
	}
	s.apply(rec)
	s.hook(AfterApply)
	return nil
}

// Remaining 返回令牌剩余次数。
func (s *Store) Remaining(tokenID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[tokenID]
	if !ok {
		return 0, ErrUnknownToken
	}
	return t.remaining, nil
}

// Effects 返回已提交业务效果的累计计数。
func (s *Store) Effects() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effects
}

// Close 关闭日志文件。
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.f.Close()
}

// ---- 记录编码：[uint32 长度][uint32 CRC32(payload)][payload(JSON)] ----

func encodeRecord(rec record) []byte {
	payload, _ := json.Marshal(rec)
	buf := make([]byte, 8+len(payload))
	binary.LittleEndian.PutUint32(buf[0:4], uint32(len(payload)))
	binary.LittleEndian.PutUint32(buf[4:8], crc32.ChecksumIEEE(payload))
	copy(buf[8:], payload)
	return buf
}

func recordSize(rec record) int64 {
	payload, _ := json.Marshal(rec)
	return int64(8 + len(payload))
}

// readRecord 读取一条记录。ok=false 表示 EOF 或撕裂/损坏的尾部（非错误）。
func readRecord(r io.Reader) (rec record, ok bool, err error) {
	var hdr [8]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return rec, false, nil
		}
		return rec, false, err
	}
	length := binary.LittleEndian.Uint32(hdr[0:4])
	crc := binary.LittleEndian.Uint32(hdr[4:8])
	if length > 1<<20 { // 防御性上限，视为损坏
		return rec, false, nil
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return rec, false, nil // 撕裂的尾部
		}
		return rec, false, err
	}
	if crc32.ChecksumIEEE(payload) != crc {
		return rec, false, nil // 校验失败，视为损坏尾部
	}
	if err := json.Unmarshal(payload, &rec); err != nil {
		return rec, false, fmt.Errorf("authlib: decode record: %w", err)
	}
	return rec, true, nil
}
