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
#   bash install.sh --user root     # 指定服务运行用户（默认自动判断 www/root）
#   bash install.sh --host 0.0.0.0  # 监听地址（默认 127.0.0.1，仅本机/反代访问）
#   bash install.sh --panel-username admin   # 面板登录用户名（默认 admin）
#   bash install.sh --panel-password 123456  # 面板登录密码（不指定则自动生成）
#
# 脚本做的事：
#   1. 查找可用的 Node.js（>= 20），支持宝塔的 Node 版本管理器
#   2. 生成 systemd 服务并启动（监听 127.0.0.1，由 Nginx 反代对外）
#   3. 写入定时计划任务 /etc/cron.d/monkeycode（按面板配置的签到时间触发）
#   4. 生成面板登录账号（auth.json），保护签到页面与接口
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
HOST=127.0.0.1
HOUR=8
WITH_CRON=1
WITH_UPDATE=0
FORCE=0
RUN_USER_OPT=""
PANEL_USERNAME=""
PANEL_PASSWORD=""
SERVICE_NAME="monkeycode"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT="$2"; shift 2 ;;
    --host)     HOST="$2"; shift 2 ;;
    --hour)     HOUR="$2"; shift 2 ;;
    --no-cron)  WITH_CRON=0; shift ;;
    --update)   WITH_UPDATE=1; shift ;;
    --force)    FORCE=1; shift ;;
    --user)     RUN_USER_OPT="$2"; shift 2 ;;
    --panel-username) PANEL_USERNAME="$2"; shift 2 ;;
    --panel-password) PANEL_PASSWORD="$2"; shift 2 ;;
    -h|--help)  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# 2. 确定运行用户
#    优先 www（宝塔环境常见），但仅当 www 真能读到项目文件时才用。
#    若项目在 /root 等 700 权限目录下，www 无法进入，此时自动回退 root，
#    否则 systemd 会因目录不可访问而启动失败。
# --------------------------------------------------------------------------- #
# 检测指定用户能否读到项目入口文件（读文件需对路径上每一级目录都有 x 权限）
user_can_access() {
  local u="$1" f="$INSTALL_DIR/node/src/server.js"
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$u" -- test -r "$f" 2>/dev/null
  elif command -v su >/dev/null 2>&1; then
    su -s /bin/sh "$u" -c "test -r '$f'" 2>/dev/null
  else
    return 1
  fi
}

if [[ -n "$RUN_USER_OPT" ]]; then
  RUN_USER="$RUN_USER_OPT"
elif id www >/dev/null 2>&1 && user_can_access www; then
  RUN_USER="www"
else
  RUN_USER="root"
fi
c_info "服务运行用户：$RUN_USER"

# 服务以 RUN_USER 身份运行，config.json 写在项目根目录，
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
# 2.5 面板登录账号：生成或更新 auth.json（保护签到页面与接口）
# --------------------------------------------------------------------------- #
AUTH_FILE="$INSTALL_DIR/auth.json"
PANEL_PWD_SHOW=""

# 用 Node 的 crypto 生成随机串，避免依赖不同系统的 od/openssl 行为差异
gen_hex() { "$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

# 读取已有 auth.json 中的账号（若存在）
EXIST_USER=""
EXIST_PWD=""
if [[ -f "$AUTH_FILE" ]]; then
  EXIST_USER="$("$NODE_BIN" -e "try{process.stdout.write(require('$AUTH_FILE').username||'')}catch(e){}" 2>/dev/null || true)"
  EXIST_PWD="$("$NODE_BIN" -e "try{process.stdout.write(require('$AUTH_FILE').password||'')}catch(e){}" 2>/dev/null || true)"
fi

PANEL_USER_SHOW="${PANEL_USERNAME:-${EXIST_USER:-admin}}"

# 密码优先级：显式指定 > 已有 > 自动生成
if [[ -n "$PANEL_PASSWORD" ]]; then
  PANEL_PWD_SHOW="$PANEL_PASSWORD"
elif [[ -n "$EXIST_PWD" ]]; then
  PANEL_PWD_SHOW="$EXIST_PWD"
else
  PANEL_PWD_SHOW="$(gen_hex 4)"
fi

# 显式指定了用户名/密码，或首次安装时重写 auth.json；否则原样保留
if [[ -n "$PANEL_USERNAME" || -n "$PANEL_PASSWORD" || ! -f "$AUTH_FILE" ]]; then
  SECRET="$(gen_hex 32)"
  printf '{\n  "username": "%s",\n  "password": "%s",\n  "secret": "%s"\n}\n' "$PANEL_USER_SHOW" "$PANEL_PWD_SHOW" "$SECRET" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  chown "$RUN_USER" "$AUTH_FILE" 2>/dev/null || true
  c_ok "已写入面板登录账号"
else
  chmod 600 "$AUTH_FILE" || true
  chown "$RUN_USER" "$AUTH_FILE" 2>/dev/null || true
  c_info "沿用已存在的面板登录账号（auth.json）"
fi

# 首次安装时按 --hour 初始化签到时间（已有 schedule 则不动，避免覆盖面板设置）
if [[ ! -f "$INSTALL_DIR/config.json" ]] || ! grep -q '"schedule"' "$INSTALL_DIR/config.json" 2>/dev/null; then
  HOUR_STR="$(printf '%02d' "$HOUR")"
  "$NODE_BIN" -e "require('$INSTALL_DIR/node/src/store.js').setSchedule(true,'$HOUR_STR:00')" 2>/dev/null || true
  chown "$RUN_USER" "$INSTALL_DIR/config.json" 2>/dev/null || true
  chmod 600 "$INSTALL_DIR/config.json" 2>/dev/null || true
  c_info "已初始化定时签到时间为每天 ${HOUR_STR}:00（可在面板修改）"
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
Environment="HOST=${HOST}"
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
  c_ok "服务已启动，监听 ${HOST}:${PORT}"
else
  c_err "服务启动失败"
  echo
  echo "最近日志："
  journalctl -u "${SERVICE_NAME}" -n 30 --no-pager 2>/dev/null || true
  echo
  echo "常见原因：运行用户（${RUN_USER}）无权访问项目目录 ${INSTALL_DIR}。"
  echo "可把项目放到 /www/wwwroot 等目录，或执行：sudo bash install.sh --user root"
  exit 1
fi

# --------------------------------------------------------------------------- #
# 4. 定时签到计划任务
#    改为每 10 分钟触发一次，由 checkin.js --scheduled 按面板里配置的时间窗口
#    决定是否真正执行；这样签到时间可在面板中随时调整，无需改系统 crontab。
# --------------------------------------------------------------------------- #
if [[ $WITH_CRON -eq 1 ]]; then
  c_info "写入计划任务 /etc/cron.d/${SERVICE_NAME}（每 10 分钟检查一次签到时间）"

  # 预建日志文件并交给运行用户：cron 以该用户身份做重定向，
  # 而 /var/log 默认 root 独占，不预建会因权限不足静默丢弃日志
  LOG_FILE="/var/log/${SERVICE_NAME}-checkin.log"
  touch "$LOG_FILE"
  chown "$RUN_USER" "$LOG_FILE" 2>/dev/null || true

  cat > "/etc/cron.d/${SERVICE_NAME}" <<CRON
# MonkeyCode 自动签到（具体时间由面板的定时设置决定）
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/10 * * * * ${RUN_USER} cd ${INSTALL_DIR}/node && ${NODE_BIN} src/checkin.js --scheduled >> ${LOG_FILE} 2>&1
CRON
  chmod 644 "/etc/cron.d/${SERVICE_NAME}"
  c_ok "计划任务已安装（日志：${LOG_FILE}）"
fi

# --------------------------------------------------------------------------- #
# 5. 收尾提示
# --------------------------------------------------------------------------- #
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

if [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]]; then
  ACCESS_HINT="   方式 A：浏览器打开 http://127.0.0.1:${PORT} ，输入面板密码后扫码登录
              （服务默认只监听本机，服务器上可用 SSH 端口转发后本地访问：
                ssh -L ${PORT}:127.0.0.1:${PORT} root@${IP:-服务器IP}
              或用宝塔/Nginx 反向代理到 127.0.0.1:${PORT}）"
else
  ACCESS_HINT="   方式 A：浏览器打开 http://${IP:-服务器IP}:${PORT} ，输入面板密码后扫码登录
             ⚠ 面板可直接读写登录凭证，请务必用防火墙限制来源 IP，勿公开暴露"
fi

if [[ -n "$PANEL_PWD_SHOW" ]]; then
  PANEL_PWD_LINE="  面板账号   ${PANEL_USER_SHOW:-admin} / ${PANEL_PWD_SHOW}   （也可用 PANEL_USERNAME / PANEL_PASSWORD 环境变量覆盖）"
else
  PANEL_PWD_LINE="  面板账号   （见 ${AUTH_FILE} 或 systemd 服务日志）"
fi

cat <<TIP

────────────────────────────────────────────────────────
 安装完成
────────────────────────────────────────────────────────
 服务状态   systemctl status ${SERVICE_NAME}
 服务日志   journalctl -u ${SERVICE_NAME} -f
 签到日志   tail -f /var/log/${SERVICE_NAME}-checkin.log
 手动签到   cd ${INSTALL_DIR}/node && ${NODE_BIN} src/checkin.js

${PANEL_PWD_LINE}
 修改账号   在面板「系统设置」中修改，或重跑安装并附加 --panel-username / --panel-password

 下一步：配置登录凭证（二选一）
${ACCESS_HINT}
   方式 B：把本机的 config.json 复制到 ${INSTALL_DIR}/config.json

   首次签到验证：${NODE_BIN} ${INSTALL_DIR}/node/src/checkin.js
────────────────────────────────────────────────────────
TIP