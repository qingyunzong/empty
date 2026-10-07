cmake_minimum_required(VERSION 3.20)
project(units LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(units INTERFACE)
target_include_directories(units INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(MSVC)
    target_compile_options(units INTERFACE /W4)
else()
    target_compile_options(units INTERFACE -Wall -Wextra)
endif()

enable_testing()
add_executable(units_tests tests/test_units.cpp)
target_link_libraries(units_tests PRIVATE units)
add_test(NAME units_tests COMMAND units_tests)
