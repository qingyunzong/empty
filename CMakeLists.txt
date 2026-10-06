cmake_minimum_required(VERSION 3.20)
project(columnar_cli CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(columnar src/blocks.cpp)
target_include_directories(columnar PUBLIC include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(columnar PRIVATE -Wall -Wextra)
endif()

add_executable(colcli src/main.cpp)
target_link_libraries(colcli PRIVATE columnar)

enable_testing()

add_executable(engine_test tests/engine_test.cpp)
target_link_libraries(engine_test PRIVATE columnar)
add_test(NAME engine_test COMMAND engine_test)

# CLI end-to-end tests through CTest.
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/empty.col "")

add_test(NAME cli_gen
         COMMAND colcli write ${CMAKE_CURRENT_BINARY_DIR}/sample.col 1000 42)
add_test(NAME cli_agg
         COMMAND colcli agg ${CMAKE_CURRENT_BINARY_DIR}/sample.col)
set_tests_properties(cli_agg PROPERTIES
  DEPENDS cli_gen
  PASS_REGULAR_EXPRESSION "^rows=1000 sum=-?[0-9]+")
add_test(NAME cli_filter
         COMMAND colcli filter ${CMAKE_CURRENT_BINARY_DIR}/sample.col <= -500)
set_tests_properties(cli_filter PROPERTIES DEPENDS cli_gen)
add_test(NAME cli_agg_filtered
         COMMAND colcli agg ${CMAKE_CURRENT_BINARY_DIR}/sample.col >= 100)
set_tests_properties(cli_agg_filtered PROPERTIES
  DEPENDS cli_gen
  PASS_REGULAR_EXPRESSION "^count=[0-9]+ sum=-?[0-9]+")

# Corrupt input must fail (non-zero exit), publishing no partial results.
add_test(NAME cli_corrupt COMMAND colcli agg ${CMAKE_CURRENT_BINARY_DIR}/empty.col)
set_tests_properties(cli_corrupt PROPERTIES WILL_FAIL TRUE)
add_test(NAME cli_corrupt_filter
         COMMAND colcli filter ${CMAKE_CURRENT_BINARY_DIR}/empty.col = 1)
set_tests_properties(cli_corrupt_filter PROPERTIES WILL_FAIL TRUE)
