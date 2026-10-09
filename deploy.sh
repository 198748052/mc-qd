#!/usr/bin/env bash
#
# MonkeyCode 自动签到 —— 一键部署脚本（克隆/更新 + 安装）
#
# 用法：
#   sudo bash deploy.sh                 # 克隆（或更新）并用默认参数安装
#   sudo bash deploy.sh --port 27183    # 其余参数原样透传给 install.sh
#   sudo bash deploy.sh --host 127.0.0.1
#
# 说明：
#   - 可重复执行：已有仓库则 git pull 更新，没有则 clone
#   - 自动修复 Git 的 safe.directory 与目录属主问题
#   - 不带参数时默认 --host 0.0.0.0，方便直接用浏览器打开面板
#   - 可用环境变量覆盖：REPO_URL、REPO_DIR、BRANCH

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/198748052/mc-qd.git}"
BRANCH="${BRANCH:-main}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 脚本在仓库内则直接用它所在目录，否则用 REPO_DIR（默认 /root/mc-qd）作为克隆目标
if [[ -f "$SELF_DIR/install.sh" && -f "$SELF_DIR/node/src/server.js" ]]; then
  REPO_DIR="$SELF_DIR"
else
  REPO_DIR="${REPO_DIR:-/root/mc-qd}"
fi

c_info() { printf '\033[36m[信息]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; }

if [[ $EUID -ne 0 ]]; then
  c_err "请用 root 运行：sudo bash deploy.sh"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  c_err "未安装 git，请先安装：apt install -y git"
  exit 1
fi

c_info "仓库地址：$REPO_URL"
c_info "部署目录：$REPO_DIR"

# --------------------------------------------------------------------------- #
# 1. 克隆或更新代码
# --------------------------------------------------------------------------- #
if [[ -d "$REPO_DIR/.git" ]]; then
  c_info "检测到已有仓库，更新到最新 ..."
  # 之前的安装可能把目录属主改成 www，导致 git 报 dubious ownership，这里统一修回 root
  chown -R root:root "$REPO_DIR" 2>/dev/null || true
  git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO_DIR" \
    || git config --global --add safe.directory "$REPO_DIR"
  if ! git -C "$REPO_DIR" fetch --prune origin "$BRANCH"; then
    c_err "git fetch 失败，请检查网络或仓库地址"
    exit 1
  fi
  if ! git -C "$REPO_DIR" merge --ff-only "origin/$BRANCH"; then
    c_err "无法快进更新（本地可能有改动）"
    c_err "如需强制以远程为准：cd $REPO_DIR && git reset --hard origin/$BRANCH"
    exit 1
  fi
  c_ok "代码已更新到 $(git -C "$REPO_DIR" rev-parse --short HEAD)"
else
  if [[ -d "$REPO_DIR" && -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]]; then
    c_err "目录 $REPO_DIR 已存在且非空，但不是 Git 仓库"
    c_err "请先清空该目录，或指定其它目录：REPO_DIR=/root/mc-qd-new sudo bash deploy.sh"
    exit 1
  fi
  c_info "克隆仓库到 $REPO_DIR ..."
  mkdir -p "$REPO_DIR"
  if ! git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"; then
    c_err "git clone 失败，请检查网络或仓库地址"
    exit 1
  fi
  c_ok "克隆完成：$(git -C "$REPO_DIR" rev-parse --short HEAD)"
fi

# --------------------------------------------------------------------------- #
# 2. 调用 install.sh（参数透传）
#    未显式指定 --host 时，默认对外监听 0.0.0.0，方便直接用浏览器打开面板；
#    想只允许本机/反代访问，传 --host 127.0.0.1 即可。
# --------------------------------------------------------------------------- #
HAS_HOST=0
for a in "$@"; do
  [[ "$a" == "--host" ]] && HAS_HOST=1
done
if [[ $HAS_HOST -eq 0 ]]; then
  c_warn "未指定 --host，默认对外监听 0.0.0.0（面板含登录凭证，请用防火墙限制来源）"
  set -- --host 0.0.0.0 "$@"
fi

c_info "开始安装 ..."
exec bash "$REPO_DIR/install.sh" "$@"
