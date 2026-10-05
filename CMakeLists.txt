cmake_minimum_required(VERSION 3.20)
project(geom_predicates CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(geom src/predicates.cpp)
target_include_directories(geom PUBLIC include)
target_compile_options(geom PRIVATE -Wall -Wextra)

enable_testing()

add_executable(test_predicates tests/test_predicates.cpp)
target_link_libraries(test_predicates PRIVATE geom)

foreach(t
    bigint_model
    orient_basic
    orient_degenerate_id
    orient_near_collinear
    orient_fuzz
    incircle_basic
    incircle_near_cocircular
    incircle_fuzz)
  add_test(NAME ${t} COMMAND test_predicates ${t})
endforeach()
