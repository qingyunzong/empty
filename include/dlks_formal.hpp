#pragma once

// Umbrella header for the embeddable expression component.
//
// Value/vector/column fundamentals:
#include "dlks/value.hpp"
#include "dlks/vector.hpp"
#include "dlks/column.hpp"
// Scalar kernels and expression compilation:
#include "dlks/kernel.hpp"
#include "dlks/expr.hpp"
// Evaluation results plus the vectorized and scalar engines:
#include "dlks/eval.hpp"
#include "dlks/vector_engine.hpp"
#include "dlks/scalar_engine.hpp"
// Differential-testing utilities:
#include "dlks/differential.hpp"
#include "dlks/random.hpp"
