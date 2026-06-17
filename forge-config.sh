#!/bin/bash
# forge-config.sh — 配置 Forge 使用的模型和 Hub 认证
# 运行一次即可，配置持久化到 ~/.config/forge/

set -e

CONFIG_DIR="$HOME/.config/forge"
mkdir -p "$CONFIG_DIR"

# Write provider config
cat > "$CONFIG_DIR/settings.json" << 'CONFIG'
{
  "provider": {
    "anthropic": {
      "apiKey": "sk-c3c31522253646c5a9d66916caaea9ff",
      "baseURL": "https://api.deepseek.com/anthropic",
      "model": "deepseek-v4-pro[1M]"
    }
  },
  "model": "anthropic/deepseek-v4-pro[1M]"
}
CONFIG

echo "✅ Forge 配置已写入 $CONFIG_DIR/settings.json"
echo ""
echo "如需修改：vim $CONFIG_DIR/settings.json"
echo ""
echo "使用方式："
echo "  forge --goal \"你的目标\" --business 项目代号"
