#!/usr/bin/env bash
#
# MonkeyCode 自动签到 —— 在线更新脚本（Git / GitHub 仓库）
#
# 用法：
#   bash update.sh                 # 拉取远程最新代码并重启服务（默认 origin/main）
#   bash update.sh --force         # 本地有改动时强制以远程为准（丢弃已跟踪文件的本地改动）
#   bash update.sh --no-restart    # 只更新代码，不重启服务
#   bash update.sh --branch dev    # 指定要跟踪的分支
#   bash update.sh --remote origin # 指定远程名
#
# 脚本做的事：
#   1. 校验当前目录是 Git 仓库
#   2. 备份本地 config.json（内含登录凭证），更新后原样恢复，绝不覆盖
#   3. git fetch + 快进合并（--force 时改为 reset --hard）
#   4. 重启 systemd 服务 monkeycode
#
# 可重复执行；未加 --force 时不会丢弃本地任何未提交改动。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SELF_DIR"
BRANCH="main"
REMOTE="origin"
SERVICE_NAME="monkeycode"
FORCE=0
DO_RESTART=1
CONFIG_FILE="$INSTALL_DIR/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)      FORCE=1; shift ;;
    --no-restart) DO_RESTART=0; shift ;;
    --branch)     BRANCH="$2"; shift 2 ;;
    --remote)     REMOTE="$2"; shift 2 ;;
    -h|--help)    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看用法）"; exit 1 ;;
  esac
done

c_info() { printf '\033[36m[信息]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; }

# --------------------------------------------------------------------------- #
# 0. 前置检查
# --------------------------------------------------------------------------- #
command -v git >/dev/null 2>&1 || { c_err "未安装 git，无法在线更新"; exit 1; }

if ! git -C "$INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  c_err "当前目录不是 Git 仓库，无法在线更新"
  c_err "请改用 git clone <仓库地址> 重新部署"
  exit 1
fi

c_info "更新目录：$INSTALL_DIR"
c_info "远程：$REMOTE  分支：$BRANCH"

# --------------------------------------------------------------------------- #
# 1. 备份本地配置（config.json 已被 .gitignore 忽略，git 不会碰它；这里再加一层保险）
# --------------------------------------------------------------------------- #
CONFIG_BAK="$CONFIG_FILE.bak"
HAS_CONFIG=0
if [[ -f "$CONFIG_FILE" ]]; then
  cp -p "$CONFIG_FILE" "$CONFIG_BAK"
  chmod 600 "$CONFIG_BAK" 2>/dev/null || true
  HAS_CONFIG=1
  c_info "已备份本地 config.json（更新后保留）"
fi

restore_config() {
  if [[ "$HAS_CONFIG" -eq 1 && -f "$CONFIG_BAK" ]]; then
    cp -p "$CONFIG_BAK" "$CONFIG_FILE" 2>/dev/null || true
    chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  fi
}
trap restore_config EXIT

# --------------------------------------------------------------------------- #
# 2. 拉取并更新代码
# --------------------------------------------------------------------------- #
c_info "git fetch ${REMOTE} ${BRANCH} ..."
git -C "$INSTALL_DIR" fetch --prune "$REMOTE" "$BRANCH"

BEFORE="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

if [[ "$FORCE" -eq 1 ]]; then
  c_warn "强制以远程为准：git reset --hard ${REMOTE}/${BRANCH}"
  git -C "$INSTALL_DIR" reset --hard "${REMOTE}/${BRANCH}"
else
  c_info "快进合并 ${REMOTE}/${BRANCH} ..."
  if ! git -C "$INSTALL_DIR" merge --ff-only "${REMOTE}/${BRANCH}"; then
    c_err "无法快进更新（本地可能有未提交改动）"
    c_err "如需强制更新，请执行：bash update.sh --force"
    exit 1
  fi
fi

AFTER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  c_ok "代码已是最新（$AFTER），无需更新"
else
  c_ok "代码已更新：$BEFORE -> $AFTER"
  git -C "$INSTALL_DIR" log --oneline -1
fi

# --------------------------------------------------------------------------- #
# 3. 重启服务
# --------------------------------------------------------------------------- #
if [[ "$DO_RESTART" -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    c_info "重启服务 ${SERVICE_NAME} ..."
    if systemctl restart "$SERVICE_NAME"; then
      c_ok "服务已重启"
    else
      c_warn "重启失败，请手动执行：systemctl restart ${SERVICE_NAME}"
    fi
  else
    c_warn "未检测到 systemd 服务 ${SERVICE_NAME}，请手动重启服务"
  fi
fi

c_ok "更新流程结束"
