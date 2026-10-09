#!/usr/bin/env bash
#
# MonkeyCode 自动签到 —— 一键安装脚本（Node.js 版）
#
# 用法：
#   bash install.sh                 # 安装到脚本所在目录（建议先 clone 到目标位置）
#   bash install.sh --port 27183    # 指定服务端口（默认 27183，避开常用端口）
#   bash install.sh --no-cron       # 不安装每日计划任务
#   bash install.sh --hour 9        # 计划任务执行时间（默认 8 点）
#   bash install.sh --update        # 只更新代码（git 拉取最新）并重启，等价于 update.sh
#   bash install.sh --update --force # 强制以远程代码为准
#
# 脚本做的事：
#   1. 查找可用的 Node.js（>= 20），支持宝塔的 Node 版本管理器
#   2. 生成 systemd 服务并启动（监听 127.0.0.1，由 Nginx 反代对外）
#   3. 写入每日计划任务 /etc/cron.d/monkeycode
#
# 零运行时依赖，无需 npm install。
# 可重复执行：同一脚本再跑一次即为更新。

set -euo pipefail

# --------------------------------------------------------------------------- #
# 参数与常量
# --------------------------------------------------------------------------- #
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SELF_DIR"
PORT=27183
HOUR=8
WITH_CRON=1
WITH_UPDATE=0
FORCE=0
SERVICE_NAME="monkeycode"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT="$2"; shift 2 ;;
    --hour)     HOUR="$2"; shift 2 ;;
    --no-cron)  WITH_CRON=0; shift ;;
    --update)   WITH_UPDATE=1; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看用法）"; exit 1 ;;
  esac
done

# 输出着色
c_info() { printf '\033[36m[信息]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; }

# --------------------------------------------------------------------------- #
# -1. 更新模式：委托给 update.sh，只更新代码 + 重启，不重复安装
# --------------------------------------------------------------------------- #
if [[ $WITH_UPDATE -eq 1 ]]; then
  UPDATE_SH="$INSTALL_DIR/update.sh"
  if [[ ! -f "$UPDATE_SH" ]]; then
    c_err "找不到 update.sh，无法执行更新"
    exit 1
  fi
  ARGS=()
  [[ $FORCE -eq 1 ]] && ARGS+=(--force)
  exec bash "$UPDATE_SH" "${ARGS[@]}"
fi

# --------------------------------------------------------------------------- #
# 0. 前置检查
# --------------------------------------------------------------------------- #
if [[ $EUID -ne 0 ]]; then
  c_err "请用 root 运行（systemd 与计划任务都需要写权限）：sudo bash install.sh"
  exit 1
fi

# 确认自己就在项目里（node/ 与 templates/ 必须存在）
if [[ ! -f "$INSTALL_DIR/node/src/server.js" || ! -f "$INSTALL_DIR/templates/index.html" ]]; then
  c_err "当前目录不是项目根目录，找不到 node/src/server.js 或 templates/index.html"
  c_err "请先 clone 项目，再在项目根目录执行本脚本"
  exit 1
fi

c_info "安装目录：$INSTALL_DIR"

# --------------------------------------------------------------------------- #
# 1. 查找 Node.js（>= 20）
#     优先用 PATH 里的，其次找宝塔 Node 版本管理器的安装路径
# --------------------------------------------------------------------------- #
find_node() {
  local candidates=() v major

  # a) PATH 里的 node
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  # b) 宝塔 Node 版本管理器的路径
  for p in /www/server/nodejs/v*/bin/node; do
    [[ -x "$p" ]] && candidates+=("$p")
  done
  # c) 常见手装路径
  for p in /usr/local/bin/node /usr/bin/node; do
    [[ -x "$p" ]] && candidates+=("$p")
  done

  # 取版本号最高且 >= 20 的那个
  # 注意：CentOS 7 的 bash 4.2 在 set -u 下遍历空数组会报 unbound variable，故加长度判断
  local best="" best_major=0
  if (( ${#candidates[@]} > 0 )); then
    for bin in "${candidates[@]}"; do
      v="$("$bin" -v 2>/dev/null || true)"
      [[ "$v" =~ ^v([0-9]+) ]] || continue
      major="${BASH_REMATCH[1]}"
      if (( major >= 20 && major > best_major )); then
        best="$bin"; best_major=$major
      fi
    done
  fi
  [[ -n "$best" ]] && echo "$best"
}

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  c_err "未找到 Node.js 20 或更高版本"
  echo
  echo "请任选一种方式安装后再运行本脚本："
  echo "  宝塔面板：软件商店 → Node.js版本管理器 → 安装 20 及以上版本"
  echo "  命令行  ：curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
  exit 1
fi
c_ok "使用 Node：$NODE_BIN（$("$NODE_BIN" -v)）"

# --------------------------------------------------------------------------- #
# 2. 确定运行用户（宝塔环境一般是 www）
# --------------------------------------------------------------------------- #
if id www >/dev/null 2>&1; then
  RUN_USER="www"
else
  RUN_USER="root"
fi
c_info "服务运行用户：$RUN_USER"

# 服务以 RUN_USER 身份运行，而 config.json 写在项目根目录，
# 所以目录必须对该用户可写，否则扫码保存会静默失败。
chown "$RUN_USER" "$INSTALL_DIR" 2>/dev/null || true

# config.json 内含登录凭证，收紧权限
if [[ -f "$INSTALL_DIR/config.json" ]]; then
  chown "$RUN_USER" "$INSTALL_DIR/config.json" 2>/dev/null || true
  chmod 600 "$INSTALL_DIR/config.json" || true
  c_info "已收紧 config.json 权限（600）"
else
  c_warn "尚未配置登录凭证，请按末尾提示完成配置后再执行签到"
fi

# --------------------------------------------------------------------------- #
# 3. 生成 systemd 服务
# --------------------------------------------------------------------------- #
c_info "写入 systemd 服务 /etc/systemd/system/${SERVICE_NAME}.service"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=MonkeyCode Auto Check-in (Node.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}/node
Environment="HOST=127.0.0.1"
Environment="PORT=${PORT}"
ExecStart=${NODE_BIN} ${INSTALL_DIR}/node/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
# 加 || true：否则 set -e 会在启动失败时直接退出，跳过下面的诊断提示
systemctl restart "${SERVICE_NAME}" || true

# 等服务起来再判断
sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  c_ok "服务已启动，监听 127.0.0.1:${PORT}"
else
  c_err "服务启动失败，请查看日志：journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi

# --------------------------------------------------------------------------- #
# 4. 每日计划任务
# --------------------------------------------------------------------------- #
if [[ $WITH_CRON -eq 1 ]]; then
  c_info "写入每日计划任务 /etc/cron.d/${SERVICE_NAME}（每天 ${HOUR}:00）"

  # 预建日志文件并交给运行用户：cron 以该用户身份做重定向，
  # 而 /var/log 默认 root 独占，不预建会因权限不足静默丢弃日志
  LOG_FILE="/var/log/${SERVICE_NAME}-checkin.log"
  touch "$LOG_FILE"
  chown "$RUN_USER" "$LOG_FILE" 2>/dev/null || true

  cat > "/etc/cron.d/${SERVICE_NAME}" <<CRON
# MonkeyCode 每日自动签到
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 ${HOUR} * * * ${RUN_USER} cd ${INSTALL_DIR}/node && ${NODE_BIN} src/checkin.js >> ${LOG_FILE} 2>&1
CRON
  chmod 644 "/etc/cron.d/${SERVICE_NAME}"
  c_ok "计划任务已安装（日志：${LOG_FILE}）"
fi

# --------------------------------------------------------------------------- #
# 5. 收尾提示
# --------------------------------------------------------------------------- #
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<TIP

────────────────────────────────────────────────────────
 安装完成
────────────────────────────────────────────────────────
 服务状态   systemctl status ${SERVICE_NAME}
 服务日志   journalctl -u ${SERVICE_NAME} -f
 签到日志   tail -f /var/log/${SERVICE_NAME}-checkin.log
 手动签到   cd ${INSTALL_DIR}/node && ${NODE_BIN} src/checkin.js

 下一步：配置登录凭证（二选一）
   方式 A：浏览器打开 http://${IP:-服务器IP}:${PORT} 扫码登录
           ⚠ 默认只监听 127.0.0.1，需先用 SSH 端口转发：
             ssh -L ${PORT}:127.0.0.1:${PORT} root@${IP:-服务器IP}
             然后本地访问 http://127.0.0.1:${PORT}
   方式 B：把本机的 config.json 复制到 ${INSTALL_DIR}/config.json

   首次签到验证：${NODE_BIN} ${INSTALL_DIR}/node/src/checkin.js
────────────────────────────────────────────────────────
TIP