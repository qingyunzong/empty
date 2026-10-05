cmake_minimum_required(VERSION 3.20)
project(binidx LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

add_library(binidx src/binidx.cpp)
target_include_directories(binidx PUBLIC include)

add_executable(idxcheck src/idxcheck.cpp)
target_link_libraries(idxcheck PRIVATE binidx)

add_executable(idxgen src/idxgen.cpp)
target_link_libraries(idxgen PRIVATE binidx)

add_executable(unit_tests tests/unit_tests.cpp)
target_link_libraries(unit_tests PRIVATE binidx)

find_package(Python3 COMPONENTS Interpreter REQUIRED)

enable_testing()

add_test(NAME unit COMMAND unit_tests)

# Fixture generation runs once; every crosscheck test depends on it.
set(FIXTURES_DIR ${CMAKE_BINARY_DIR}/fixtures)
add_test(NAME gen_fixtures COMMAND idxgen emit ${FIXTURES_DIR})
set_tests_properties(gen_fixtures PROPERTIES FIXTURES_SETUP fixtures)

set(CASES
  valid_basic
  valid_shared
  valid_zero_length
  valid_extreme_end
  valid_empty
  invalid_end_overflow
  invalid_len_max
  invalid_offset_max_len1
  invalid_partial_overlap
  invalid_containment
  invalid_shared_prefix
  bad_magic
  truncated_header
  truncated_entries
  trailing_bytes
  count_huge
  view_ok
  view_exceeds
)

foreach(case IN LISTS CASES)
  add_test(
    NAME check_${case}
    COMMAND ${Python3_EXECUTABLE}
            ${CMAKE_CURRENT_SOURCE_DIR}/tests/crosscheck.py
            $<TARGET_FILE:idxcheck> ${FIXTURES_DIR} ${case})
  set_tests_properties(check_${case} PROPERTIES FIXTURES_REQUIRED fixtures)
endforeach()
