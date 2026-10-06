#pragma once

#include "regx/bytecode.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace regx {

// Pausable stack-machine interpreter. The VM is copyable: a copy taken at
// any instruction boundary resumes with identical observable behaviour, and
// the final result always matches direct AST evaluation of the source.
class VM {
public:
  enum class Status { Running, Done, Error };

  // regValues[i] is the current value of register slot i.
  VM(const Program& prog, std::vector<uint64_t> regValues);

  Status step(); // execute one instruction (no-op once Done/Error)
  Status run();  // step until Done or Error

  Status status() const { return status_; }
  uint64_t result() const { return result_; } // valid when status() == Done
  uint8_t resultWidth() const { return prog_->resultWidth; }
  const std::string& error() const { return error_; }

  size_t pc() const { return pc_; }
  size_t stackDepth() const { return stack_.size(); }

private:
  Status fail(std::string msg);

  const Program* prog_;
  std::vector<uint64_t> regs_;
  std::vector<Value> stack_;
  size_t pc_ = 0;
  Status status_ = Status::Running;
  uint64_t result_ = 0;
  std::string error_;
};

} // namespace regx
