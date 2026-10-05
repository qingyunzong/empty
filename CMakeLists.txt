cmake_minimum_required(VERSION 3.20)
project(bq_bounded_queue LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

set(BQ_SANITIZE "" CACHE STRING "Enable a sanitizer: address|undefined|thread")
if(BQ_SANITIZE)
  add_compile_options(-fsanitize=${BQ_SANITIZE} -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=${BQ_SANITIZE})
endif()

add_library(bounded_queue INTERFACE)
target_include_directories(bounded_queue INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(bounded_queue INTERFACE cxx_std_20)

find_package(Threads REQUIRED)

enable_testing()
set(BQ_TESTS
  test_basic
  test_exception_safety
  test_close
  test_linearizability
)
foreach(t IN LISTS BQ_TESTS)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE bounded_queue Threads::Threads)
  target_compile_options(${t} PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME ${t} COMMAND ${t})
  set_tests_properties(${t} PROPERTIES TIMEOUT 120)
endforeach()
