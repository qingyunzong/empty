package dataeng

import (
	"encoding/binary"
	"errors"
	"math/big"
)

var (
	// ErrEmptyBlock 表示试图编码零样本块，块中至少需要一条样本。
	ErrEmptyBlock = errors.New("dataeng: block must contain at least one sample")
	// ErrBlockTooLarge 表示块样本数超过 64。
	ErrBlockTooLarge = errors.New("dataeng: block exceeds 64 samples")
	// ErrTruncated 表示输入在块结束前耗尽。
	ErrTruncated = errors.New("dataeng: truncated block stream")
	// ErrInvalidSampleCount 表示头中的样本数为 0。
	ErrInvalidSampleCount = errors.New("dataeng: invalid sample count in header")
	// ErrInvalidBitWidth 表示头中的位宽超过 65。
	ErrInvalidBitWidth = errors.New("dataeng: invalid bit width in header")
	// ErrNonZeroPadding 表示负载尾部的填充位非零。
	ErrNonZeroPadding = errors.New("dataeng: non-zero padding bits")
	// ErrValueOutOfRange 表示差值累加结果超出 int64 可表示范围。
	ErrValueOutOfRange = errors.New("dataeng: reconstructed value out of int64 range")
)

// EncodeBlock 编码单个块。样本数须在 1..64 之间，位宽由差值自动取最小值。
func EncodeBlock(samples []int64) ([]byte, error) {
	count := len(samples)
	if count == 0 {
		return nil, ErrEmptyBlock
	}
	if count > MaxSamplesPerBlock {
		return nil, ErrBlockTooLarge
	}
	width := blockBitWidth(samples)

	out := make([]byte, 0, blockCost(width, count))
	out = append(out, byte(count), byte(width))

	var first [firstBytes]byte
	binary.LittleEndian.PutUint64(first[:], uint64(samples[0]))
	out = append(out, first[:]...)

	writer := bitWriter{}
	for i := 1; i < count; i++ {
		delta := new(big.Int).Sub(
			big.NewInt(samples[i]),
			big.NewInt(samples[i-1]),
		)
		writeBigDelta(&writer, delta, width)
	}
	out = append(out, writer.finish()...)

	if want := blockCost(width, count); len(out) != want {
		panic("dataeng: internal block length mismatch")
	}
	return out, nil
}

// EncodePlan 按给定方案逐块编码并拼接。方案须覆盖全部样本且块边界连续。
func EncodePlan(samples []int64, plan Plan) ([]byte, error) {
	if len(samples) == 0 {
		if len(plan.Blocks) != 0 {
			return nil, ErrEmptyBlock
		}
		return []byte{}, nil
	}
	if len(plan.Blocks) == 0 {
		return nil, ErrEmptyBlock
	}

	total := plan.TotalBytes()
	out := make([]byte, 0, total)
	expectedStart := 0
	for _, block := range plan.Blocks {
		if block.Start != expectedStart || block.End <= block.Start || block.End > len(samples) {
			return nil, ErrTruncated
		}
		encoded, err := EncodeBlock(samples[block.Start:block.End])
		if err != nil {
			return nil, err
		}
		out = append(out, encoded...)
		expectedStart = block.End
	}
	if expectedStart != len(samples) {
		return nil, ErrTruncated
	}
	return out, nil
}

// EncodeColumn 先用最优方案规划，再编码整列；空列返回零字节。
func EncodeColumn(samples []int64) ([]byte, Plan, error) {
	plan := PlanBlocks(samples)
	encoded, err := EncodePlan(samples, plan)
	if err != nil {
		return nil, Plan{}, err
	}
	return encoded, plan, nil
}

// signExtend 将 width 位二补码无符号值还原为数学整数。
func signExtend(value uint64, width int) *big.Int {
	if width == 0 {
		return big.NewInt(0)
	}
	signed := int64(value)
	if width < 64 {
		signBit := uint64(1) << (width - 1)
		if value&signBit != 0 {
			signed = int64(value | ^lowMask(width))
		} else {
			signed = int64(value & lowMask(width))
		}
	}
	return big.NewInt(signed)
}

// Decode 逆解码整块拼接流，返回还原后的样本列。
// 空输入返回空（零块）结果；任何截断、非法头或非零填充位都将报错。
func Decode(data []byte) ([]int64, error) {
	samples := make([]int64, 0)
	offset := 0
	for offset < len(data) {
		if len(data)-offset < headerBytes {
			return nil, ErrTruncated
		}
		count := int(data[offset])
		width := int(data[offset+1])
		offset += headerBytes
		if count == 0 {
			return nil, ErrInvalidSampleCount
		}
		if count > MaxSamplesPerBlock {
			return nil, ErrBlockTooLarge
		}
		if width > MaxBitWidth {
			return nil, ErrInvalidBitWidth
		}

		payloadLen := blockPayloadBytes(width, count)
		bodyLen := firstBytes + payloadLen
		if len(data)-offset < bodyLen {
			return nil, ErrTruncated
		}
		first := int64(binary.LittleEndian.Uint64(data[offset : offset+firstBytes]))
		offset += firstBytes
		payload := data[offset : offset+payloadLen]
		offset += payloadLen

		blockSamples, err := decodePayload(first, count, width, payload)
		if err != nil {
			return nil, err
		}
		samples = append(samples, blockSamples...)
	}
	return samples, nil
}

// decodePayload 依据首值与差值负载还原一个块的全部样本，并校验填充位。
func decodePayload(first int64, count, width int, payload []byte) ([]int64, error) {
	reader := newBitReader(payload)
	samples := make([]int64, count)
	samples[0] = first

	current := big.NewInt(first)
	for i := 1; i < count; i++ {
		delta, err := readSignedDelta(&reader, width)
		if err != nil {
			return nil, err
		}
		current.Add(current, delta)
		if !current.IsInt64() {
			return nil, ErrValueOutOfRange
		}
		samples[i] = current.Int64()
	}

	// 校验尾部填充位：已消费比特之外必须全部为 0。
	usedBits := width * (count - 1)
	totalBits := len(payload) * 8
	for bit := usedBits; bit < totalBits; bit++ {
		byteVal := payload[bit>>3]
		if byteVal&(1<<(bit&7)) != 0 {
			return nil, ErrNonZeroPadding
		}
	}
	return samples, nil
}

// writeBigDelta 以 width 位二补码写入数学差值；width 为 0 时无位可写。
func writeBigDelta(w *bitWriter, delta *big.Int, width int) {
	if width == 0 {
		return
	}
	if width <= 64 {
		w.writeBits(uint64(delta.Int64()), width)
		return
	}
	// width == 65：直接取 65 位二补码位模式的低 64 位与符号位。
	mask65 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 65), big.NewInt(1))
	pattern := new(big.Int).And(delta, mask65)
	low := new(big.Int).And(pattern, new(big.Int).SetUint64(^uint64(0)))
	w.writeBits(low.Uint64(), 64)
	signBit := new(big.Int).Rsh(pattern, 64).Uint64()
	w.writeBits(signBit, 1)
}

// readSignedDelta 读取一个 width 位二补码差值并还原为数学整数。
func readSignedDelta(reader *bitReader, width int) (*big.Int, error) {
	if width == 0 {
		return big.NewInt(0), nil
	}
	if width <= 64 {
		return signExtend(reader.readBits(width), width), nil
	}

	// width == 65：低 64 位加 1 位符号位。
	low := reader.readBits(64)
	signBit := reader.readBits(1)
	value := new(big.Int).SetUint64(low)
	value.Or(value, new(big.Int).Lsh(big.NewInt(int64(signBit)), 64))
	if signBit == 1 {
		// 65 位二补码负值：完整无符号值减去 2^65。
		twoPow65 := new(big.Int).Lsh(big.NewInt(1), 65)
		value.Sub(value, twoPow65)
	}
	return value, nil
}
