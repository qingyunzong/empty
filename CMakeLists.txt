cmake_minimum_required(VERSION 3.20)
project(sergraph LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(ser INTERFACE)
target_include_directories(ser INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

option(SER_SANITIZERS "Enable ASan/UBSan for tests" ON)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# LeakSanitizer 在 ptrace 受限环境 (部分容器/沙箱) 下无法运行, 配置期探测;
# 不可用时关闭 ASan 的泄漏检测 (泄漏改由测试内的 live_count 计数严格校验)。
set(SER_TEST_ENV "")
if(SER_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  include(CheckCXXSourceRuns)
  set(CMAKE_REQUIRED_FLAGS "-fsanitize=address")
  set(CMAKE_REQUIRED_LINK_OPTIONS "-fsanitize=address")
  check_cxx_source_runs("int main() { return 0; }" SER_LSAN_WORKS)
  unset(CMAKE_REQUIRED_FLAGS)
  unset(CMAKE_REQUIRED_LINK_OPTIONS)
  if(NOT SER_LSAN_WORKS)
    message(STATUS "LeakSanitizer unavailable (ptrace-restricted); disabling detect_leaks")
    set(SER_TEST_ENV "ASAN_OPTIONS=detect_leaks=0")
  endif()
endif()

enable_testing()

set(SER_TESTS basic sharing_cycles stable_ids random_graph errors)
foreach(t IN LISTS SER_TESTS)
  add_executable(test_${t} tests/test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE ser)
  target_include_directories(test_${t} PRIVATE tests)
  if(SER_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(test_${t} PRIVATE -fsanitize=address,undefined
                                             -fno-omit-frame-pointer)
    target_link_options(test_${t} PRIVATE -fsanitize=address,undefined)
  endif()
  add_test(NAME ${t} COMMAND test_${t})
  if(SER_TEST_ENV)
    set_tests_properties(${t} PROPERTIES ENVIRONMENT "${SER_TEST_ENV}")
  endif()
endforeach()
