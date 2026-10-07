cmake_minimum_required(VERSION 3.20)
project(tilelib LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(tilelib INTERFACE)
target_include_directories(tilelib INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(tilelib INTERFACE cxx_std_20)

if(MSVC)
    target_compile_options(tilelib INTERFACE /W4 /WX)
else()
    target_compile_options(tilelib INTERFACE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()

foreach(name IN ITEMS test_viewport test_cache test_loader test_conservation)
    add_executable(${name} tests/${name}.cpp)
    target_link_libraries(${name} PRIVATE tilelib)
    target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
    add_test(NAME ${name} COMMAND ${name})
endforeach()
