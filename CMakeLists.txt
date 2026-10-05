cmake_minimum_required(VERSION 3.16)
project(gatesim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_compile_options(-Wall -Wextra)

add_library(gatesim src/gatesim.cpp)
target_include_directories(gatesim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

add_executable(gatesim_demo src/demo.cpp)
target_link_libraries(gatesim_demo PRIVATE gatesim)

add_executable(gatesim_tests tests/test_main.cpp)
target_include_directories(gatesim_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
target_link_libraries(gatesim_tests PRIVATE gatesim)

enable_testing()
foreach(case IN ITEMS
    inertial_cancel
    pulse_equal_delay
    stale_generation
    zero_delay_delta
    xor_glitch
    delay_loop
    random_crosscheck)
  add_test(NAME ${case} COMMAND gatesim_tests ${case})
endforeach()
