package formal

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// ShardFormat identifies the shard envelope format.
const ShardFormat = "dlks.checkpoint.shard/v1"

// ShardMagic prefixes every shard object.
const ShardMagic = "CKP1"

const maxShardHeader = 1 << 20

// ErrCorruptShard reports a shard whose envelope, header, or digest is invalid.
var ErrCorruptShard = errors.New("formal: corrupt shard")

// ShardHeader is stored in front of the shard payload. The header is bound to
// the object key by the coordinator, which rechecks step, generation, and rank.
type ShardHeader struct {
	Format     string `json:"format"`
	Step       uint64 `json:"step"`
	Generation uint64 `json:"generation"`
	Rank       int    `json:"rank"`
	Digest     string `json:"digest"`
	Size       int64  `json:"size"`
}

// Digest returns the canonical content digest used by shards and manifests.
func Digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// EncodeShard builds a self-describing shard object.
//
// Layout:
//
//	[4]byte magic | uint32 big-endian header length | JSON header | payload
//
// The digest covers only the payload; the header binds it to a step,
// generation, and rank.
func EncodeShard(step, generation uint64, rank int, payload []byte) ([]byte, ShardHeader, error) {
	if rank < 0 {
		return nil, ShardHeader{}, fmt.Errorf("formal: negative rank %d", rank)
	}
	header := ShardHeader{
		Format:     ShardFormat,
		Step:       step,
		Generation: generation,
		Rank:       rank,
		Digest:     Digest(payload),
		Size:       int64(len(payload)),
	}
	encodedHeader, err := json.Marshal(header)
	if err != nil {
		return nil, ShardHeader{}, fmt.Errorf("formal: encode shard header: %w", err)
	}
	if len(encodedHeader) > maxShardHeader {
		return nil, ShardHeader{}, fmt.Errorf("formal: shard header too large: %d", len(encodedHeader))
	}
	blob := make([]byte, 8+len(encodedHeader)+len(payload))
	copy(blob[:4], ShardMagic)
	binary.BigEndian.PutUint32(blob[4:8], uint32(len(encodedHeader)))
	copy(blob[8:], encodedHeader)
	copy(blob[8+len(encodedHeader):], payload)
	return blob, header, nil
}

// DecodeShard validates a shard envelope and returns its header and payload.
// The returned payload aliases blob.
func DecodeShard(blob []byte) (ShardHeader, []byte, error) {
	var header ShardHeader
	if len(blob) < 8 {
		return header, nil, fmt.Errorf("%w: object shorter than envelope prefix", ErrCorruptShard)
	}
	if string(blob[:4]) != ShardMagic {
		return header, nil, fmt.Errorf("%w: bad magic %q", ErrCorruptShard, blob[:4])
	}
	headerLen := int(binary.BigEndian.Uint32(blob[4:8]))
	if headerLen <= 0 || headerLen > len(blob)-8 {
		return header, nil, fmt.Errorf("%w: bad header length %d for object of %d bytes", ErrCorruptShard, headerLen, len(blob))
	}
	if headerLen > maxShardHeader {
		return header, nil, fmt.Errorf("%w: header length %d exceeds limit", ErrCorruptShard, headerLen)
	}
	if err := json.Unmarshal(blob[8:8+headerLen], &header); err != nil {
		return header, nil, fmt.Errorf("%w: decode header: %v", ErrCorruptShard, err)
	}
	payload := blob[8+headerLen:]
	if header.Format != ShardFormat {
		return header, nil, fmt.Errorf("%w: unsupported format %q", ErrCorruptShard, header.Format)
	}
	if header.Rank < 0 {
		return header, nil, fmt.Errorf("%w: negative rank %d", ErrCorruptShard, header.Rank)
	}
	if header.Size != int64(len(payload)) {
		return header, nil, fmt.Errorf("%w: header size %d does not match payload size %d", ErrCorruptShard, header.Size, len(payload))
	}
	if header.Digest != Digest(payload) {
		return header, nil, fmt.Errorf("%w: payload digest %s does not match header digest %s", ErrCorruptShard, Digest(payload), header.Digest)
	}
	return header, payload, nil
}
