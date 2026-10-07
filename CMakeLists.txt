cmake_minimum_required(VERSION 3.16)
project(seqcheck CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(seqcheck_core src/checker.cpp)
target_include_directories(seqcheck_core PUBLIC src)
target_compile_options(seqcheck_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(seqcheck src/main.cpp)
target_link_libraries(seqcheck PRIVATE seqcheck_core)

enable_testing()

add_executable(test_checker tests/test_checker.cpp)
target_link_libraries(test_checker PRIVATE seqcheck_core)
add_test(NAME unit COMMAND test_checker)

# CLI end-to-end tests via a driver that checks exit code + output regex.
function(add_cli_test name expect_rc expect_regex)
  add_test(NAME ${name}
    COMMAND ${CMAKE_COMMAND}
      -DSEQCHECK=$<TARGET_FILE:seqcheck>
      -DEXPECT_RC=${expect_rc}
      "-DEXPECT_REGEX=${expect_regex}"
      "-DCLI_ARGS=${ARGN}"
      -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/run_cli.cmake)
endfunction()

set(EX ${CMAKE_CURRENT_SOURCE_DIR}/examples)

# Clean log passes.
add_cli_test(cli_ok 0 "^OK: "
  --modulus 4 --window 2 ${EX}/ok.log)

# Retransmissions are ignored, not new deliveries.
add_cli_test(cli_retrans 0 "3 retransmissions ignored"
  --modulus 4 --window 2 ${EX}/retrans.log)

# Gap log fails with the first conflict and original-packet evidence.
add_cli_test(cli_gap 1 "CONFLICT line 7.*evidence: line 7: \"1 3\""
  --modulus 4 --window 2 ${EX}/gap.log)

# Exhaustive reference cross-check agrees on a small log.
add_cli_test(cli_reference_check 0 "reference-check: exhaustive search agrees"
  --modulus 4 --window 2 --reference-check ${EX}/ok.log)

# Invalid window/modulus pair is rejected.
add_cli_test(cli_bad_params 2 "2.window <= modulus"
  --modulus 4 --window 3 ${EX}/ok.log)
