package dataeng

import (
	"encoding/binary"
	"fmt"
	"math/big"
)

const maxReadChunkBytes = 1 << 20

// Sample is one raw image value at a multidimensional coordinate. Physical is
// nil exactly when Missing is true.
type Sample struct {
	Coord    []int64
	Raw      int64
	Missing  bool
	Physical *big.Rat
}

// ReadRect reads the half-open box [start,end). Axis lengths and bounds use
// int64. Coordinates are returned with NAXIS1 varying fastest. Any invalid
// bound, short read, or resource overflow rejects the entire call and returns
// no partial samples.
//
// For a NAXIS=0 image, start and end must both have length zero and the result
// is empty because such an HDU has no data.
func (im *Image) ReadRect(start, end []int64) ([]Sample, error) {
	if len(start) != len(im.shape) || len(end) != len(im.shape) {
		return nil, fmt.Errorf("%w: rectangle has %d/%d bounds, image has %d axes", ErrInvalidRegion, len(start), len(end), len(im.shape))
	}
	for axis := range im.shape {
		if start[axis] < 0 || end[axis] < 0 {
			return nil, fmt.Errorf("%w: negative bound on axis %d", ErrInvalidRegion, axis+1)
		}
		if start[axis] > end[axis] {
			return nil, fmt.Errorf("%w: start exceeds end on axis %d", ErrInvalidRegion, axis+1)
		}
		if end[axis] > im.shape[axis] {
			return nil, fmt.Errorf("%w: end %d exceeds axis %d length %d", ErrInvalidRegion, end[axis], axis+1, im.shape[axis])
		}
	}
	if len(im.shape) == 0 {
		return []Sample{}, nil
	}

	count, ok := rectangleCount(start, end)
	if !ok {
		return nil, fmt.Errorf("%w: output pixel count overflows int64", ErrResourceLimit)
	}
	if count > im.maxOutput {
		return nil, fmt.Errorf("%w: request has %d pixels, limit is %d", ErrResourceLimit, count, im.maxOutput)
	}
	if count == 0 {
		return []Sample{}, nil
	}
	if count > int64(int(^uint(0)>>1)) {
		return nil, fmt.Errorf("%w: output pixel count exceeds platform capacity", ErrResourceLimit)
	}

	samples := make([]Sample, 0, int(count))
	coord := append([]int64(nil), start...)
	if err := im.readOuter(len(im.shape)-1, start, end, coord, &samples); err != nil {
		return nil, err
	}
	return samples, nil
}

// Read is an alias for ReadRect.
func (im *Image) Read(start, end []int64) ([]Sample, error) {
	return im.ReadRect(start, end)
}

func rectangleCount(start, end []int64) (int64, bool) {
	for i := range start {
		if end[i] == start[i] {
			return 0, true
		}
	}
	count := int64(1)
	for i := range start {
		length := end[i] - start[i]
		if count > (1<<63-1)/length {
			return 0, false
		}
		count *= length
	}
	return count, true
}

func (im *Image) readOuter(axis int, start, end, coord []int64, samples *[]Sample) error {
	if axis == 0 {
		return im.readFirstAxis(start, end, coord, samples)
	}
	for value := start[axis]; value < end[axis]; value++ {
		coord[axis] = value
		if err := im.readOuter(axis-1, start, end, coord, samples); err != nil {
			return err
		}
	}
	return nil
}

func (im *Image) readFirstAxis(start, end, coord []int64, samples *[]Sample) error {
	base := int64(0)
	for axis := 1; axis < len(im.shape); axis++ {
		base += coord[axis] * im.strides[axis]
	}
	x := start[0]
	remaining := end[0] - start[0]
	for remaining > 0 {
		chunk := remaining
		maxSamples := int64(maxReadChunkBytes / im.bytesPer)
		if maxSamples == 0 {
			maxSamples = 1
		}
		if chunk > maxSamples {
			chunk = maxSamples
		}

		byteCount64 := chunk * int64(im.bytesPer)
		if byteCount64 > int64(int(^uint(0)>>1)) {
			return fmt.Errorf("%w: read chunk exceeds platform capacity", ErrResourceLimit)
		}
		buf := make([]byte, int(byteCount64))
		pixelOffset := base + x
		byteOffset := im.dataOffset + pixelOffset*int64(im.bytesPer)
		if err := readExactAt(im.reader, buf, byteOffset); err != nil {
			return err
		}

		for i := int64(0); i < chunk; i++ {
			offset := int(i) * im.bytesPer
			raw := im.decodeRaw(buf[offset : offset+im.bytesPer])
			sampleCoord := append([]int64(nil), coord...)
			sampleCoord[0] = x + i
			*samples = append(*samples, im.makeSample(sampleCoord, raw))
		}
		x += chunk
		remaining -= chunk
	}
	return nil
}

func (im *Image) decodeRaw(data []byte) int64 {
	switch im.bitpix {
	case 8:
		return int64(data[0])
	case 16:
		return int64(int16(binary.BigEndian.Uint16(data)))
	case 32:
		return int64(int32(binary.BigEndian.Uint32(data)))
	default:
		return int64(binary.BigEndian.Uint64(data))
	}
}

func (im *Image) makeSample(coord []int64, raw int64) Sample {
	sample := Sample{Coord: coord, Raw: raw}
	if im.hasBlank && raw == im.blank {
		sample.Missing = true
		return sample
	}
	rawValue := new(big.Rat).SetInt64(raw)
	physical := new(big.Rat).Mul(im.bscale, rawValue)
	physical.Add(physical, im.bzero)
	sample.Physical = physical
	return sample
}
