#!/usr/bin/env node
// backlog-exporter を使って、projects.json に列挙した複数プロジェクトをバックアップする。
// 初回は `all` でフル取得し、2回目以降は `update` で差分更新する。

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = import.meta.dirname;
const EXPORTER_BIN = path.join(SCRIPT_DIR, 'node_modules', '.bin', 'backlog-exporter');
const VALID_TARGETS = ['issues', 'wiki', 'documents'];
const DEFAULT_OUTPUT_DIR = './backup';
// フォルダ名にも使うため、パス区切りなどを含むキーは受け付けない
const PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
// oclif の this.warn() が標準エラーに出す警告行
const WARNING_PATTERN = /^\s*›\s+Warning:/;

const HELP = `使い方: pnpm backup [オプション]

オプション:
  --config <path>   設定ファイルの場所（既定: ./projects.json）
  --output <dir>    出力先（設定ファイルの outputDir より優先。既定: ./backup）
  --project <key>   指定したプロジェクトだけを実行する（複数指定可）
  --full            差分更新ではなく、フル取得し直す
  --dry-run         実行するコマンドを表示するだけで実行しない
  -h, --help        このヘルプを表示する

API キーは環境変数 BACKLOG_API_KEY か、.env ファイルで渡します。`;

class ConfigError extends Error {}

// スクリプトと同じ場所の .env を読む。既に設定されている環境変数は上書きしない
function loadDotenv() {
  try {
    process.loadEnvFile(path.join(SCRIPT_DIR, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ConfigError(`.env を読み込めません: ${error.message}`);
    }
  }
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: './projects.json' },
      output: { type: 'string' },
      project: { type: 'string', multiple: true },
      full: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

async function loadConfig(configPath, cli) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new ConfigError(
      `設定ファイルが読めません: ${configPath}\nprojects.example.json をコピーして projects.json を作成してください。`,
    );
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`設定ファイルの JSON が不正です: ${configPath}\n${error.message}`);
  }

  if (typeof config.domain !== 'string' || config.domain === '') {
    throw new ConfigError('設定ファイルに domain（例: example.backlog.jp）がありません。');
  }
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw new ConfigError('設定ファイルの projects にプロジェクトが 1 件もありません。');
  }

  // --output はカレントディレクトリ基準、設定ファイルの outputDir は設定ファイルの場所を基準にする
  const outputDir = cli.output
    ? path.resolve(cli.output)
    : path.resolve(path.dirname(configPath), config.outputDir ?? DEFAULT_OUTPUT_DIR);

  const defaults = config.defaults ?? {};
  const seen = new Set();
  const projects = config.projects.map((entry, index) => {
    const key = entry?.projectIdOrKey;
    if (typeof key !== 'string' || !PROJECT_KEY_PATTERN.test(key)) {
      throw new ConfigError(
        `projects[${index}] の projectIdOrKey が不正です（英数字・"_"・"-" のみ使用できます）: ${JSON.stringify(key)}`,
      );
    }
    if (seen.has(key)) {
      throw new ConfigError(`projectIdOrKey が重複しています: ${key}`);
    }
    seen.add(key);

    const targets = entry.targets ?? defaults.targets ?? VALID_TARGETS;
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ConfigError(`${key}: targets は 1 つ以上の配列で指定してください。`);
    }
    for (const target of targets) {
      if (!VALID_TARGETS.includes(target)) {
        throw new ConfigError(`${key}: targets に不正な値があります: ${JSON.stringify(target)}（使用できる値: ${VALID_TARGETS.join(', ')}）`);
      }
    }

    return {
      key,
      // all --only の順序を固定する
      targets: VALID_TARGETS.filter((target) => targets.includes(target)),
      prune: Boolean(entry.prune ?? defaults.prune ?? false),
      dir: path.join(outputDir, key),
    };
  });

  let selected = projects;
  if (cli.project?.length) {
    const unknown = cli.project.filter((key) => !seen.has(key));
    if (unknown.length > 0) {
      throw new ConfigError(`--project で指定したプロジェクトが設定ファイルにありません: ${unknown.join(', ')}`);
    }
    selected = projects.filter((project) => cli.project.includes(project.key));
  }

  return { domain: config.domain, outputDir, projects: selected };
}

// 種別ごとの backlog-settings.json を読む。無い・壊れている場合は undefined
async function readTargetSettings(project, target) {
  try {
    return JSON.parse(await readFile(path.join(project.dir, target, 'backlog-settings.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

// 実行するコマンド列を決める。
// 対象の種別すべてに前回の取得完了記録（lastUpdated）がある場合だけ差分更新にする。
// all が途中で失敗すると後続の種別は設定ファイルが作られず、update では取得されないため。
async function planCommands(project, domain, full) {
  const settings = await Promise.all(project.targets.map((target) => readTargetSettings(project, target)));

  for (const [index, setting] of settings.entries()) {
    if (!setting) continue;
    if ((setting.domain && setting.domain !== domain) || (setting.projectIdOrKey && setting.projectIdOrKey !== project.key)) {
      throw new Error(
        `${path.join(project.dir, project.targets[index])} は別のプロジェクト（${setting.domain} / ${setting.projectIdOrKey}）のバックアップです。出力先を確認してください。`,
      );
    }
  }

  const canUpdate = !full && settings.every((setting) => setting?.lastUpdated);
  const commands = canUpdate
    ? [{ mode: '差分更新', args: ['update', project.dir, '--force'] }]
    : [
        {
          mode: 'フル取得',
          args: ['all', '--domain', domain, '--projectIdOrKey', project.key, '--output', project.dir, '--only', project.targets.join(',')],
        },
      ];

  if (project.prune) {
    commands.push({ mode: '削除済みデータの整理', args: ['prune', project.dir, '--force'] });
  }
  return commands;
}

let currentChild;
let interrupted = false;

// backlog-exporter を実行し、出力を画面とログに流す。終了コードと警告行数を返す
function runExporter(args, logStream) {
  return new Promise((resolve) => {
    // 標準入力を閉じて、対話プロンプトで止まらないようにする。APIキーは環境変数で引き継ぐ
    const child = spawn(EXPORTER_BIN, args, { cwd: SCRIPT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = child;
    let warnings = 0;
    let stderrRest = '';

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
      const lines = (stderrRest + chunk.toString()).split('\n');
      stderrRest = lines.pop();
      warnings += lines.filter((line) => WARNING_PATTERN.test(line)).length;
    });
    child.on('error', (error) => {
      currentChild = undefined;
      const message = `backlog-exporter を起動できませんでした: ${error.message}\n`;
      process.stderr.write(message);
      logStream.write(message);
      resolve({ code: 1, warnings });
    });
    child.on('close', (code, signal) => {
      currentChild = undefined;
      if (WARNING_PATTERN.test(stderrRest)) warnings += 1;
      resolve({ code: code ?? (signal ? 1 : 0), warnings });
    });
  });
}

async function backupProject(project, domain, cli, logDir) {
  const started = Date.now();
  const result = { key: project.key, mode: '-', status: '成功', warnings: 0, logFile: undefined, seconds: 0 };

  let commands;
  try {
    commands = await planCommands(project, domain, cli.full);
  } catch (error) {
    console.error(error.message);
    return { ...result, status: '失敗' };
  }
  result.mode = commands[0].mode;

  if (cli['dry-run']) {
    for (const command of commands) {
      console.log(`[${command.mode}] backlog-exporter ${command.args.join(' ')}`);
    }
    return { ...result, status: '未実行' };
  }

  result.logFile = path.join(logDir, `${project.key}.log`);
  const logStream = createWriteStream(result.logFile);

  for (const command of commands) {
    const header = `--- ${command.mode}: backlog-exporter ${command.args.join(' ')}\n`;
    process.stdout.write(header);
    logStream.write(header);
    // eslint-disable-next-line no-await-in-loop
    const { code, warnings } = await runExporter(command.args, logStream);
    result.warnings += warnings;
    if (code !== 0) {
      result.status = interrupted ? '中断' : '失敗';
      break;
    }
  }

  if (result.status === '成功' && result.warnings > 0) {
    result.status = '警告あり';
  }
  await new Promise((resolve) => {
    logStream.end(resolve);
  });
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

function printSummary(results, logDir, dryRun) {
  console.log('\n===== 結果 =====');
  for (const result of results) {
    const detail = result.warnings > 0 ? `（警告 ${result.warnings} 件）` : '';
    const time = dryRun ? '' : `  ${result.seconds}秒`;
    console.log(`${result.status.padEnd(4, '　')}  ${result.key}  [${result.mode}]${time} ${detail}`);
  }
  if (dryRun) return;

  console.log(`ログ: ${logDir}`);
  const warned = results.filter((result) => result.status === '警告あり');
  if (warned.length > 0) {
    console.log('\n警告が出たプロジェクトは、取得に失敗した項目が次回の差分更新では拾われません。次のコマンドで取り直してください:');
    console.log(`  pnpm backup --full ${warned.map((result) => `--project ${result.key}`).join(' ')}`);
  }
}

async function main() {
  const cli = parseCli();
  if (cli.help) {
    console.log(HELP);
    return 0;
  }

  const dryRun = cli['dry-run'];
  loadDotenv();
  const config = await loadConfig(path.resolve(cli.config), cli);
  if (!dryRun && !process.env.BACKLOG_API_KEY) {
    throw new ConfigError('BACKLOG_API_KEY が設定されていません。環境変数か .env で指定してください。');
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/, '');
  const logDir = path.join(SCRIPT_DIR, 'logs', stamp);
  if (!dryRun) {
    await mkdir(logDir, { recursive: true });
    await mkdir(config.outputDir, { recursive: true });
  }

  process.on('SIGINT', () => {
    interrupted = true;
    currentChild?.kill('SIGINT');
  });

  console.log(`出力先: ${config.outputDir}`);
  const results = [];
  // backlog-exporter 自体が並列取得とレート制限の待機をするため、プロジェクトは順番に処理する
  for (const [index, project] of config.projects.entries()) {
    if (interrupted) break;
    console.log(`\n===== [${index + 1}/${config.projects.length}] ${project.key} =====`);
    // eslint-disable-next-line no-await-in-loop
    results.push(await backupProject(project, config.domain, cli, logDir));
  }

  printSummary(results, logDir, dryRun);
  if (interrupted) {
    console.error('\n中断されました。');
    return 130;
  }
  return results.some((result) => result.status === '失敗') ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError || error?.code?.startsWith?.('ERR_PARSE_ARGS')) {
    console.error(`エラー: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
