package formal

import "testing"

// referenceMul is an independent bit-serial GF(2^8) multiply using the same
// primitive polynomial.  It deliberately does not use the exp/log tables.
func referenceMul(a, b byte) byte {
	var product byte
	for b > 0 {
		if b&1 != 0 {
			product ^= a
		}
		carry := a & 0x80
		a <<= 1
		if carry != 0 {
			a ^= 0x1d
		}
		b >>= 1
	}
	return product
}

func referenceInv(a byte) byte {
	if a == 0 {
		panic("inverse of zero")
	}
	for b := 1; b < 256; b++ {
		if referenceMul(a, byte(b)) == 1 {
			return byte(b)
		}
	}
	panic("no inverse")
}

func TestGFMultiplyMatchesBitSerialReference(t *testing.T) {
	for a := 0; a < 256; a++ {
		for b := 0; b < 256; b++ {
			got := gfMul(byte(a), byte(b))
			want := referenceMul(byte(a), byte(b))
			if got != want {
				t.Fatalf("%#02x * %#02x = %#02x, want %#02x", a, b, got, want)
			}
		}
	}
}

func TestGFInverse(t *testing.T) {
	for a := 1; a < 256; a++ {
		got := gfInv(byte(a))
		if got != referenceInv(byte(a)) {
			t.Fatalf("inverse(%#02x) = %#02x, want %#02x", a, got, referenceInv(byte(a)))
		}
		if product := gfMul(byte(a), got); product != 1 {
			t.Fatalf("%#02x * inverse = %#02x, want 1", a, product)
		}
	}
}

func TestGFAxioms(t *testing.T) {
	for a := 0; a < 256; a++ {
		for b := 0; b < 256; b++ {
			if gfMul(byte(a), byte(b)) != gfMul(byte(b), byte(a)) {
				t.Fatalf("multiplication is not commutative for %#02x, %#02x", a, b)
			}
			for c := 0; c < 16; c++ {
				left := gfMul(gfMul(byte(a), byte(b)), byte(c))
				right := gfMul(byte(a), gfMul(byte(b), byte(c)))
				if left != right {
					t.Fatalf("multiplication is not associative for %#02x, %#02x, %#02x", a, b, c)
				}
				distributiveLeft := gfMul(byte(a), byte(b)^byte(c))
				distributiveRight := gfMul(byte(a), byte(b)) ^ gfMul(byte(a), byte(c))
				if distributiveLeft != distributiveRight {
					t.Fatalf("distributivity failed for %#02x, %#02x, %#02x", a, b, c)
				}
			}
		}
	}
}

func TestGFDivisionAndPower(t *testing.T) {
	for a := 0; a < 256; a++ {
		for b := 1; b < 256; b++ {
			q := gfDiv(byte(a), byte(b))
			if got := gfMul(q, byte(b)); got != byte(a) {
				t.Fatalf("%#02x / %#02x * %#02x = %#02x", a, b, b, got)
			}
		}
	}
	for a := 1; a < 256; a++ {
		if gfPow(byte(a), 0) != 1 {
			t.Fatalf("%#02x^0 != 1", a)
		}
		want := byte(1)
		for n := 1; n <= 20; n++ {
			want = gfMul(want, byte(a))
			if got := gfPow(byte(a), n); got != want {
				t.Fatalf("%#02x^%d = %#02x, want %#02x", a, n, got, want)
			}
		}
	}
}
