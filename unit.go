package dataeng

import "math/big"

// Unit is a registered unit of measure. Scale converts a value in this unit
// to the corresponding SI base value by multiplication. Offset is non-nil
// for affine units (temperature scales): base = (value + Offset) * Scale.
type Unit struct {
	Symbol     string
	Name       string
	Dims       Dimension
	Scale      *big.Rat
	Offset     *big.Rat
	Prefixable bool
}

// Affine reports whether the unit carries a zero offset (degC, degF).
func (u *Unit) Affine() bool { return u.Offset != nil }

type prefix struct {
	Symbol string
	Factor *big.Rat
}

func ratInt(n int64) *big.Rat { return big.NewRat(n, 1) }

func ratDec(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("invalid decimal literal: " + s)
	}
	return r
}

func pow10(n int) *big.Rat {
	r, _ := new(big.Rat).SetString("1e" + itoa(n))
	return r
}

func itoa(n int) string {
	if n < 0 {
		return "-" + itoa(-n)
	}
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

var prefixes = []prefix{
	{"q", pow10(-30)}, {"r", pow10(-27)}, {"y", pow10(-24)}, {"z", pow10(-21)},
	{"a", pow10(-18)}, {"f", pow10(-15)}, {"p", pow10(-12)}, {"n", pow10(-9)},
	{"µ", pow10(-6)}, {"u", pow10(-6)}, {"m", pow10(-3)}, {"c", pow10(-2)},
	{"d", pow10(-1)}, {"da", pow10(1)}, {"h", pow10(2)}, {"k", pow10(3)},
	{"M", pow10(6)}, {"G", pow10(9)}, {"T", pow10(12)}, {"P", pow10(15)},
	{"E", pow10(18)}, {"Z", pow10(21)}, {"Y", pow10(24)}, {"R", pow10(27)},
	{"Q", pow10(30)},
	{"quecto", pow10(-30)}, {"ronto", pow10(-27)}, {"yocto", pow10(-24)},
	{"zepto", pow10(-21)}, {"atto", pow10(-18)}, {"femto", pow10(-15)},
	{"pico", pow10(-12)}, {"nano", pow10(-9)}, {"micro", pow10(-6)},
	{"milli", pow10(-3)}, {"centi", pow10(-2)}, {"deci", pow10(-1)},
	{"deka", pow10(1)}, {"deca", pow10(1)}, {"hecto", pow10(2)},
	{"kilo", pow10(3)}, {"mega", pow10(6)}, {"giga", pow10(9)},
	{"tera", pow10(12)}, {"peta", pow10(15)}, {"exa", pow10(18)},
	{"zetta", pow10(21)}, {"yotta", pow10(24)}, {"ronna", pow10(27)},
	{"quetta", pow10(30)},
}

func dim(idx int, exp int8) Dimension {
	var d Dimension
	d[idx] = exp
	return d
}

var dimless Dimension

var (
	dimL = dim(DimLength, 1)
	dimM = dim(DimMass, 1)
	dimT = dim(DimTime, 1)
	dimI = dim(DimCurrent, 1)
	dimH = dim(DimTemperature, 1)
	dimN = dim(DimAmount, 1)
	dimJ = dim(DimLuminosity, 1)
)

func combine(scale *big.Rat, dims ...Dimension) (*big.Rat, Dimension) {
	var d Dimension
	for _, x := range dims {
		d = d.Add(x)
	}
	return scale, d
}

func reg(u *Unit) {
	unitsBySymbol[u.Symbol] = u
	if u.Name != "" {
		unitsBySymbol[u.Name] = u
	}
}

var unitsBySymbol = map[string]*Unit{}

func defUnit(symbol, name string, d Dimension, scale *big.Rat, offset *big.Rat, prefixable bool) {
	reg(&Unit{Symbol: symbol, Name: name, Dims: d, Scale: scale, Offset: offset, Prefixable: prefixable})
}

func init() {
	one := ratInt(1)

	defUnit("m", "meter", dimL, one, nil, true)
	defUnit("metre", "", dimL, one, nil, true)
	defUnit("kg", "kilogram", dimM, one, nil, false)
	defUnit("g", "gram", dimM, ratDec("0.001"), nil, true)
	defUnit("s", "second", dimT, one, nil, true)
	defUnit("A", "ampere", dimI, one, nil, true)
	defUnit("K", "kelvin", dimH, one, nil, true)
	defUnit("mol", "mole", dimN, one, nil, true)
	defUnit("cd", "candela", dimJ, one, nil, true)
	defUnit("rad", "radian", dimless, one, nil, true)
	defUnit("sr", "steradian", dimless, one, nil, true)

	hzS, hzD := combine(one, dimT.Pow(-1))
	defUnit("Hz", "hertz", hzD, hzS, nil, true)
	nS, nD := combine(one, dimM, dimL, dimT.Pow(-2))
	defUnit("N", "newton", nD, nS, nil, true)
	paS, paD := combine(one, nD, dimL.Pow(-2))
	defUnit("Pa", "pascal", paD, paS, nil, true)
	jS, jD := combine(one, nD, dimL)
	defUnit("J", "joule", jD, jS, nil, true)
	wS, wD := combine(one, jD, dimT.Pow(-1))
	defUnit("W", "watt", wD, wS, nil, true)
	cS, cD := combine(one, dimI, dimT)
	defUnit("C", "coulomb", cD, cS, nil, true)
	vS, vD := combine(one, wD, dimI.Pow(-1))
	defUnit("V", "volt", vD, vS, nil, true)
	fS, fD := combine(one, cD, vD.Pow(-1))
	defUnit("F", "farad", fD, fS, nil, true)
	ohmS, ohmD := combine(one, vD, dimI.Pow(-1))
	defUnit("Ω", "ohm", ohmD, ohmS, nil, true)
	sS, sD := combine(one, dimI, vD.Pow(-1))
	defUnit("S", "siemens", sD, sS, nil, true)
	wbS, wbD := combine(one, vD, dimT)
	defUnit("Wb", "weber", wbD, wbS, nil, true)
	tS, tD := combine(one, wbD, dimL.Pow(-2))
	defUnit("T", "tesla", tD, tS, nil, true)
	hS, hD := combine(one, wbD, dimI.Pow(-1))
	defUnit("H", "henry", hD, hS, nil, true)
	defUnit("lm", "lumen", dimJ, one, nil, true)
	lxS, lxD := combine(one, dimJ, dimL.Pow(-2))
	defUnit("lx", "lux", lxD, lxS, nil, true)
	defUnit("Bq", "becquerel", hzD, one, nil, true)
	gyS, gyD := combine(one, jD, dimM.Pow(-1))
	defUnit("Gy", "gray", gyD, gyS, nil, true)
	defUnit("Sv", "sievert", gyD, gyS, nil, true)
	katS, katD := combine(one, dimN, dimT.Pow(-1))
	defUnit("kat", "katal", katD, katS, nil, true)

	defUnit("L", "liter", dimL.Pow(3), ratDec("0.001"), nil, true)
	defUnit("l", "", dimL.Pow(3), ratDec("0.001"), nil, true)
	defUnit("litre", "", dimL.Pow(3), ratDec("0.001"), nil, true)
	defUnit("min", "minute", dimT, ratInt(60), nil, false)
	defUnit("h", "hour", dimT, ratInt(3600), nil, false)
	defUnit("d", "day", dimT, ratInt(86400), nil, false)
	defUnit("bar", "bar", paD, ratInt(100000), nil, true)
	defUnit("eV", "electronvolt", jD, ratDec("1.602176634e-19"), nil, true)
	defUnit("pc", "percent", dimless, ratDec("0.01"), nil, false)
	defUnit("ppm", "", dimless, ratDec("0.000001"), nil, false)

	defUnit("°R", "rankine", dimH, big.NewRat(5, 9), nil, false)
	defUnit("°C", "celsius", dimH, one, ratDec("273.15"), false)
	defUnit("°F", "fahrenheit", dimH, big.NewRat(5, 9), ratDec("459.67"), false)
}
