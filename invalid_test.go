package dataeng_test

import (
	"errors"
	"reflect"
	"testing"

	de "example.org/dataeng/q0320"
	"example.org/dataeng/q0320/internal/s8fixture"
	"example.org/dataeng/q0320/internal/s8ref"
)

func TestIllegalOpcodeForFieldKind(t *testing.T) {
	numericCfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       2,
		RowByteBudget: 8,
	}
	bytesCfg := de.Config{
		Fields:        []de.Field{de.BytesField("b", 8)},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       2,
		RowByteBudget: 8,
	}

	cases := []struct {
		name string
		cfg  de.Config
		add  func(*s8fixture.Builder) error
	}{
		{"spaces-for-numeric", numericCfg, func(b *s8fixture.Builder) error { return b.AddSpaces() }},
		{"missing-for-bytes", bytesCfg, func(b *s8fixture.Builder) error { return b.AddMissing() }},
		{"integer-for-bytes", bytesCfg, func(b *s8fixture.Builder) error { return b.AddCode(1, 0) }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := s8fixture.New(s8fixture.Little)
			add(t, tc.add(b))
			add(t, b.AddTerminator())
			data, _, err := b.Encode()
			add(t, err)

			d, err := de.NewDecoder(tc.cfg)
			if err != nil {
				t.Fatalf("NewDecoder: %v", err)
			}
			rows, err := d.Push(data)
			if !errors.Is(err, de.ErrTypeMismatch) {
				t.Fatalf("Push = %v, want type mismatch", err)
			}
			if len(rows) != 0 {
				t.Fatalf("delivered %d rows", len(rows))
			}
		})
	}
}

func TestTerminatorMustBeAtRowBoundary(t *testing.T) {
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("n"),
			de.BytesField("b", 16),
		},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       3,
		RowByteBudget: 16,
	}
	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(1, cfg.Bias))
	add(t, b.AddTerminator())
	data, _, err := b.Encode()
	add(t, err)

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	_, err = d.Push(data)
	if !errors.Is(err, de.ErrRowBoundary) {
		t.Fatalf("Push = %v, want row boundary", err)
	}
}

func TestTerminatorHeaderRules(t *testing.T) {
	cfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       2,
		RowByteBudget: 8,
	}

	t.Run("nonzero-suffix", func(t *testing.T) {
		b := s8fixture.New(s8fixture.Little)
		add(t, b.AddTerminator())
		add(t, b.AddCode(1, cfg.Bias))
		data, _, err := b.Encode()
		add(t, err)

		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		_, err = d.Push(data)
		if !errors.Is(err, de.ErrTerminatorHeader) {
			t.Fatalf("Push = %v, want terminator header", err)
		}
	})

	t.Run("hidden-literal-after-terminator", func(t *testing.T) {
		b := s8fixture.New(s8fixture.Little)
		add(t, b.AddTerminator())
		add(t, b.AddLiteral([8]byte{}))
		data, _, err := b.Encode()
		add(t, err)

		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		_, err = d.Push(data)
		if !errors.Is(err, de.ErrTerminatorHeader) {
			t.Fatalf("Push = %v, want terminator header", err)
		}
	})
}

func TestExtraBytesAfterTerminator(t *testing.T) {
	cfg, data, _ := lastLiteralScenario(t)
	withExtra := append(append([]byte(nil), data...), 0x7f)

	t.Run("same-push", func(t *testing.T) {
		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		rows, err := d.Push(withExtra)
		if !errors.Is(err, de.ErrExtraData) {
			t.Fatalf("Push = %v, want extra data", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows, want completed row before error", len(rows))
		}
	})

	t.Run("later-push", func(t *testing.T) {
		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		rows, err := d.Push(data)
		if err != nil {
			t.Fatalf("Push valid data: %v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows", len(rows))
		}
		_, err = d.Push([]byte{0x7f})
		if !errors.Is(err, de.ErrExtraData) {
			t.Fatalf("extra Push = %v, want extra data", err)
		}
	})
}

func TestRowLimitRejectsBeforeProducingRow(t *testing.T) {
	cfg, data, _ := mixedScenario(t)
	cfg.MaxRows = 1

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows, err := d.Push(data)
	if !errors.Is(err, de.ErrRowLimit) {
		t.Fatalf("Push = %v, want row limit", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want exactly the allowed row", len(rows))
	}

	refRows, _, refErr := s8ref.Decode(data, cfg)
	if !errors.Is(refErr, de.ErrRowLimit) {
		t.Fatalf("reference error = %v", refErr)
	}
	if !reflect.DeepEqual(rows, refRows) {
		t.Fatalf("rows differ from reference")
	}

	if _, err := d.Push([]byte{}); !errors.Is(err, de.ErrState) {
		t.Fatalf("Push after failure = %v, want state", err)
	}
	if err := d.Finish(); !errors.Is(err, de.ErrState) {
		t.Fatalf("Finish after failure = %v, want state", err)
	}
}

func TestExactRowLimitAndZeroRowLimit(t *testing.T) {
	cfg, data, _ := mixedScenario(t)
	cfg.MaxRows = 3
	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows", len(rows))
	}

	zeroCfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       0,
		RowByteBudget: 8,
	}
	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddTerminator())
	data, _, err = b.Encode()
	add(t, err)
	rows, err = decodeWithCuts(t, zeroCfg, data, nil)
	if err != nil {
		t.Fatalf("zero-row decode: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("got %d rows with zero limit", len(rows))
	}

	b = s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(1, 0))
	add(t, b.AddTerminator())
	data, _, err = b.Encode()
	add(t, err)
	d, err := de.NewDecoder(zeroCfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	if _, err := d.Push(data); !errors.Is(err, de.ErrRowLimit) {
		t.Fatalf("Push = %v, want row limit", err)
	}
}

func TestStateTransitions(t *testing.T) {
	cfg, data, _ := lastLiteralScenario(t)

	t.Run("after-successful-finish", func(t *testing.T) {
		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		rows, err := d.Push(data)
		if err != nil {
			t.Fatalf("Push: %v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows", len(rows))
		}
		if d.Complete() {
			t.Fatal("Complete before Finish")
		}
		if d.RowsDecoded() != 1 {
			t.Fatalf("RowsDecoded = %d", d.RowsDecoded())
		}
		if err := d.Finish(); err != nil {
			t.Fatalf("Finish: %v", err)
		}
		if !d.Complete() {
			t.Fatal("not complete after successful Finish")
		}
		if _, err := d.Push(nil); !errors.Is(err, de.ErrState) {
			t.Fatalf("Push after Finish = %v", err)
		}
		if err := d.Finish(); !errors.Is(err, de.ErrState) {
			t.Fatalf("second Finish = %v", err)
		}
	})

	t.Run("after-truncated-finish", func(t *testing.T) {
		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		if _, err := d.Push(data[:len(data)-1]); err != nil {
			t.Fatalf("Push prefix: %v", err)
		}
		if err := d.Finish(); !errors.Is(err, de.ErrTruncated) {
			t.Fatalf("Finish = %v, want truncated", err)
		}
		if _, err := d.Push([]byte{}); !errors.Is(err, de.ErrState) {
			t.Fatalf("Push after truncation = %v", err)
		}
		if err := d.Finish(); !errors.Is(err, de.ErrState) {
			t.Fatalf("Finish after truncation = %v", err)
		}
	})

	t.Run("previous-rows-survive-error", func(t *testing.T) {
		errCfg := de.Config{
			Fields: []de.Field{
				de.NumericField("n"),
				de.BytesField("b", 8),
			},
			NumericEndian: de.LittleEndian,
			Bias:          100,
			MaxRows:       5,
			RowByteBudget: 8,
		}
		b := s8fixture.New(s8fixture.Little)
		add(t, b.AddCode(1, errCfg.Bias))
		add(t, b.AddBytesLiteral([8]byte{'o', 'k', ' ', ' ', ' ', ' ', ' ', ' '}))
		add(t, b.AddSpaces()) // illegal: 254 applied to numeric field 0
		add(t, b.AddTerminator())
		errData, _, err := b.Encode()
		add(t, err)

		d, err := de.NewDecoder(errCfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		rows, err := d.Push(errData)
		if !errors.Is(err, de.ErrTypeMismatch) {
			t.Fatalf("Push = %v, want type mismatch", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows, want prior complete row", len(rows))
		}
		if _, err := d.Push(nil); !errors.Is(err, de.ErrState) {
			t.Fatalf("Push after error = %v", err)
		}
	})
}

func TestConfigValidation(t *testing.T) {
	base := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       1,
		RowByteBudget: 64,
	}

	cases := []struct {
		name string
		cfg  de.Config
	}{
		{"no-fields", func() de.Config { c := base; c.Fields = nil; return c }()},
		{"duplicate-name", func() de.Config {
			c := base
			c.Fields = []de.Field{de.NumericField("x"), de.NumericField("x")}
			return c
		}()},
		{"bias-too-low", func() de.Config { c := base; c.Bias = -32769; return c }()},
		{"bias-too-high", func() de.Config { c := base; c.Bias = 32768; return c }()},
		{"bad-endian", func() de.Config { c := base; c.NumericEndian = de.ByteOrder(9); return c }()},
		{"negative-budget", func() de.Config { c := base; c.RowByteBudget = -1; return c }()},
		{"zero-width", func() de.Config {
			c := base
			c.Fields = []de.Field{de.BytesField("b", 0)}
			return c
		}()},
		{"width-too-large", func() de.Config {
			c := base
			c.RowByteBudget = 1 << 21
			c.Fields = []de.Field{de.BytesField("b", 1048577)}
			return c
		}()},
		{"width-over-budget", func() de.Config {
			c := base
			c.RowByteBudget = 31
			c.Fields = []de.Field{de.BytesField("b", 32)}
			return c
		}()},
		{"unknown-projection", func() de.Config {
			c := base
			c.Projection = []string{"nope"}
			return c
		}()},
		{"duplicate-projection", func() de.Config {
			c := base
			c.Projection = []string{"n", "n"}
			return c
		}()},
		{"bad-kind", func() de.Config {
			c := base
			c.Fields = []de.Field{{Name: "x", Kind: de.FieldKind(9)}}
			return c
		}()},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := de.NewDecoder(tc.cfg); !errors.Is(err, de.ErrInvalidConfig) {
				t.Fatalf("NewDecoder = %v, want invalid config", err)
			}
		})
	}

	t.Run("valid-bias-boundaries", func(t *testing.T) {
		for _, bias := range []int{-32768, 32767} {
			c := base
			c.Bias = bias
			if _, err := de.NewDecoder(c); err != nil {
				t.Fatalf("bias %d rejected: %v", bias, err)
			}
		}
	})
}
