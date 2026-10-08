cmake_minimum_required(VERSION 3.20)
project(loop_analyzer CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_compile_options(-Wall -Wextra)

add_library(loops src/loops.cpp)
target_include_directories(loops PUBLIC src)

add_executable(loop-analyzer src/main.cpp)
target_link_libraries(loop-analyzer PRIVATE loops)

enable_testing()

add_executable(test_loops tests/test_loops.cpp)
target_link_libraries(test_loops PRIVATE loops)
add_test(NAME unit COMMAND test_loops)

# CLI end-to-end tests on sample graphs.
add_test(NAME cli_nested
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/nested.txt)
set_tests_properties(cli_nested PROPERTIES
  PASS_REGULAR_EXPRESSION "Natural loops: 2")

add_test(NAME cli_nested_containment
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/nested.txt)
set_tests_properties(cli_nested_containment PROPERTIES
  PASS_REGULAR_EXPRESSION "    header=C body=\\{C, D\\}")

add_test(NAME cli_irreducible
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/irreducible.txt)
set_tests_properties(cli_irreducible PROPERTIES
  PASS_REGULAR_EXPRESSION "Irreducible loops: 1")

add_test(NAME cli_multi_backedge
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/multi_backedge.txt)
set_tests_properties(cli_multi_backedge PROPERTIES
  PASS_REGULAR_EXPRESSION "back_edges=\\{C->B, D->B\\}")

add_test(NAME cli_split
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/irreducible.txt --split)
set_tests_properties(cli_split PROPERTIES
  PASS_REGULAR_EXPRESSION "Split graph")

add_test(NAME cli_split_reducible
         COMMAND loop-analyzer ${CMAKE_CURRENT_SOURCE_DIR}/tests/graphs/irreducible.txt --split)
set_tests_properties(cli_split_reducible PROPERTIES
  PASS_REGULAR_EXPRESSION "A#0")
