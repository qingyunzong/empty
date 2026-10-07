cmake_minimum_required(VERSION 3.20)
project(ast_reducer CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(reducer_core INTERFACE)
target_include_directories(reducer_core INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_options(reducer_core INTERFACE -Wall -Wextra)

add_executable(reduce src/main.cpp)
target_link_libraries(reduce PRIVATE reducer_core)

enable_testing()
add_executable(reducer_tests tests/test_main.cpp)
target_link_libraries(reducer_tests PRIVATE reducer_core)

foreach(case roundtrip transforms reduce_minimality cache_env trajectory bounded_verify)
  add_test(NAME ${case} COMMAND reducer_tests ${case})
endforeach()
