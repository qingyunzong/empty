cmake_minimum_required(VERSION 3.20)
project(interval_index LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

option(IX_SANITIZER "Build tests with a sanitizer (asan|tsan|ubsan)" "")

add_library(interval_index INTERFACE)
target_include_directories(interval_index INTERFACE
  ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(interval_index INTERFACE cxx_std_20)

find_package(Threads REQUIRED)

enable_testing()

foreach(t IN ITEMS test_basic test_model test_lifetime)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE interval_index Threads::Threads)
  target_compile_options(${t} PRIVATE -Wall -Wextra -Wpedantic)
  if(IX_SANITIZER)
    target_compile_options(${t} PRIVATE
      -fsanitize=${IX_SANITIZER} -fno-omit-frame-pointer -g)
    target_link_options(${t} PRIVATE -fsanitize=${IX_SANITIZER})
  endif()
  add_test(NAME ${t} COMMAND ${t})
endforeach()
