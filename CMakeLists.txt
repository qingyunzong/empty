cmake_minimum_required(VERSION 3.16)
project(dlks_q252 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(font_contour INTERFACE)
target_include_directories(font_contour INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(test_contour tests/test_contour.cpp)
target_link_libraries(test_contour PRIVATE font_contour)
target_compile_options(test_contour PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME contour COMMAND test_contour)
