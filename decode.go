package dataeng

import (
	"fmt"
	"math/big"
)

// DecodeOptions supplies the host limits and optional output selection.
//
// MaxObservations, MaxSteps, and MaxDepth are inclusive maxima. A value of -1
// means unlimited; values below -1 are invalid. Zero therefore means that no
// observation may be emitted, no descriptor may execute, or that only the
// depth-0 root is allowed, respectively.
//
// Select is called for each executed F=0 element. Returning false suppresses
// only that Observation; the element is still width-validated, read from the
// bit stream, and advances the shared bit position.
type DecodeOptions struct {
	Subsets         int
	MaxObservations int
	MaxSteps        int
	MaxDepth        int
	Select          func(ElementID) bool
}

type decoder struct {
	template *Template
	bits     bitReader
	options  DecodeOptions
	subset   int
	steps    int
	widthOff int
	scaleOff int
	output   []Observation
}

// Decode executes the template for every subset and returns observations in
// execution order. No observation is returned if any error occurs anywhere in
// the message.
func (t *Template) Decode(bits BitString, options DecodeOptions) ([]Observation, error) {
	if options.Subsets < 0 {
		return nil, fmt.Errorf("%w: subsets %d is negative", ErrInvalidOptions, options.Subsets)
	}
	if err := validateLimit("max observations", options.MaxObservations); err != nil {
		return nil, err
	}
	if err := validateLimit("max steps", options.MaxSteps); err != nil {
		return nil, err
	}
	if err := validateLimit("max depth", options.MaxDepth); err != nil {
		return nil, err
	}
	if t == nil {
		return nil, fmt.Errorf("%w: nil template", ErrInvalidOptions)
	}

	d := &decoder{
		template: t,
		bits:     bitReader{data: bits.data, length: bits.length},
		options:  options,
	}
	for subset := 1; subset <= options.Subsets; subset++ {
		d.subset = subset
		d.widthOff = 0
		d.scaleOff = 0
		if err := d.executeList(t.root, 0, nil); err != nil {
			return nil, err
		}
	}

	if err := d.checkTailPadding(); err != nil {
		return nil, err
	}
	return d.output, nil
}

func validateLimit(name string, value int) error {
	if value < -1 {
		return fmt.Errorf("%w: %s %d is below -1", ErrInvalidOptions, name, value)
	}
	return nil
}

func (d *decoder) executeList(nodes []*node, depth int, path []PathStep) error {
	for _, n := range nodes {
		if err := d.executeNode(n, depth, path); err != nil {
			return err
		}
	}
	return nil
}

func (d *decoder) executeNode(n *node, depth int, path []PathStep) error {
	if err := d.takeStep(n.desc, path); err != nil {
		return err
	}

	switch n.kind {
	case nodeElement:
		return d.executeElement(n, path)

	case nodeOperator:
		switch n.desc.X {
		case 1:
			if n.desc.Y == 0 {
				d.widthOff = 0
			} else {
				d.widthOff = n.desc.Y - 128
			}
		case 2:
			if n.desc.Y == 0 {
				d.scaleOff = 0
			} else {
				d.scaleOff = n.desc.Y - 128
			}
		}
		return nil

	case nodeSequence:
		if err := d.checkDepth(n.desc, depth+1, path); err != nil {
			return err
		}
		childPath := append(path, PathStep{
			Kind:       PathSequence,
			Descriptor: n.desc,
		})
		return d.executeList(n.children, depth+1, childPath)

	case nodeReplication:
		count := n.fixedCount
		if n.factorBits != 0 {
			if err := d.takeStep(n.desc, path); err != nil {
				return err
			}
			factor, err := d.readFactor(n.factorBits, n.desc, path)
			if err != nil {
				return err
			}
			count = int(factor)
		}
		if count == 0 {
			return nil
		}
		if err := d.checkDepth(n.desc, depth+1, path); err != nil {
			return err
		}
		for iteration := 1; iteration <= count; iteration++ {
			childPath := append(path, PathStep{
				Kind:       PathReplication,
				Descriptor: n.desc,
				Iteration:  iteration,
			})
			if err := d.executeList(n.children, depth+1, childPath); err != nil {
				return err
			}
		}
		return nil
	}

	return d.decodeError(n.desc, path, d.bits.pos, fmt.Errorf("invalid compiled node kind %d", n.kind))
}

func (d *decoder) executeElement(n *node, path []PathStep) error {
	def := n.element
	width := def.BitWidth + d.widthOff
	if width < 1 || width > 64 {
		return d.decodeError(n.desc, path, d.bits.pos, fmt.Errorf("%w: base %d plus width offset %d gives %d",
			ErrEffectiveWidth, def.BitWidth, d.widthOff, width))
	}

	start := d.bits.pos
	raw, err := d.bits.read(width)
	if err != nil {
		return d.decodeError(n.desc, path, start, err)
	}
	allOnes := ^uint64(0) >> uint(64-width)
	missing := raw == allOnes

	selected := true
	id := ElementID{X: n.desc.X, Y: n.desc.Y, Name: def.Name}
	if d.options.Select != nil {
		selected = d.options.Select(id)
	}
	if !selected {
		return nil
	}
	if d.options.MaxObservations >= 0 && len(d.output) >= d.options.MaxObservations {
		return d.decodeError(n.desc, path, start, ErrObservationLimit)
	}

	var value *big.Rat
	if !missing {
		value = exactValue(raw, def.Reference, def.Scale+d.scaleOff)
	}
	d.output = append(d.output, Observation{
		Subset:   d.subset,
		Element:  id,
		Path:     append([]PathStep(nil), path...),
		BitStart: start,
		BitEnd:   start + width,
		Raw:      raw,
		Missing:  missing,
		Value:    value,
	})
	return nil
}

func exactValue(raw uint64, reference *big.Int, scale int) *big.Rat {
	numerator := new(big.Int).SetUint64(raw)
	numerator.Add(numerator, reference)
	if scale == 0 {
		return new(big.Rat).SetInt(numerator)
	}
	tenPower := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(absInt(scale))), nil)
	if scale > 0 {
		return new(big.Rat).SetFrac(numerator, tenPower)
	}
	return new(big.Rat).Mul(new(big.Rat).SetInt(numerator), new(big.Rat).SetInt(tenPower))
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func (d *decoder) takeStep(desc Descriptor, path []PathStep) error {
	if d.options.MaxSteps >= 0 && d.steps >= d.options.MaxSteps {
		return d.decodeError(desc, path, d.bits.pos, ErrStepLimit)
	}
	d.steps++
	return nil
}

func (d *decoder) checkDepth(desc Descriptor, depth int, path []PathStep) error {
	if d.options.MaxDepth >= 0 && depth > d.options.MaxDepth {
		return d.decodeError(desc, path, d.bits.pos, fmt.Errorf("%w: active depth %d exceeds %d", ErrDepthLimit, depth, d.options.MaxDepth))
	}
	return nil
}

func (d *decoder) readFactor(bits int, desc Descriptor, path []PathStep) (uint64, error) {
	start := d.bits.pos
	value, err := d.bits.read(bits)
	if err != nil {
		return 0, d.decodeError(desc, path, start, err)
	}
	allOnes := ^uint64(0) >> uint(64-bits)
	if value == allOnes {
		return 0, d.decodeError(desc, path, start, fmt.Errorf("%w: %d-bit factor is all ones", ErrInvalidFactor, bits))
	}
	return value, nil
}

func (d *decoder) checkTailPadding() error {
	remaining := d.bits.length - d.bits.pos
	if remaining >= 8 {
		return d.decodeError(Descriptor{}, nil, d.bits.pos, fmt.Errorf("%w: %d trailing bits, want fewer than 8", ErrInvalidPadding, remaining))
	}
	for pos := d.bits.pos; pos < d.bits.length; pos++ {
		if d.bits.bitAt(pos) != 0 {
			return d.decodeError(Descriptor{}, nil, pos, fmt.Errorf("%w: nonzero bit at trailing position %d", ErrInvalidPadding, pos))
		}
	}
	return nil
}

func (d *decoder) decodeError(desc Descriptor, path []PathStep, bit int, err error) error {
	var descPtr *Descriptor
	if desc.F != 0 || desc.X != 0 || desc.Y != 0 {
		copy := desc
		descPtr = &copy
	}
	return &DecodeError{
		Subset:     d.subset,
		BitOffset:  bit,
		Descriptor: descPtr,
		Path:       append([]PathStep(nil), path...),
		Err:        err,
	}
}

type bitReader struct {
	data   []byte
	length int
	pos    int
}

func (r *bitReader) read(width int) (uint64, error) {
	if width < 1 || width > 64 {
		return 0, fmt.Errorf("%w: cannot read %d bits", ErrEffectiveWidth, width)
	}
	if width > r.length-r.pos {
		return 0, fmt.Errorf("%w: need %d bits at %d, only %d remain",
			ErrBitUnderflow, width, r.pos, r.length-r.pos)
	}
	var value uint64
	for i := 0; i < width; i++ {
		value = value<<1 | uint64(r.bitAt(r.pos+i))
	}
	r.pos += width
	return value, nil
}

func (r *bitReader) bitAt(pos int) byte {
	return (r.data[pos/8] >> uint(7-pos%8)) & 1
}
