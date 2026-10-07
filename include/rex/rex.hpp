#pragma once

// rex: a register expression library.
//
// Unsigned values of 8 to 64 bits, slicing and concatenation,
// addition modulo the result width, shifts that yield zero at or
// beyond the operand width, and short-circuit conditionals.
// Expressions compile to pausable, statically verified stack bytecode.

#include "ast.hpp"
#include "bytecode.hpp"
#include "compiler.hpp"
#include "eval.hpp"
#include "parser.hpp"
#include "regs.hpp"
#include "value.hpp"
#include "verifier.hpp"
#include "vm.hpp"
