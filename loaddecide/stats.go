// Package loaddecide implements an online load-level decision library for a
// capacity platform. A load-test controller drives it round by round: at each
// load level it feeds warmup observations and measured (jitter-phase)
// observations, and the decider returns confidence-interval based verdicts,
// the next load level to apply, and the saturation knee bracket.
package loaddecide

import "math"

// Interval is a two-sided confidence interval [Lower, Upper].
type Interval struct {
	Lower float64
	Upper float64
}

// Width returns Upper-Lower.
func (i Interval) Width() float64 { return i.Upper - i.Lower }

// Contains reports whether v falls inside the interval. NaN bounds never
// contain anything.
func (i Interval) Contains(v float64) bool {
	return !math.IsNaN(i.Lower) && v >= i.Lower && v <= i.Upper
}

// MeanInterval is a confidence interval around a sample mean.
type MeanInterval struct {
	Interval
	Mean float64
	N    int
}

// QuantileInterval is a confidence interval around a sample quantile.
type QuantileInterval struct {
	Interval
	Estimate float64
	N        int
}

// invNormal returns the inverse standard normal CDF (probit) using Peter
// Acklam's rational approximation. Relative accuracy is about 1e-9.
func invNormal(p float64) float64 {
	const (
		a1 = -3.969683028665376e+01
		a2 = 2.209460984245205e+02
		a3 = -2.759285104469687e+02
		a4 = 1.383577518672690e+02
		a5 = -3.066479806614716e+01
		a6 = 2.506628277459239e+00

		b1 = -5.447609879822406e+01
		b2 = 1.615858368580409e+02
		b3 = -1.556989798598866e+02
		b4 = 6.680131188771972e+01
		b5 = -1.328068155288572e+01

		c1 = -7.784894002430293e-03
		c2 = -3.223964580411365e-01
		c3 = -2.400758277161838e+00
		c4 = -2.549732539343734e+00
		c5 = 4.374664141464968e+00
		c6 = 2.938163982698783e+00

		d1 = 7.784695709041462e-03
		d2 = 3.224671290700398e-01
		d3 = 2.445134137142996e+00
		d4 = 3.754408661907416e+00
	)
	switch {
	case p <= 0:
		return math.Inf(-1)
	case p >= 1:
		return math.Inf(1)
	case p < 0.02425:
		q := math.Sqrt(-2 * math.Log(p))
		return (((((c1*q+c2)*q+c3)*q+c4)*q+c5)*q + c6) /
			((((d1*q+d2)*q+d3)*q+d4)*q + 1)
	case p < 1-0.02425:
		q := p - 0.5
		r := q * q
		return (((((a1*r+a2)*r+a3)*r+a4)*r+a5)*r + a6) * q /
			(((((b1*r+b2)*r+b3)*r+b4)*r+b5)*r + 1)
	default:
		q := math.Sqrt(-2 * math.Log(1-p))
		return -(((((c1*q+c2)*q+c3)*q+c4)*q+c5)*q + c6) /
			((((d1*q+d2)*q+d3)*q+d4)*q + 1)
	}
}

// betaContinuedFraction evaluates the continued-fraction part of the
// incomplete beta function via Lentz's method (Numerical Recipes).
func betaContinuedFraction(a, b, x float64) float64 {
	const (
		maxIter = 200
		eps     = 3e-14
		fpMin   = 1e-300
	)
	qab := a + b
	qap := a + 1
	qam := a - 1
	c := 1.0
	d := 1 - qab*x/qap
	if math.Abs(d) < fpMin {
		d = fpMin
	}
	d = 1 / d
	h := d
	for m := 1; m <= maxIter; m++ {
		mf := float64(m)
		m2 := 2 * mf

		aa := mf * (b - mf) * x / ((qam + m2) * (a + m2))
		d = 1 + aa*d
		if math.Abs(d) < fpMin {
			d = fpMin
		}
		c = 1 + aa/c
		if math.Abs(c) < fpMin {
			c = fpMin
		}
		d = 1 / d
		h *= d * c

		aa = -(a + mf) * (qab + mf) * x / ((a + m2) * (qap + m2))
		d = 1 + aa*d
		if math.Abs(d) < fpMin {
			d = fpMin
		}
		c = 1 + aa/c
		if math.Abs(c) < fpMin {
			c = fpMin
		}
		d = 1 / d
		delta := d * c
		h *= delta
		if math.Abs(delta-1) < eps {
			break
		}
	}
	return h
}

// regularizedBeta returns I_x(a,b), the regularized incomplete beta function.
func regularizedBeta(x, a, b float64) float64 {
	switch {
	case x <= 0:
		return 0
	case x >= 1:
		return 1
	}
	logGammaA, _ := math.Lgamma(a)
	logGammaB, _ := math.Lgamma(b)
	logGammaAB, _ := math.Lgamma(a + b)
	logBeta := logGammaA + logGammaB - logGammaAB
	front := math.Exp(-logBeta + a*math.Log(x) + b*math.Log(1-x))
	if x < (a+1)/(a+b+2) {
		return front * betaContinuedFraction(a, b, x) / a
	}
	return 1 - front*betaContinuedFraction(b, a, 1-x)/b
}

// tCritical returns the two-sided Student-t critical value for the given
// confidence level (e.g. 0.95) and degrees of freedom. It is derived by
// inverting the t CDF expressed through the regularized incomplete beta.
func tCritical(confidence float64, degreesOfFreedom int) float64 {
	if degreesOfFreedom <= 0 || confidence <= 0 || confidence >= 1 {
		return math.NaN()
	}
	nu := float64(degreesOfFreedom)
	target := 1 - (1-confidence)/2
	cdf := func(t float64) float64 {
		x := nu / (nu + t*t)
		return 1 - 0.5*regularizedBeta(x, nu/2, 0.5)
	}
	lo, hi := 0.0, 1e4
	for range 100 {
		mid := (lo + hi) / 2
		if cdf(mid) < target {
			lo = mid
		} else {
			hi = mid
		}
	}
	return (lo + hi) / 2
}

// meanConfidenceInterval returns the sample mean and its Student-t confidence
// interval. Bounds are NaN when fewer than two samples are available, which
// the precision gate treats as insufficient evidence.
func meanConfidenceInterval(values []float64, confidence float64) MeanInterval {
	n := len(values)
	if n == 0 {
		return MeanInterval{N: 0, Interval: Interval{Lower: math.NaN(), Upper: math.NaN()}}
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	mean := sum / float64(n)
	if n < 2 {
		return MeanInterval{
			Mean:     mean,
			N:        n,
			Interval: Interval{Lower: math.NaN(), Upper: math.NaN()},
		}
	}
	sumSquaredDeviation := 0.0
	for _, v := range values {
		dev := v - mean
		sumSquaredDeviation += dev * dev
	}
	standardError := math.Sqrt(sumSquaredDeviation / float64(n-1) / float64(n))
	critical := tCritical(confidence, n-1)
	margin := critical * standardError
	return MeanInterval{
		Mean:     mean,
		N:        n,
		Interval: Interval{Lower: mean - margin, Upper: mean + margin},
	}
}

// wilsonInterval returns the Wilson score confidence interval for a binomial
// proportion failures/n. Wilson intervals stay inside [0,1], are well behaved
// for small n and extreme proportions, and shrink monotonically as n grows for
// a fixed proportion.
func wilsonInterval(failures, n int, confidence float64) Interval {
	if n <= 0 {
		return Interval{Lower: math.NaN(), Upper: math.NaN()}
	}
	z := invNormal(1 - (1-confidence)/2)
	nf := float64(n)
	p := float64(failures) / nf
	denominator := 1 + z*z/nf
	center := (p + z*z/(2*nf)) / denominator
	halfWidth := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf)) / denominator
	return Interval{Lower: center - halfWidth, Upper: center + halfWidth}
}

// rankValue maps a continuous 1-based rank onto sorted data using the same
// linear interpolation as the R-7 (numpy/default) quantile definition.
func rankValue(sorted []float64, rank float64) float64 {
	n := len(sorted)
	if n == 0 {
		return math.NaN()
	}
	if rank <= 1 {
		return sorted[0]
	}
	if rank >= float64(n) {
		return sorted[n-1]
	}
	lower := int(rank - 1)
	fraction := rank - 1 - float64(lower)
	return sorted[lower] + fraction*(sorted[lower+1]-sorted[lower])
}

// quantileConfidenceInterval returns a non-parametric confidence interval for
// the q quantile using the normal approximation of the quantile's sampling
// rank (order-statistic method). sorted must be ascending. Bounds collapse to
// the sample extremes for small n, which the precision gate rejects.
func quantileConfidenceInterval(sorted []float64, q, confidence float64) QuantileInterval {
	n := len(sorted)
	if n == 0 {
		return QuantileInterval{N: 0, Interval: Interval{Lower: math.NaN(), Upper: math.NaN()}, Estimate: math.NaN()}
	}
	nf := float64(n)
	centerRank := 1 + q*(nf-1)
	estimate := rankValue(sorted, centerRank)
	z := invNormal(1 - (1-confidence)/2)
	rankStandardError := math.Sqrt(q * (1 - q) * nf)
	lowerRank := math.Max(1, math.Min(nf, centerRank-z*rankStandardError))
	upperRank := math.Max(1, math.Min(nf, centerRank+z*rankStandardError))
	return QuantileInterval{
		Estimate: estimate,
		N:        n,
		Interval: Interval{
			Lower: rankValue(sorted, lowerRank),
			Upper: rankValue(sorted, upperRank),
		},
	}
}
