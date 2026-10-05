cmake_minimum_required(VERSION 3.20)
project(asm_layout CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(asmlayout src/layout.cpp)
target_include_directories(asmlayout PUBLIC src)
target_compile_options(asmlayout PRIVATE -Wall -Wextra)

add_executable(asmlayout_cli src/main.cpp)
target_link_libraries(asmlayout_cli PRIVATE asmlayout)

enable_testing()
add_executable(test_layout tests/test_layout.cpp)
target_link_libraries(test_layout PRIVATE asmlayout)

add_test(NAME basic   COMMAND test_layout basic)
add_test(NAME cascade COMMAND test_layout cascade)
add_test(NAME random  COMMAND test_layout random)
add_test(NAME limit   COMMAND test_layout limit)
add_test(NAME verify  COMMAND test_layout verify)
