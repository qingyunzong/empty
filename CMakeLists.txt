cmake_minimum_required(VERSION 3.16)
project(dlks_q269 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(interlaced_reconstructor
    src/interlaced_reconstructor.cpp
)
target_include_directories(interlaced_reconstructor
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_options(interlaced_reconstructor PRIVATE -Wall -Wextra -Wpedantic)

add_executable(test_reconstructor
    tests/test_reconstructor.cpp
)
target_link_libraries(test_reconstructor PRIVATE interlaced_reconstructor)
target_include_directories(test_reconstructor PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
target_compile_options(test_reconstructor PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_test(NAME reconstructor COMMAND test_reconstructor)
