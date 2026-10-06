cmake_minimum_required(VERSION 3.20)
project(colcli CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options(-Wall -Wextra)

add_library(colcore src/column.cpp)
target_include_directories(colcore PUBLIC src)

add_executable(colcli src/main.cpp)
target_link_libraries(colcli PRIVATE colcore)

add_executable(coltest tests/test_column.cpp)
target_link_libraries(coltest PRIVATE colcore)

enable_testing()

# Unit tests: random data vs row-by-row reference, edge cases, corruption.
add_test(NAME unit_edge COMMAND coltest edge)
add_test(NAME unit_random COMMAND coltest random 60 20261006)
add_test(NAME unit_random_forced COMMAND coltest random 40 777)
add_test(NAME unit_corrupt COMMAND coltest corrupt)

# CLI end-to-end on a checked-in fixture.
set(SAMPLE_TXT ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/sample.txt)
set(SAMPLE_COL ${CMAKE_CURRENT_BINARY_DIR}/sample.col)

add_test(NAME cli_build COMMAND colcli build ${SAMPLE_TXT} ${SAMPLE_COL} 4)
add_test(NAME cli_agg COMMAND colcli agg ${SAMPLE_COL})
set_tests_properties(cli_agg PROPERTIES
  DEPENDS cli_build
  PASS_REGULAR_EXPRESSION "rows=10 non_null=7 sum=26")
add_test(NAME cli_filter_eq COMMAND colcli filter ${SAMPLE_COL} eq 5)
set_tests_properties(cli_filter_eq PROPERTIES
  DEPENDS cli_build
  PASS_REGULAR_EXPRESSION "0\n1\n2")
add_test(NAME cli_filter_gt COMMAND colcli filter ${SAMPLE_COL} gt 5)
set_tests_properties(cli_filter_gt PROPERTIES
  DEPENDS cli_build
  PASS_REGULAR_EXPRESSION "5\n6")
add_test(NAME cli_filter_le COMMAND colcli filter ${SAMPLE_COL} le 0)
set_tests_properties(cli_filter_le PROPERTIES
  DEPENDS cli_build
  PASS_REGULAR_EXPRESSION "4\n9")

# Error paths: missing file and unknown operator must fail.
add_test(NAME cli_missing_file COMMAND colcli agg /nonexistent/path.col)
set_tests_properties(cli_missing_file PROPERTIES WILL_FAIL TRUE)
add_test(NAME cli_bad_op COMMAND colcli filter ${SAMPLE_COL} like 3)
set_tests_properties(cli_bad_op PROPERTIES WILL_FAIL TRUE)
