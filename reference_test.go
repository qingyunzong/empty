package tokenbucket

import (
	"math/big"
	"math/rand"
	"testing"
)

// ratModel is the rational-number reference model. Tokens are an exact
// rational; the integer Bucket must always equal floor(ratModel), with
// the remainder holding the fractional part in units of 1/RateDen.
type ratModel struct {
	capacity int64
	rateDen  int64
	rate     *big.Rat // tokens per tick
	tokens   *big.Rat
	last     int64
}

func newRatModel(cfg Config) *ratModel {
	return &ratModel{
		capacity: cfg.Capacity,
		rateDen:  cfg.RateDen,
		rate:     big.NewRat(cfg.RateNum, cfg.RateDen),
		tokens:   big.NewRat(cfg.Capacity, 1),
	}
}

func (m *ratModel) advance(now int64) {
	if now <= m.last {
		return
	}
	elapsed := now - m.last
	m.last = now
	add := new(big.Rat).Mul(m.rate, new(big.Rat).SetInt64(elapsed))
	m.tokens.Add(m.tokens, add)
	if c := new(big.Rat).SetInt64(m.capacity); m.tokens.Cmp(c) > 0 {
		m.tokens.Set(c)
	}
}

func (m *ratModel) allow(now, cost int64) bool {
	m.advance(now)
	c := new(big.Rat).SetInt64(cost)
	if m.tokens.Cmp(c) >= 0 {
		m.tokens.Sub(m.tokens, c)
		return true
	}
	return false
}

// floorAndFrac returns floor(tokens) and the fractional part expressed
// as a numerator over rateDen.
func (m *ratModel) floorAndFrac() (int64, int64) {
	num := m.tokens.Num()
	den := m.tokens.Denom()
	q := new(big.Int).Quo(num, den) // tokens >= 0, so Quo floors
	frac := new(big.Rat).Sub(m.tokens, new(big.Rat).SetInt(q))
	frac.Mul(frac, new(big.Rat).SetInt64(m.rateDen))
	if !frac.IsInt() {
		panic("fraction not a multiple of 1/RateDen")
	}
	return q.Int64(), frac.Num().Int64()
}

// TestBucketMatchesRationalModel drives the integer bucket and the
// rational reference model with identical random operation sequences,
// including backwards clock jumps, and checks decisions and exact state.
func TestBucketMatchesRationalModel(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		cfg := Config{
			Capacity: int64(rng.Intn(20)),
			RateNum:  int64(rng.Intn(7)),
			RateDen:  int64(1 + rng.Intn(7)),
		}
		b, err := NewBucket(cfg)
		if err != nil {
			t.Fatal(err)
		}
		m := newRatModel(cfg)
		now := int64(0)
		for step := 0; step < 500; step++ {
			// Random walk with occasional backwards jumps.
			if rng.Intn(6) == 0 {
				now -= int64(rng.Intn(10))
			} else {
				now += int64(rng.Intn(5))
			}
			cost := int64(rng.Intn(8))
			got, err := b.Allow(now, cost)
			if err != nil {
				t.Fatal(err)
			}
			want := m.allow(now, cost)
			if got != want {
				t.Fatalf("seed %d step %d: decision %v, model %v (cfg %+v, now %d, cost %d)",
					seed, step, got, want, cfg, now, cost)
			}
			tokens, rem, last := b.State()
			wTokens, wRem := m.floorAndFrac()
			if tokens != wTokens || rem != wRem {
				t.Fatalf("seed %d step %d: state (%d, %d), model (%d, %d) (cfg %+v)",
					seed, step, tokens, rem, wTokens, wRem, cfg)
			}
			if last != m.last {
				t.Fatalf("seed %d step %d: lastTime %d, model %d", seed, step, last, m.last)
			}
		}
	}
}
