cmake_minimum_required(VERSION 3.20)
project(wrapfix LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(wrapfix_core
  src/interval_set.cpp
  src/parser.cpp
  src/analysis.cpp
  src/verify.cpp)
target_include_directories(wrapfix_core PUBLIC src)
target_compile_options(wrapfix_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(analyzer src/main.cpp)
target_link_libraries(analyzer PRIVATE wrapfix_core)

add_executable(unit_tests tests/unit_tests.cpp)
target_link_libraries(unit_tests PRIVATE wrapfix_core)

enable_testing()
add_test(NAME unit COMMAND unit_tests)

set(EXAMPLES countdown wrap7 four_segments five_branches input_echo)
foreach(ex ${EXAMPLES})
  add_test(NAME cli_${ex}
           COMMAND analyzer ${CMAKE_CURRENT_SOURCE_DIR}/examples/${ex}.sl)
  set_tests_properties(cli_${ex} PROPERTIES
    PASS_REGULAR_EXPRESSION "VERDICT: PASS")
endforeach()

add_test(NAME cli_no_args COMMAND analyzer)
set_tests_properties(cli_no_args PROPERTIES WILL_FAIL TRUE)
