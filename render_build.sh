#!/usr/bin/env bash
set -e
echo "📦 Installing dependencies..."
npm install
echo "🔨 Building mediasoup-client bundle..."
npm run build
echo "✅ Build complete"