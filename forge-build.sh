#!/bin/bash
# forge-build.sh — 本地构建 Forge（与 GitHub Actions 一致）
# 用法: ./forge-build.sh [platform]
# 默认构建所有平台，可指定: win32-x64 win32-arm64

set -e
cd "$(dirname "$0")"

PLATFORM="${1:-all}"

echo "🔨 Building Forge (Docker-based, same as GitHub Actions)..."
echo "   Platform: $PLATFORM"

# Build the Docker image (caches deps)
docker build -t forge-builder -f Dockerfile.build .

# Run build
if [ "$PLATFORM" = "all" ]; then
  docker run --rm -v "$PWD:/workspace" forge-builder
else
  docker run --rm -v "$PWD:/workspace" forge-builder \
    bun run --cwd packages/opencode build --single
fi

echo ""
echo "✅ Build complete!"
echo "   Output: packages/opencode/dist/"
ls -lh packages/opencode/dist/ 2>/dev/null | head -10
