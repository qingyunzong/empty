package dataeng

import (
	"math"
	"math/big"
	"math/rand"
	"strconv"
	"sync"
	"testing"
)

func TestSpecialBitPatterns(t *testing.T) {
	tests := []struct {
		bits  uint64
		text  string
		class Class
		sign  int
		rt    bool
	}{
		{0x0000000000000000, "0e0", ClassZero, 1, true},
		{0x8000000000000000, "-0e0", ClassZero, -1, true},
		{0x7ff0000000000000, "inf", ClassInf, 1, true},
		{0xfff0000000000000, "-inf", ClassInf, -1, true},
		{0x7ff8000000000000, "nan", ClassNaN, 0, false},
		{0xfff8000000000000, "nan", ClassNaN, 0, false},
		{0x7ff0000000000001, "nan", ClassNaN, 0, false},
		{0x7ffdeadbeef00001, "nan", ClassNaN, 0, false},
	}
	for _, tc := range tests {
		r := Format(tc.bits)
		if r.Text != tc.text || r.Class != tc.class || r.Sign != tc.sign || r.RoundTrip != tc.rt {
			t.Fatalf("%#x: got {text:%q class:%d sign:%d rt:%v}, want {text:%q class:%d sign:%d rt:%v}",
				tc.bits, r.Text, r.Class, r.Sign, r.RoundTrip, tc.text, tc.class, tc.sign, tc.rt)
		}
		if r.Bits != tc.bits {
			t.Fatalf("%#x: result did not retain input bits", tc.bits)
		}
		if tc.class == ClassNaN && r.NaNPayload != tc.bits&binary64FracMask {
			t.Fatalf("%#x: payload %#x", tc.bits, r.NaNPayload)
		}
		if err := Verify(r); err != nil {
			t.Fatalf("%#x: Verify: %v", tc.bits, err)
		}
	}
}

func TestKnownCanonicalValues(t *testing.T) {
	tests := []struct {
		bits uint64
		text string
	}{
		{math.Float64bits(0.1), "1e-1"},
		{math.Float64bits(0.2), "2e-1"},
		{math.Float64bits(1), "1e0"},
		{math.Float64bits(-1), "-1e0"},
		{math.Float64bits(1.25), "1.25e0"},
		{math.Float64bits(100), "1e2"},
		{math.Float64bits(math.SmallestNonzeroFloat64), "5e-324"},
		{math.Float64bits(math.MaxFloat64), "1.7976931348623157e308"},
		{0x3ff0000000000001, "1.0000000000000002e0"},
		{0x3fd5555555555555, "3.333333333333333e-1"},
	}
	for _, tc := range tests {
		r := Format(tc.bits)
		if r.Text != tc.text {
			t.Fatalf("%#x: got %q, want %q (c=%v q=%d)", tc.bits, r.Text, tc.text, r.C, r.Q)
		}
		if got := math.Float64bits(mustParseFloat(t, r.Text)); got != tc.bits {
			t.Fatalf("%s: parsed bits %#x, want %#x", r.Text, got, tc.bits)
		}
		if err := Verify(r); err != nil {
			t.Fatalf("%s: Verify: %v", r.Text, err)
		}
	}
}

func TestExactDistanceTiePrefersEvenCoefficient(t *testing.T) {
	// 0.99999237060546875 is exactly 131071/2^17. Its interval contains
	// 9999923706054687e-16 and 9999923706054688e-16 at equal distance.
	v := float64(131071) / float64(131072)
	bits := math.Float64bits(v)
	r := Format(bits)
	wantC := big.NewInt(9999923706054688) // even coefficient
	if r.C.Cmp(wantC) != 0 || r.Q != -16 {
		t.Fatalf("got c=%v q=%d (%s), want c=%v q=-16", r.C, r.Q, r.Text, wantC)
	}
	if r.Text != "9.999923706054688e-1" {
		t.Fatalf("got text %q", r.Text)
	}
	if err := Verify(r); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRejectsManipulatedCertificates(t *testing.T) {
	{
		r := Format(math.Float64bits(0.1))
		r.Text = "1.00e-1"
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted non-canonical text")
		}
	}
	{
		// This is a valid 17-digit decimal in 0.1's interval, but it is not
		// shortest: the one-digit 1e-1 also works.
		r := Format(math.Float64bits(0.1))
		r.C = big.NewInt(99999999999999999)
		r.Q = -18
		r.Text = "9.9999999999999999e-2"
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted a non-shortest candidate")
		}
	}
	{
		// The tie fixture chooses the even coefficient; the equally distant
		// odd coefficient has the same length but loses the tie-break.
		r := Format(math.Float64bits(float64(131071) / float64(131072)))
		r.C = big.NewInt(9999923706054687)
		r.Text = "9.999923706054687e-1"
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted the losing candidate of an exact tie")
		}
	}
	{
		// 9007199254740993 is the midpoint between 2^53 and 2^53+2. It
		// rounds to even 2^53, and is outside odd 2^53+2's open interval.
		bits := (uint64(1076) << 52) + 1
		r := Format(bits)
		r.C = big.NewInt(9007199254740993)
		r.Q = 0
		r.Text = "9.007199254740993e15"
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted an open-interval midpoint")
		}
	}
	{
		r := Format(0x7ff8000000000001)
		r.RoundTrip = true
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted a NaN marked round-trip")
		}
	}
	{
		r := Format(math.Float64bits(1))
		r.Interval.LowerClosed = false
		if err := Verify(r); err == nil {
			t.Fatal("Verify accepted an altered endpoint flag")
		}
	}
}

func TestSubnormalAndNormalBoundaries(t *testing.T) {
	patterns := []uint64{
		0x0000000000000001, // minimum positive subnormal
		0x0000000000000002,
		0x000fffffffffffff, // maximum subnormal
		0x0010000000000000, // minimum normal
		0x0010000000000001,
		0x0010000000000002,
		0x000ffffffffffffe,
		0x7fefffffffffffff, // maximum finite
		0x7feffffffffffffe,
	}
	for _, bits := range patterns {
		for _, signed := range []uint64{bits, bits | binary64SignBit} {
			checkFormatAndReference(t, signed)
		}
	}
}

func TestEveryBinaryExponentPowerAndNeighbors(t *testing.T) {
	for expField := uint64(1); expField <= 2046; expField++ {
		base := expField << 52
		patterns := []uint64{base - 1, base, base + 1}
		if expField == 1 {
			patterns = patterns[1:]
		}
		for _, bits := range patterns {
			if bits == 0 || (bits>>52)&binary64ExpMask == binary64ExpMask {
				continue
			}
			checkFormatAndReference(t, bits)
		}
	}
}

func TestDecimalIntegerNeighborhoods(t *testing.T) {
	values := []float64{
		0, 1, 2, 9, 10, 11, 99, 100, 101, 999, 1000,
		1e9, 1e15, 1e16, 1e17, 1e20, 1e30, 1e100, 1e-9, 1e-20, 1e-100,
	}
	for _, v := range values {
		if v == 0 {
			continue
		}
		bits := math.Float64bits(v)
		for _, signed := range []uint64{bits, bits | binary64SignBit} {
			checkFormatAndReference(t, signed)
			checkFormatAndReference(t, signed-1)
			checkFormatAndReference(t, signed+1)
		}
	}
}

func TestMidpointEndpointOpenness(t *testing.T) {
	bs := binary64Format
	// The midpoint between 2^53 and its successor is the integer
	// 9007199254740993.
	evenBits := uint64(1076) << 52 // 2^53, even significand
	evenIV := bs.absRoundingInterval(evenBits)
	midpoint := big.NewRat(9007199254740993, 1)
	if !evenIV.upperClosed {
		t.Fatal("2^53 upper midpoint should be included")
	}
	if evenIV.upper.Cmp(midpoint) != 0 || !evenIV.contains(midpoint) {
		t.Fatal("2^53 upper midpoint was not represented or included")
	}

	oddBits := evenBits + 1 // 2^53+2, odd significand
	oddIV := bs.absRoundingInterval(oddBits)
	if oddIV.lowerClosed {
		t.Fatal("odd 2^53+2 lower midpoint should be excluded")
	}
	if oddIV.lower.Cmp(midpoint) != 0 || oddIV.contains(midpoint) {
		t.Fatal("odd lower midpoint was not represented or was incorrectly included")
	}

	if !evenIV.contains(evenIV.lower) || !evenIV.contains(evenIV.upper) {
		t.Fatal("closed interval should contain both endpoints")
	}
	if oddIV.contains(oddIV.lower) || oddIV.contains(oddIV.upper) {
		t.Fatal("open interval should contain neither endpoint")
	}

	// The same endpoint has opposite membership depending on the adjacent
	// value's parity, so it must round to 2^53, not 2^53+2.
	if got := Format(evenBits).Text; got != "9.007199254740992e15" {
		t.Fatalf("2^53 text: %s", got)
	}
}

func TestRandomBitPatterns(t *testing.T) {
	rng := rand.New(rand.NewSource(0x0324))
	for i := 0; i < 3000; i++ {
		bits := rng.Uint64()
		checkFormatAndReference(t, bits)
	}
	for i := 0; i < 200; i++ {
		bits := rng.Uint64()
		if err := Verify(Format(bits)); err != nil {
			t.Fatalf("%#x: Verify: %v", bits, err)
		}
	}
}

func TestConcurrentFormatAndVerify(t *testing.T) {
	bits := []uint64{
		math.Float64bits(0.1),
		math.Float64bits(-0.1),
		0x0010000000000000,
		0x7fefffffffffffff,
		0x7ff8000000000001,
		0x8000000000000000,
	}
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				r := Format(bits[(i+j)%len(bits)])
				if err := Verify(r); err != nil {
					errs <- err
					return
				}
				// Mutating one certificate must not affect any other call.
				if r.C != nil {
					r.C.Add(r.C, big.NewInt(1))
				}
				if r.Interval != nil {
					r.Interval.Lower.Add(r.Interval.Lower, big.NewRat(1, 1000))
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func (iv internalInterval) contains(x *big.Rat) bool {
	lowerCmp := x.Cmp(iv.lower)
	if lowerCmp < 0 || (lowerCmp == 0 && !iv.lowerClosed) {
		return false
	}
	upperCmp := x.Cmp(iv.upper)
	return upperCmp < 0 || (upperCmp == 0 && iv.upperClosed)
}

func checkFormatAndReference(t *testing.T, bits uint64) {
	t.Helper()
	r := Format(bits)
	if err := Verify(r); err != nil {
		t.Fatalf("%#x (%s): Verify: %v", bits, r.Text, err)
	}
	if r.Class == ClassNaN {
		return
	}
	if r.Class == ClassZero || r.Class == ClassInf {
		parsed := mustParseFloat(t, r.Text)
		if got := math.Float64bits(parsed); got != bits {
			t.Fatalf("%#x (%s): parsed to %#x", bits, r.Text, got)
		}
		return
	}

	ref := referenceInterval(bits)
	if r.Interval == nil {
		t.Fatalf("%#x: finite result has no interval", bits)
	}
	if r.Interval.Lower.Cmp(ref.lower) != 0 || r.Interval.Upper.Cmp(ref.upper) != 0 ||
		r.Interval.LowerClosed != ref.lowerClosed || r.Interval.UpperClosed != ref.upperClosed {
		t.Fatalf("%#x: interval mismatch\n got L=%s U=%s %v/%v\nwant L=%s U=%s %v/%v",
			bits, r.Interval.Lower, r.Interval.Upper, r.Interval.LowerClosed, r.Interval.UpperClosed,
			ref.lower, ref.upper, ref.lowerClosed, ref.upperClosed)
	}

	x := referenceDecimal(r.C, r.Q)
	if r.Sign < 0 {
		x.Neg(x)
	}
	if !publicContains(r.Interval, x) {
		t.Fatalf("%#x (%s): candidate outside independently computed interval", bits, r.Text)
	}

	// ParseFloat is only an extra round-trip check in tests. The production
	// search and Verify prove minimality with exact arithmetic instead.
	parsed := mustParseFloat(t, r.Text)
	if parsed == 0 && r.Class == ClassZero {
		if math.Signbit(parsed) != (r.Sign < 0) {
			t.Fatalf("%#x: zero sign was not preserved", bits)
		}
	}
	if got := math.Float64bits(parsed); got != bits {
		t.Fatalf("%#x (%s): parsed to %#x", bits, r.Text, got)
	}
}

func publicContains(iv *Interval, x *big.Rat) bool {
	return iv.Contains(x)
}

func mustParseFloat(t *testing.T, text string) float64 {
	t.Helper()
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		t.Fatalf("ParseFloat(%q): %v", text, err)
	}
	return v
}
