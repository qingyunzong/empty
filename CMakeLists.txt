cmake_minimum_required(VERSION 3.16)
project(dlks_q248 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(frame_compositor STATIC
    src/frame_compositor.cpp
)
target_include_directories(frame_compositor PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_options(frame_compositor PRIVATE -Wall -Wextra -Wpedantic)

add_executable(test_compositor
    tests/test_compositor.cpp
)
target_link_libraries(test_compositor PRIVATE frame_compositor)
target_compile_options(test_compositor PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME compositor_tests COMMAND test_compositor)
