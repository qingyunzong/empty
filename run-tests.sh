#!/usr/bin/env bash
set -o pipefail
node --test 2>&1 | tee test-results.txt
