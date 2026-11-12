package dataeng

import (
	"fmt"
	"io"
	"math/big"
)

// Image is an immutable, concurrency-safe view of the primary integer image.
type Image struct {
	reader     io.ReaderAt
	header     Header
	shape      []int64
	strides    []int64
	bitpix     int
	bytesPer   int
	pixelCount int64
	dataOffset int64
	bscale     *big.Rat
	bzero      *big.Rat
	blank      int64
	hasBlank   bool
	maxOutput  int64
}

// Open validates and indexes a single-primary-HDU FITS integer image.
//
// size is the exact file length visible through r. Open rejects any trailing
// bytes, so it also rejects extensions and a second HDU.
func Open(r io.ReaderAt, size int64, options ...Option) (*Image, error) {
	if r == nil {
		return nil, fmt.Errorf("%w: nil ReaderAt", ErrTruncated)
	}
	opts := DefaultOptions()
	for _, apply := range options {
		if apply != nil {
			apply(&opts)
		}
	}
	return openWithOptions(r, size, opts)
}

// OpenWithOptions is Open with an explicit Options value.
func OpenWithOptions(r io.ReaderAt, size int64, options Options) (*Image, error) {
	if r == nil {
		return nil, fmt.Errorf("%w: nil ReaderAt", ErrTruncated)
	}
	return openWithOptions(r, size, options)
}

func openWithOptions(r io.ReaderAt, size int64, options Options) (*Image, error) {
	options = normalizeOptions(options)
	if options.MaxHeaderCards <= 0 || options.MaxOutputPixels <= 0 {
		return nil, fmt.Errorf("%w: option limits must be positive", ErrResourceLimit)
	}
	if size < blockSize {
		return nil, fmt.Errorf("%w: size %d is smaller than one header block", ErrTruncated, size)
	}

	header, dataOffset, err := readHeader(r, size, options.MaxHeaderCards)
	if err != nil {
		return nil, err
	}
	layout, err := parseLayout(header, dataOffset)
	if err != nil {
		return nil, err
	}
	if err := validateDataLayout(r, size, layout); err != nil {
		return nil, err
	}

	strides, ok := makeStrides(layout.shape)
	if !ok {
		return nil, fmt.Errorf("%w: image strides overflow int64", ErrResourceLimit)
	}
	return &Image{
		reader:     r,
		header:     copyHeader(header),
		shape:      append([]int64(nil), layout.shape...),
		strides:    strides,
		bitpix:     layout.bitpix,
		bytesPer:   layout.bytesPer,
		pixelCount: layout.pixelCount,
		dataOffset: layout.dataOffset,
		bscale:     new(big.Rat).Set(layout.bscale),
		bzero:      new(big.Rat).Set(layout.bzero),
		blank:      layout.blank,
		hasBlank:   layout.hasBlank,
		maxOutput:  options.MaxOutputPixels,
	}, nil
}

func makeStrides(shape []int64) ([]int64, bool) {
	strides := make([]int64, len(shape))
	if len(shape) == 0 {
		return strides, true
	}
	for _, length := range shape {
		if length == 0 {
			return strides, true
		}
	}
	strides[0] = 1
	for i := 1; i < len(shape); i++ {
		if strides[i-1] > (1<<63-1)/shape[i-1] {
			return nil, false
		}
		strides[i] = strides[i-1] * shape[i-1]
	}
	return strides, true
}

// Shape returns a copy of the FITS axis lengths, with NAXIS1 first.
func (im *Image) Shape() []int64 {
	return append([]int64(nil), im.shape...)
}

// NAXIS returns the number of axes.
func (im *Image) NAXIS() int {
	return len(im.shape)
}

// BITPIX returns the raw sample type width.
func (im *Image) BITPIX() int {
	return im.bitpix
}

// PixelCount returns the number of image samples, or zero when NAXIS is zero
// or any axis length is zero.
func (im *Image) PixelCount() int64 {
	return im.pixelCount
}

// DataOffset returns the byte offset of the first sample.
func (im *Image) DataOffset() int64 {
	return im.dataOffset
}

// Header returns a copy of all ordinary cards, including unknown keywords.
func (im *Image) Header() Header {
	return copyHeader(im.header)
}

// BScale returns a copy of the exact BSCALE value.
func (im *Image) BScale() *big.Rat {
	return new(big.Rat).Set(im.bscale)
}

// BZero returns a copy of the exact BZERO value.
func (im *Image) BZero() *big.Rat {
	return new(big.Rat).Set(im.bzero)
}

// Blank returns the raw BLANK sentinel and whether BLANK was present.
func (im *Image) Blank() (int64, bool) {
	return im.blank, im.hasBlank
}
