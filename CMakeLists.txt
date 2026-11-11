cmake_minimum_required(VERSION 3.16)
project(dlks_q253 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(tangent_generator INTERFACE)
target_include_directories(tangent_generator INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(tangent_tests tests/test_tangents.cpp)
target_link_libraries(tangent_tests PRIVATE tangent_generator)
target_compile_options(tangent_tests PRIVATE
    -Wall -Wextra -Wpedantic -Werror)

add_test(NAME tangent_tests COMMAND tangent_tests)
