cmake_minimum_required(VERSION 3.20)
project(geom_predicates CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(geom src/predicates.cpp)
target_include_directories(geom PUBLIC include)
target_compile_options(geom PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(test_predicates tests/test_predicates.cpp)
target_link_libraries(test_predicates PRIVATE geom)

foreach(case
        orient_basic orient_id_rule orient_extrema orient_fuzz
        incircle_basic incircle_id_rule incircle_extrema incircle_fuzz)
    add_test(NAME ${case} COMMAND test_predicates ${case})
endforeach()
