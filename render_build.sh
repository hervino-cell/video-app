#!/usr/bin/env bash
set -e
npm install
npm run build 2>/dev/null || true