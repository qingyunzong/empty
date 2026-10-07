cmake_minimum_required(VERSION 3.20)
project(seqcheck CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(seqcheck_core src/checker.cpp)
target_include_directories(seqcheck_core PUBLIC src)
target_compile_options(seqcheck_core PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic>)

add_executable(seqcheck src/main.cpp)
target_link_libraries(seqcheck PRIVATE seqcheck_core)
target_compile_options(seqcheck PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic>)

enable_testing()

add_executable(test_checker tests/test_checker.cpp)
target_link_libraries(test_checker PRIVATE seqcheck_core)
add_test(NAME unit_and_exhaustive COMMAND test_checker)

set(LOGS ${CMAKE_CURRENT_SOURCE_DIR}/tests/logs)
set(CLI_TEST ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_test.cmake)

function(add_cli_test name log mod win expect_exit expect_regex)
  add_test(NAME ${name} COMMAND ${CMAKE_COMMAND}
    -DEXE=$<TARGET_FILE:seqcheck>
    -DLOG=${log}
    -DMOD=${mod}
    -DWIN=${win}
    -DSTDIN_FILE=${LOGS}/ok.log
    -DEXPECT_EXIT=${expect_exit}
    "-DEXPECT_REGEX=${expect_regex}"
    -P ${CLI_TEST})
endfunction()

add_cli_test(cli_ok            ${LOGS}/ok.log             8 4 0
  "^OK: 7 packets, 6 delivered, 1 retransmissions, 2 streams")
add_cli_test(cli_ok_stdin      -                          8 4 0
  "^OK: 7 packets, 6 delivered, 1 retransmissions, 2 streams")
add_cli_test(cli_wrap          ${LOGS}/wrap.log           8 4 0
  "^OK: 11 packets, 10 delivered, 1 retransmissions, 1 streams")
add_cli_test(cli_gap           ${LOGS}/gap.log            8 4 1
  "CONFLICT gap: line 4 stream 0 seq 3 .expected 2, modulus 8, window 4.")
add_cli_test(cli_gap_evidence  ${LOGS}/gap.log            8 4 1
  "packet: \"0 3\"")
add_cli_test(cli_out_of_window ${LOGS}/out_of_window.log  8 2 1
  "CONFLICT out-of-window: line 4 stream 0 seq 5 .expected 2, modulus 8, window 2.")
add_cli_test(cli_bad_line      ${LOGS}/bad_line.log       8 4 1
  "CONFLICT parse: line 2")
