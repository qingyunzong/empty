cmake_minimum_required(VERSION 3.20)
project(xreduce CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

add_library(xreduce INTERFACE)
target_include_directories(xreduce INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(xreduce INTERFACE Threads::Threads)
target_compile_options(xreduce INTERFACE -Wall -Wextra)

enable_testing()

set(XREDUCE_TESTS
    test_bigint
    test_rational
    test_determinism
    test_cancel
    test_failure
    test_barrier)

foreach(t IN LISTS XREDUCE_TESTS)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE xreduce)
  target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  add_test(NAME ${t} COMMAND ${t})
endforeach()

# Records actual computed results into a file next to the binary.
add_executable(record_results tests/record_results.cpp)
target_link_libraries(record_results PRIVATE xreduce)
target_include_directories(record_results PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
add_test(NAME record_results
         COMMAND record_results ${CMAKE_CURRENT_BINARY_DIR}/actual_results.txt)
set_tests_properties(record_results PROPERTIES
  PASS_REGULAR_EXPRESSION "results recorded")
