cmake_minimum_required(VERSION 3.16)
project(rope LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_library(rope INTERFACE)
target_include_directories(rope INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(MSVC)
  target_compile_options(rope INTERFACE /W4)
else()
  target_compile_options(rope INTERFACE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

add_executable(rope_tests tests/rope_tests.cpp)
target_link_libraries(rope_tests PRIVATE rope)

foreach(case unit utf8 random lifetime overflow)
  add_test(NAME rope_${case} COMMAND rope_tests ${case})
endforeach()
