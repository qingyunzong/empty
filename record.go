package auditlog

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// Digest 为 SHA-256 摘要。
type Digest [sha256.Size]byte

// ZeroDigest 是链中第一条记录的 PrevHash。
var ZeroDigest Digest

func (d Digest) String() string { return hex.EncodeToString(d[:]) }

func (d Digest) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

func (d *Digest) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	raw, err := hex.DecodeString(s)
	if err != nil || len(raw) != sha256.Size {
		return fmt.Errorf("auditlog: bad digest encoding")
	}
	copy(d[:], raw)
	return nil
}

// Record 为一条审计记录。只保存原载荷的摘要，绝不保存原载荷本身；
// 脱敏后的载荷与范围清单用于审计展示与链摘要重放。
type Record struct {
	Seq         uint64  `json:"seq"`          // 单调递增序号，从 0 开始
	PayloadHash Digest  `json:"payload_hash"` // 原（未脱敏）载荷的 SHA-256
	Redacted    []byte  `json:"redacted"`     // 脱敏后的载荷
	Ranges      []Range `json:"ranges"`       // 已脱敏的范围清单（合并后）
	PrevHash    Digest  `json:"prev_hash"`    // 前一条记录的链摘要
	Hash        Digest  `json:"hash"`         // 本记录的链摘要
}

// chainHash 由 prevHash、序号、原载荷摘要、脱敏载荷与范围清单计算链摘要。
// 计算只依赖记录中已保存的（脱敏后）数据，因此无需原秘密即可重放。
func chainHash(prev Digest, seq uint64, payloadHash Digest, redacted []byte, ranges []Range) Digest {
	h := sha256.New()
	h.Write(prev[:])
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], seq)
	h.Write(buf[:])
	h.Write(payloadHash[:])
	binary.BigEndian.PutUint64(buf[:], uint64(len(redacted)))
	h.Write(buf[:])
	h.Write(redacted)
	binary.BigEndian.PutUint64(buf[:], uint64(len(ranges)))
	h.Write(buf[:])
	for _, r := range ranges {
		binary.BigEndian.PutUint64(buf[:], uint64(r.Start))
		h.Write(buf[:])
		binary.BigEndian.PutUint64(buf[:], uint64(r.End))
		h.Write(buf[:])
	}
	var d Digest
	h.Sum(d[:0])
	return d
}

// NewRecord 以 prev 为前驱链摘要构造一条记录。
// payload 为原载荷，仅用于计算摘要，不会被存入记录。
func NewRecord(prev Digest, seq uint64, payload []byte, ranges []Range) (*Record, error) {
	redacted, merged, err := Redact(payload, ranges)
	if err != nil {
		return nil, err
	}
	rec := &Record{
		Seq:         seq,
		PayloadHash: sha256.Sum256(payload),
		Redacted:    redacted,
		Ranges:      merged,
		PrevHash:    prev,
	}
	rec.Hash = chainHash(prev, seq, rec.PayloadHash, redacted, merged)
	return rec, nil
}

// ErrChainBroken 表示链摘要重放验证失败。
var ErrChainBroken = errors.New("auditlog: chain replay mismatch")

// VerifyChain 从第一条记录开始重放整条链：
// 逐条重算链摘要并校验序号与前驱链接。全部一致返回 nil，
// 否则返回首个不一致位置的错误。验证只使用记录内数据，无需原秘密。
func VerifyChain(records []*Record) error {
	prev := ZeroDigest
	for i, rec := range records {
		if rec == nil {
			return fmt.Errorf("%w: nil record at index %d", ErrChainBroken, i)
		}
		if rec.Seq != uint64(i) {
			return fmt.Errorf("%w: record %d has seq %d", ErrChainBroken, i, rec.Seq)
		}
		if rec.PrevHash != prev {
			return fmt.Errorf("%w: record %d prev hash mismatch", ErrChainBroken, i)
		}
		want := chainHash(rec.PrevHash, rec.Seq, rec.PayloadHash, rec.Redacted, rec.Ranges)
		if rec.Hash != want {
			return fmt.Errorf("%w: record %d hash mismatch", ErrChainBroken, i)
		}
		prev = rec.Hash
	}
	return nil
}
