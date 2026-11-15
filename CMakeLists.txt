cmake_minimum_required(VERSION 3.16)
project(dataeng LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dataeng dataeng.cpp)
target_include_directories(dataeng PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_features(dataeng PUBLIC cxx_std_20)

if(MSVC)
    target_compile_options(dataeng PRIVATE /W4)
else()
    target_compile_options(dataeng PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()

add_executable(dataeng_tests tests/test_dataeng.cpp)
target_link_libraries(dataeng_tests PRIVATE dataeng)
add_test(NAME dataeng_tests COMMAND dataeng_tests)
