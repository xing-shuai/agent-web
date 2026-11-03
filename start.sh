#!/usr/bin/env bash
# Devin Web 启动脚本
#
#   ./start.sh             启动服务（自动装依赖、按需构建前端）
#   ./start.sh dev         开发模式（node --watch 后端 + vite 热更新前端 :5173）
#   ./start.sh --rebuild   强制重新构建前端后启动
#   PORT=9000 ./start.sh   指定端口（默认 8787，HOST 默认 127.0.0.1）
#
set -euo pipefail
cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
MODE="start"

for arg in "$@"; do
  case "$arg" in
    dev) MODE="dev" ;;
    --rebuild) REBUILD=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

say() { printf '\033[1;35m[devin-web]\033[0m %s\n' "$*"; }

# 已在运行则直接提示
if curl -sf -m 2 "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
  say "服务已在 ${URL} 运行中"
  exit 0
fi

if [ ! -d node_modules ]; then
  say "安装依赖…"
  npm install
fi

if [ "$MODE" = "dev" ]; then
  say "开发模式：后端 :${PORT} (watch) + 前端 vite :5173"
  PORT=$PORT HOST=$HOST npm run dev -w server &
  trap 'kill %1 2>/dev/null' EXIT
  npm run dev -w web
  exit 0
fi

needs_build() {
  [ ! -f web/dist/index.html ] && return 0
  find web/src web/index.html web/vite.config.js \
    -type f -newer web/dist/index.html 2>/dev/null | grep -q . && return 0
  return 1
}

if [ -n "${REBUILD:-}" ] || needs_build; then
  say "构建前端…"
  npm run build
fi

say "启动 ${URL}（会话数据: server/data/，日志: Ctrl+C 退出）"
( sleep 1.5
  if curl -sf -m 3 "${URL}/api/health" >/dev/null 2>&1; then
    command -v xdg-open >/dev/null && xdg-open "${URL}" >/dev/null 2>&1 &
  fi ) &
exec env PORT=$PORT HOST=$HOST npm run start -w server
