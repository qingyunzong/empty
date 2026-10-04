cmake_minimum_required(VERSION 3.16)
project(linktool CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_library(linktool src/parse.cpp src/link.cpp src/interp.cpp)
target_include_directories(linktool PUBLIC include)
target_compile_options(linktool PRIVATE -Wall -Wextra -Wpedantic)

add_executable(ltlink src/main.cpp)
target_link_libraries(ltlink PRIVATE linktool)

enable_testing()
add_executable(test_link tests/test_link.cpp)
target_link_libraries(test_link PRIVATE linktool)
add_test(NAME unit COMMAND test_link)

add_test(
  NAME cli_cycle
  COMMAND ltlink --entry boot --check
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/cycle_a.obj
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/cycle_b.obj)

add_test(
  NAME cli_weak_order
  COMMAND ltlink --entry main --check
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/weak_first.obj
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/weak_second.obj)

add_test(
  NAME cli_strong_conflict
  COMMAND ltlink --entry main
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/conflict_a.obj
          ${CMAKE_CURRENT_SOURCE_DIR}/tests/data/conflict_b.obj)
set_tests_properties(cli_strong_conflict PROPERTIES WILL_FAIL TRUE)
