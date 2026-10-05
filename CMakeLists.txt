cmake_minimum_required(VERSION 3.20)
project(interval_index CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(INTERVAL_INDEX_SANITIZERS "Build tests with ASan+UBSan" OFF)

find_package(Threads REQUIRED)

add_library(interval_index INTERFACE)
target_include_directories(interval_index INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(interval_index INTERFACE cxx_std_20)

enable_testing()

foreach(t IN ITEMS semantics model lifetime)
    add_executable(test_${t} tests/test_${t}.cpp)
    target_include_directories(test_${t} PRIVATE tests)
    target_link_libraries(test_${t} PRIVATE interval_index Threads::Threads)
    target_compile_options(test_${t} PRIVATE -Wall -Wextra -Wpedantic -O2 -g)
    if(INTERVAL_INDEX_SANITIZERS)
        target_compile_options(test_${t} PRIVATE -fsanitize=address,undefined)
        target_link_options(test_${t} PRIVATE -fsanitize=address,undefined)
    endif()
    add_test(NAME ${t} COMMAND test_${t})
endforeach()
