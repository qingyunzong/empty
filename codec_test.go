package formal

import (
	"bytes"
	"errors"
	"math/bits"
	"math/rand"
	"testing"
)

// refCodec is a deliberately naive encoder used to validate the production
// codec.  It uses bit-serial field multiplication and a brute-force inverse.
type refCodec struct {
	k      int
	m      int
	coeffs [][]byte
}

func newRefCodec(k, m int) *refCodec {
	coeffs := make([][]byte, m)
	for i := 0; i < m; i++ {
		coeffs[i] = make([]byte, k)
		for j := 0; j < k; j++ {
			coeffs[i][j] = referenceInv(byte(i) ^ byte(m+j))
		}
	}
	return &refCodec{k: k, m: m, coeffs: coeffs}
}

func (r *refCodec) encode(data []byte) [][]byte {
	if len(data)%r.k != 0 {
		panic("naive encoder requires divisible input")
	}
	shardSize := len(data) / r.k
	shards := make([][]byte, r.k+r.m)
	for j := 0; j < r.k; j++ {
		shards[j] = append([]byte(nil), data[j*shardSize:(j+1)*shardSize]...)
	}
	for i := 0; i < r.m; i++ {
		parity := make([]byte, shardSize)
		for j := 0; j < r.k; j++ {
			for x := 0; x < shardSize; x++ {
				parity[x] ^= referenceMul(shards[j][x], r.coeffs[i][j])
			}
		}
		shards[r.k+i] = parity
	}
	return shards
}

func randomBytes(rng *rand.Rand, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(rng.Intn(256))
	}
	return out
}

func cloneShards(shards [][]byte) [][]byte {
	out := make([][]byte, len(shards))
	for i, shard := range shards {
		if shard != nil {
			out[i] = make([]byte, len(shard))
			copy(out[i], shard)
		}
	}
	return out
}

func shardsEqual(a, b [][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !bytes.Equal(a[i], b[i]) {
			return false
		}
	}
	return true
}

func TestCodecMatchesNaiveEncoding(t *testing.T) {
	cases := []struct{ k, m int }{
		{1, 1},
		{2, 1},
		{2, 2},
		{3, 2},
		{4, 3},
		{5, 2},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(shardCaseName(tc.k, tc.m), func(t *testing.T) {
			codec, err := New(tc.k, tc.m)
			if err != nil {
				t.Fatal(err)
			}
			reference := newRefCodec(tc.k, tc.m)
			for _, shardSize := range []int{1, 2, 7, 31} {
				rng := rand.New(rand.NewSource(int64(tc.k*1000 + tc.m*100 + shardSize)))
				data := randomBytes(rng, tc.k*shardSize)
				got, err := codec.Encode(data)
				if err != nil {
					t.Fatalf("Encode(%d bytes): %v", len(data), err)
				}
				want := reference.encode(data)
				if !shardsEqual(got, want) {
					t.Fatalf("shardSize %d: encoded stripe differs from naive encoder", shardSize)
				}
				if len(got) != tc.k+tc.m {
					t.Fatalf("got %d shards, want %d", len(got), tc.k+tc.m)
				}
				for i := range got {
					if len(got[i]) != shardSize {
						t.Fatalf("shard %d has %d bytes, want %d", i, len(got[i]), shardSize)
					}
				}

				again, err := codec.Encode(data)
				if err != nil {
					t.Fatal(err)
				}
				if !shardsEqual(got, again) {
					t.Fatal("encoding is not deterministic")
				}
				ok, err := codec.Verify(got)
				if err != nil || !ok {
					t.Fatalf("Verify: ok=%v err=%v", ok, err)
				}
			}
		})
	}
}

func TestCodecExhaustiveErasureReconstruction(t *testing.T) {
	cases := []struct{ k, m int }{
		{1, 1},
		{2, 1},
		{2, 2},
		{3, 1},
		{3, 2},
		{2, 3},
		{3, 3},
		{4, 2},
		{4, 3},
		{4, 4},
		{5, 3},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(shardCaseName(tc.k, tc.m), func(t *testing.T) {
			codec, err := New(tc.k, tc.m)
			if err != nil {
				t.Fatal(err)
			}
			reference := newRefCodec(tc.k, tc.m)
			n := tc.k + tc.m

			for _, shardSize := range []int{1, 3, 11} {
				rng := rand.New(rand.NewSource(int64(tc.k*10000 + tc.m*1000 + shardSize)))
				data := randomBytes(rng, tc.k*shardSize)
				original, err := codec.Encode(data)
				if err != nil {
					t.Fatal(err)
				}

				for mask := 0; mask < 1<<n; mask++ {
					missing := bits.OnesCount(uint(mask))
					damaged := cloneShards(original)
					for i := 0; i < n; i++ {
						if mask&(1<<i) != 0 {
							damaged[i] = nil
						}
					}

					if missing > tc.m {
						if err := codec.Reconstruct(cloneShards(damaged)); !errors.Is(err, ErrTooFewShards) {
							t.Fatalf("mask %0*b: %d missing, got err %v, want ErrTooFewShards", n, mask, missing, err)
						}
						continue
					}

					rebuilt := cloneShards(damaged)
					if err := codec.Reconstruct(rebuilt); err != nil {
						t.Fatalf("mask %0*b: Reconstruct: %v", n, mask, err)
					}
					if !shardsEqual(rebuilt, original) {
						t.Fatalf("mask %0*b: reconstructed shards differ from original", n, mask)
					}

					decoded, err := codec.Decode(cloneShards(damaged))
					if err != nil {
						t.Fatalf("mask %0*b: Decode: %v", n, mask, err)
					}
					if !bytes.Equal(decoded, data) {
						t.Fatalf("mask %0*b: decoded bytes differ from original", n, mask)
					}

					// Conservation: re-encoding the decoded data must reproduce
					// every recovered shard, including parity.
					if want := reference.encode(decoded); !shardsEqual(rebuilt, want) {
						t.Fatalf("mask %0*b: parity conservation failed", n, mask)
					}

					ok, err := codec.Verify(rebuilt)
					if err != nil || !ok {
						t.Fatalf("mask %0*b: Verify after repair: ok=%v err=%v", n, mask, ok, err)
					}
				}
			}
		})
	}
}

func TestCodecPaddedExactBytes(t *testing.T) {
	const k, m = 4, 2
	codec, err := New(k, m)
	if err != nil {
		t.Fatal(err)
	}
	for dataLen := 1; dataLen <= 37; dataLen++ {
		rng := rand.New(rand.NewSource(int64(dataLen)))
		data := randomBytes(rng, dataLen)
		original, err := codec.EncodePadded(data)
		if err != nil {
			t.Fatalf("len %d: EncodePadded: %v", dataLen, err)
		}
		if wantSize := codec.ShardSize(dataLen); len(original[0]) != wantSize {
			t.Fatalf("len %d: shard size %d, want %d", dataLen, len(original[0]), wantSize)
		}
		n := k + m
		for mask := 0; mask < 1<<n; mask++ {
			if bits.OnesCount(uint(mask)) > m {
				continue
			}
			damaged := cloneShards(original)
			for i := 0; i < n; i++ {
				if mask&(1<<i) != 0 {
					damaged[i] = nil
				}
			}
			got, err := codec.ReconstructData(damaged, dataLen)
			if err != nil {
				t.Fatalf("len %d mask %0*b: ReconstructData: %v", dataLen, n, mask, err)
			}
			if !bytes.Equal(got, data) {
				t.Fatalf("len %d mask %0*b: recovered bytes differ", dataLen, n, mask)
			}
		}
	}
}

func TestCodecEveryKSubsetReconstructs(t *testing.T) {
	cases := []struct{ k, m int }{
		{2, 3},
		{3, 3},
		{4, 2},
		{5, 3},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(shardCaseName(tc.k, tc.m), func(t *testing.T) {
			codec, err := New(tc.k, tc.m)
			if err != nil {
				t.Fatal(err)
			}
			n := tc.k + tc.m
			const shardSize = 5
			data := randomBytes(rand.New(rand.NewSource(int64(tc.k*100+tc.m))), tc.k*shardSize)
			original, err := codec.Encode(data)
			if err != nil {
				t.Fatal(err)
			}
			for mask := 0; mask < 1<<n; mask++ {
				if bits.OnesCount(uint(mask)) != tc.k {
					continue
				}
				damaged := make([][]byte, n)
				for i := 0; i < n; i++ {
					if mask&(1<<i) != 0 {
						damaged[i] = append([]byte(nil), original[i]...)
					}
				}
				if err := codec.Reconstruct(damaged); err != nil {
					t.Fatalf("subset %0*b: Reconstruct: %v", n, mask, err)
				}
				if !shardsEqual(damaged, original) {
					t.Fatalf("subset %0*b: reconstructed shards differ", n, mask)
				}
			}
		})
	}
}

func TestCodecLinearity(t *testing.T) {
	const k, m = 3, 2
	codec, err := New(k, m)
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(99))
	a := randomBytes(rng, k*9)
	b := randomBytes(rng, k*9)
	xor := make([]byte, len(a))
	for i := range a {
		xor[i] = a[i] ^ b[i]
	}
	ea, err := codec.Encode(a)
	if err != nil {
		t.Fatal(err)
	}
	eb, err := codec.Encode(b)
	if err != nil {
		t.Fatal(err)
	}
	ex, err := codec.Encode(xor)
	if err != nil {
		t.Fatal(err)
	}
	for i := range ex {
		for j := range ex[i] {
			if ex[i][j] != ea[i][j]^eb[i][j] {
				t.Fatalf("encoding is not linear at shard %d byte %d", i, j)
			}
		}
	}
}

func TestCodecEmptyStripe(t *testing.T) {
	codec, err := New(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	shards, err := codec.EncodePadded(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(shards) != 3 {
		t.Fatalf("got %d shards", len(shards))
	}
	for i, shard := range shards {
		if shard == nil || len(shard) != 0 {
			t.Fatalf("shard %d is not a present empty slice", i)
		}
	}
	if ok, err := codec.Verify(shards); err != nil || !ok {
		t.Fatalf("Verify empty stripe: ok=%v err=%v", ok, err)
	}
	data, err := codec.Decode(cloneShards(shards))
	if err != nil || len(data) != 0 {
		t.Fatalf("Decode empty stripe: len=%d err=%v", len(data), err)
	}
	if err := codec.Reconstruct(make([][]byte, 3)); !errors.Is(err, ErrTooFewShards) {
		t.Fatalf("all-nil stripe err=%v, want ErrTooFewShards", err)
	}
	emptySlices := [][]byte{make([]byte, 0), make([]byte, 0), make([]byte, 0)}
	if _, err := codec.ReconstructData(emptySlices, 5); !errors.Is(err, ErrInvalidShardSize) {
		t.Fatalf("empty shards with non-zero dataLen err=%v, want ErrInvalidShardSize", err)
	}
}

func TestCodecVerifyDetectsInconsistency(t *testing.T) {
	codec, err := New(3, 2)
	if err != nil {
		t.Fatal(err)
	}
	data := randomBytes(rand.New(rand.NewSource(7)), 3*5)
	shards, err := codec.Encode(data)
	if err != nil {
		t.Fatal(err)
	}

	corruptParity := cloneShards(shards)
	corruptParity[3][2] ^= 0x80
	if ok, err := codec.Verify(corruptParity); err != nil || ok {
		t.Fatalf("corrupt parity: ok=%v err=%v, want false, nil", ok, err)
	}

	corruptData := cloneShards(shards)
	corruptData[0][0] ^= 1
	if ok, err := codec.Verify(corruptData); err != nil || ok {
		t.Fatalf("corrupt data: ok=%v err=%v, want false, nil", ok, err)
	}

	missing := cloneShards(shards)
	missing[4] = nil
	if ok, err := codec.Verify(missing); ok || !errors.Is(err, ErrTooFewShards) {
		t.Fatalf("missing shard: ok=%v err=%v, want ErrTooFewShards", ok, err)
	}
}

func TestCodecValidation(t *testing.T) {
	invalid := []struct{ k, m int }{
		{0, 1},
		{1, 0},
		{-1, 2},
		{200, 57},
	}
	for _, tc := range invalid {
		if _, err := New(tc.k, tc.m); !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("New(%d,%d) err=%v, want ErrInvalidConfig", tc.k, tc.m, err)
		}
	}

	codec, err := New(3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.Encode(make([]byte, 10)); !errors.Is(err, ErrInvalidDataSize) {
		t.Fatalf("Encode(10) err=%v, want ErrInvalidDataSize", err)
	}
	if err := codec.Reconstruct(make([][]byte, 4)); !errors.Is(err, ErrInvalidShardCount) {
		t.Fatalf("Reconstruct(4 shards) err=%v, want ErrInvalidShardCount", err)
	}
	if _, err := codec.ReconstructData(make([][]byte, 5), -1); !errors.Is(err, ErrInvalidDataLen) {
		t.Fatalf("negative data length err=%v, want ErrInvalidDataLen", err)
	}
}

func shardCaseName(k, m int) string {
	return "k" + itoa(k) + "m" + itoa(m)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
