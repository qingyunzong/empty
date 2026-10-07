cmake_minimum_required(VERSION 3.20)
project(ast_reduce CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(astreduce
  src/ast.cpp
  src/sha1.cpp
  src/transform.cpp
  src/predicate.cpp
  src/reduce.cpp
)
target_include_directories(astreduce PUBLIC src)
target_compile_options(astreduce PRIVATE -Wall -Wextra)

add_executable(ast-reduce src/main.cpp)
target_link_libraries(ast-reduce PRIVATE astreduce)

enable_testing()

foreach(t IN ITEMS ast transform cache reduce)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE astreduce)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()

add_test(NAME cli_reduce_ok
  COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli/reduce_ok.sh
          $<TARGET_FILE:ast-reduce> ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME cli_bad_predicate
  COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli/bad_predicate.sh
          $<TARGET_FILE:ast-reduce> ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME cli_flaky_predicate
  COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli/flaky_predicate.sh
          $<TARGET_FILE:ast-reduce> ${CMAKE_CURRENT_SOURCE_DIR})
