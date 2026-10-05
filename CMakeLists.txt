cmake_minimum_required(VERSION 3.20)
project(points_to_analysis LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(points_to src/points_to.cpp)
target_include_directories(points_to PUBLIC include)
target_compile_options(points_to PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(pta_tests tests/test_points_to.cpp)
target_link_libraries(pta_tests PRIVATE points_to)
target_compile_options(pta_tests PRIVATE -Wall -Wextra -Wpedantic)

foreach(test_name
    copy_and_alloc
    field_store_load
    fixpoint_cycle
    alloc_site_distinction
    deletion_consistency
    delete_all)
  add_test(NAME ${test_name} COMMAND pta_tests ${test_name})
endforeach()
