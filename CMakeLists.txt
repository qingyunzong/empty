cmake_minimum_required(VERSION 3.20)
project(sreach VERSION 1.0 LANGUAGES CXX)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(sreach_core src/solver.cpp)
target_include_directories(sreach_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_options(sreach_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(sreach src/main.cpp)
target_link_libraries(sreach PRIVATE sreach_core)

enable_testing()

add_executable(sreach_tests tests/test_main.cpp)
target_link_libraries(sreach_tests PRIVATE sreach_core)
add_test(NAME unit COMMAND sreach_tests)

set(DATA ${CMAKE_CURRENT_SOURCE_DIR}/tests/data)

add_test(NAME cli_series COMMAND sreach ${DATA}/series.txt)
set_tests_properties(cli_series PROPERTIES PASS_REGULAR_EXPRESSION "probability: 1/6")

add_test(NAME cli_parallel COMMAND sreach ${DATA}/parallel.txt)
set_tests_properties(cli_parallel PROPERTIES PASS_REGULAR_EXPRESSION "probability: 3/4")

add_test(NAME cli_bridge COMMAND sreach --undirected ${DATA}/bridge.txt)
set_tests_properties(cli_bridge PROPERTIES PASS_REGULAR_EXPRESSION "probability: 1/2")

add_test(NAME cli_cycle COMMAND sreach ${DATA}/cycle.txt)
set_tests_properties(cli_cycle PROPERTIES PASS_REGULAR_EXPRESSION "probability: 5/8")

add_test(NAME cli_verify COMMAND sreach --verify ${DATA}/cycle.txt)
set_tests_properties(cli_verify PROPERTIES PASS_REGULAR_EXPRESSION "verify: OK")

add_test(NAME cli_budget COMMAND sreach --budget 10 --verify ${DATA}/budget.txt)
set_tests_properties(cli_budget PROPERTIES PASS_REGULAR_EXPRESSION
  "status: budget-exceeded(.|\n)*verify: OK")

add_test(NAME cli_dot COMMAND sreach --dot cycle.dot ${DATA}/cycle.txt)
set_tests_properties(cli_dot PROPERTIES PASS_REGULAR_EXPRESSION "dot: cycle.dot")
