cmake_minimum_required(VERSION 3.16)
project(counter_set LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(counter_set src/counter_set.cpp)
target_include_directories(counter_set PUBLIC include)

add_executable(counter_set_cli src/main.cpp)
target_link_libraries(counter_set_cli PRIVATE counter_set)

enable_testing()
add_executable(counter_set_test tests/counter_set_test.cpp)
target_link_libraries(counter_set_test PRIVATE counter_set)
add_test(NAME counter_set_test COMMAND counter_set_test)
