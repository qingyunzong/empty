cmake_minimum_required(VERSION 3.20)
project(reachability CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

add_executable(rel src/main.cpp)
target_include_directories(rel PRIVATE src)

enable_testing()

add_executable(test_reliability tests/test_reliability.cpp)
target_include_directories(test_reliability PRIVATE src)
add_test(NAME unit COMMAND test_reliability)

# --- CLI end-to-end tests ---
set(DATA ${CMAKE_CURRENT_SOURCE_DIR}/tests/data)

add_test(NAME cli_bridge COMMAND rel --verify ${DATA}/bridge.txt)
set_tests_properties(cli_bridge PROPERTIES PASS_REGULAR_EXPRESSION "MATCH")

add_test(NAME cli_cycle COMMAND rel --verify ${DATA}/cycle.txt)
set_tests_properties(cli_cycle PROPERTIES PASS_REGULAR_EXPRESSION "MATCH")

add_test(NAME cli_abort_bounds COMMAND rel --budget 1 --verify ${DATA}/bridge.txt)
set_tests_properties(cli_abort_bounds PROPERTIES
  PASS_REGULAR_EXPRESSION "ABORTED")

add_test(NAME cli_abort_bounds_ok COMMAND rel --budget 3 --verify ${DATA}/big.txt)
set_tests_properties(cli_abort_bounds_ok PROPERTIES
  PASS_REGULAR_EXPRESSION "BOUNDS-OK")

add_test(NAME cli_dot
  COMMAND bash -c "$<TARGET_FILE:rel> --dot ${CMAKE_CURRENT_BINARY_DIR}/dd.dot ${DATA}/bridge.txt && grep -q digraph ${CMAKE_CURRENT_BINARY_DIR}/dd.dot")

add_test(NAME cli_bad_input COMMAND rel ${DATA}/bad.txt)
set_tests_properties(cli_bad_input PROPERTIES WILL_FAIL TRUE)
