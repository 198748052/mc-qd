'use strict';

/**
 * 在线更新：以 Git 仓库（GitHub）为源，拉取最新代码并可重启服务。
 *
 * 设计要点：
 *   - 只更新代码，绝不覆盖本地 config.json（内含登录凭证）。
 *     该文件已在 .gitignore 中，git 本身不会改动它；这里再额外备份 / 还原一层保险。
 *   - 默认使用 fast-forward 合并（git merge --ff-only）：
 *     本地有未提交改动时不会强行覆盖，只会报错并提示用 --force。
 *   - 重启策略：优先交给 systemd（Restart=always，退出即拉起）；
 *     非 systemd 环境则自我 re-exec，保证新代码生效。
 *
 * 环境变量（可选）：
 *   MONKEYCODE_REMOTE   远程名，默认 origin
 *   MONKEYCODE_BRANCH   分支名，默认 main
 *   MONKEYCODE_SERVICE  systemd 服务名，默认 monkeycode
 */

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/** 仓库根目录（本文件位于 <root>/node/src/update.js） */
const REPO_ROOT = path.join(__dirname, '..', '..');
/** 本地配置文件，更新时需保护 */
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');

const REMOTE = process.env.MONKEYCODE_REMOTE || 'origin';
const BRANCH = process.env.MONKEYCODE_BRANCH || 'main';
const GIT_TIMEOUT = 60000;

/**
 * 执行 git 命令。
 *
 * @param {string[]} args
 * @returns {Promise<string>} 去除首尾空白的 stdout
 */
function git(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: REPO_ROOT,
        timeout: GIT_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          // 禁用交互式凭证提示，避免无人值守时卡住
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = (stderr || '').trim();
          return reject(err);
        }
        resolve((stdout || '').trim());
      }
    );
  });
}

/** 当前部署是否为 Git 工作区 */
async function isGitRepo() {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查是否有可用更新（会先 fetch 远程）。
 *
 * @returns {Promise<object>}
 */
async function getUpdateStatus() {
  if (!(await isGitRepo())) {
    return {
      ok: false,
      is_repo: false,
      message: '当前部署不是 Git 仓库，无法在线更新；请改用 git clone 重新部署。',
    };
  }
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    await git(['fetch', '--prune', REMOTE, BRANCH]);

    const ref = `${REMOTE}/${BRANCH}`;
    const local = await git(['rev-parse', '--short', 'HEAD']);
    const remote = await git(['rev-parse', '--short', ref]);
    const behind = Number(await git(['rev-list', '--count', `HEAD..${ref}`])) || 0;
    const ahead = Number(await git(['rev-list', '--count', `${ref}..HEAD`])) || 0;
    const subject = await git(['log', '-1', '--format=%s', ref]);
    const date = await git(['log', '-1', '--format=%ci', ref]);

    return {
      ok: true,
      is_repo: true,
      branch,
      remote: REMOTE,
      upstream: ref,
      local,
      remote_commit: remote,
      ahead,
      behind,
      up_to_date: behind === 0,
      remote_subject: subject,
      remote_date: date,
    };
  } catch (e) {
    return {
      ok: false,
      is_repo: true,
      message: `检查更新失败：${e.stderr || e.message}`,
    };
  }
}

/**
 * 执行更新。
 *
 * @param {boolean} [force] 为 true 时用 git reset --hard 强制以远程为准
 * @returns {Promise<{changed:boolean, before:string, after:string, logs:{level:string,msg:string}[]}>}
 */
async function applyUpdate(force = false) {
  if (!(await isGitRepo())) {
    throw new Error('当前部署不是 Git 仓库，无法在线更新');
  }

  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  const ref = `${REMOTE}/${BRANCH}`;

  // 1) 备份本地配置（更新后原样还原）
  const cfgBak = `${CONFIG_PATH}.bak`;
  const hasCfg = fs.existsSync(CONFIG_PATH);
  if (hasCfg) {
    fs.copyFileSync(CONFIG_PATH, cfgBak);
    log('info', '已备份本地 config.json');
  }

  try {
    // 2) 拉取远程
    log('info', `git fetch ${REMOTE} ${BRANCH} ...`);
    await git(['fetch', '--prune', REMOTE, BRANCH]);

    const before = await git(['rev-parse', '--short', 'HEAD']);

    // 3) 更新代码
    if (force) {
      log('warn', `强制以远程为准：git reset --hard ${ref}`);
      await git(['reset', '--hard', ref]);
    } else {
      log('info', `git merge --ff-only ${ref} ...`);
      try {
        await git(['merge', '--ff-only', ref]);
      } catch (e) {
        throw new Error(
          `无法快进更新（本地可能有未提交改动）：${e.stderr || e.message}。` +
            '可在服务器执行 update.sh --force 强制更新。'
        );
      }
    }

    const after = await git(['rev-parse', '--short', 'HEAD']);
    const changed = before !== after;
    log(changed ? 'ok' : 'info', changed ? `代码已更新：${before} -> ${after}` : `代码已是最新（${after}）`);

    return { changed, before, after, logs };
  } finally {
    // 4) 无论成功失败都还原本地配置
    if (hasCfg && fs.existsSync(cfgBak)) {
      try {
        fs.copyFileSync(cfgBak, CONFIG_PATH);
        fs.chmodSync(CONFIG_PATH, 0o600);
        log('info', '已保留本地 config.json');
      } catch {
        /* 还原失败不阻断流程 */
      }
    }
  }
}

/**
 * 安排一次服务重启，让新代码生效。
 * 延迟一点执行，确保 HTTP 响应已经发回浏览器。
 *
 * @param {number} [delayMs]
 */
function scheduleRestart(delayMs = 600) {
  setTimeout(() => {
    // systemd 管理（Restart=always）时，直接退出即可被拉起
    if (process.env.INVOCATION_ID) {
      process.exit(0);
      return;
    }
    // 非 systemd 环境：自我重新拉起，保证新代码生效
    try {
      const child = spawn(process.execPath, [process.argv[1]], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
    } catch {
      /* 忽略，下面统一退出 */
    }
    process.exit(0);
  }, delayMs);
}

module.exports = { REPO_ROOT, CONFIG_PATH, getUpdateStatus, applyUpdate, scheduleRestart };
