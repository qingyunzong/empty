cmake_minimum_required(VERSION 3.16)
project(rect_union LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(rect_union src/rect_union.cpp)
target_include_directories(rect_union PUBLIC include)
target_compile_options(rect_union PRIVATE -Wall -Wextra -Wpedantic)

add_executable(rect_tool src/main.cpp)
target_link_libraries(rect_tool PRIVATE rect_union)

enable_testing()
add_executable(rect_union_test tests/test_rect_union.cpp)
target_link_libraries(rect_union_test PRIVATE rect_union)
target_compile_options(rect_union_test PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME rect_union_test COMMAND rect_union_test)
