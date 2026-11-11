cmake_minimum_required(VERSION 3.16)
project(dlks_q258 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(spatial_audio_convolution
    src/fft.cpp
    src/streaming_convolver.cpp
)
target_include_directories(spatial_audio_convolution
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_options(spatial_audio_convolution
    PRIVATE -Wall -Wextra -Wpedantic
)

add_executable(test_streaming_convolver
    tests/test_streaming_convolver.cpp
)
target_link_libraries(test_streaming_convolver
    PRIVATE spatial_audio_convolution
)
target_compile_options(test_streaming_convolver
    PRIVATE -Wall -Wextra -Wpedantic
)

enable_testing()
add_test(NAME streaming_convolver
    COMMAND test_streaming_convolver
)
