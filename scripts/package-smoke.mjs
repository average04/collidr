import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
assert(npm && existsSync(npm), 'Run through npm run test:package');
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'collidr-package-')));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, ...options });
  assert(!result.error && result.status === 0,
    `${command} ${args.join(' ')} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const npmRun = (args, options) => run(process.execPath, [npm, ...args], options);
let client;
let failure;
try {
  console.log(`Packaging verification: Node ${process.version}; npm ${npmRun(['--version']).trim()}; CLI ${npm}`);
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const version = readFileSync(join(repo, 'src/version.ts'), 'utf8').match(/VERSION = "([^"]+)"/)[1];
  assert.equal(manifest.version, version);
  assert.equal(manifest.name, 'collidr');
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  const stage = join(root, 'build'); mkdirSync(stage);
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'LICENSE', 'README.md', '.npmrc']) {
    cpSync(join(repo, file), join(stage, file), { recursive: true });
  }
  assert(!existsSync(join(stage, 'dist')));
  console.log('Installing build dependencies in isolated source stage…');
  npmRun(['ci', '--no-audit', '--no-fund'], { cwd: stage });
  const packed = JSON.parse(npmRun(['pack', '--ignore-scripts=false', '--json', '--pack-destination', root], { cwd: stage }))[0];
  const files = packed.files.map(file => file.path);
  for (const file of ['dist/cli.js', 'dist/index.js', 'LICENSE', 'README.md']) assert(files.includes(file), `Missing ${file}`);
  assert(files.every(file => file === 'package.json' || file === 'LICENSE' || file === 'README.md' || file.startsWith('dist/')), 'Unexpected package contents');
  assert(files.every(file => !/(secret|\.env|\.superpowers)/i.test(file)), 'Secret-like artifact path');
  const tarball = join(root, packed.filename);
  const prefix = join(root, 'installed');
  console.log('Installing packed runtime into isolated prefix…');
  const consumerEnv = { ...process.env };
  for (const key of Object.keys(consumerEnv)) if (/^npm_/i.test(key)) delete consumerEnv[key];
  const consumerHome = join(root, 'consumer-home'); mkdirSync(consumerHome);
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA']) consumerEnv[key] = consumerHome;
  const userConfig = join(root, 'consumer-user.npmrc');
  const globalConfig = join(root, 'consumer-global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  const installation = npmRun(['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts',
    '--userconfig', userConfig, '--globalconfig', globalConfig, tarball], { env: consumerEnv });
  assert(!/^>[ \t]+node-gyp(?:\.cmd)?[ \t]+rebuild(?:[ \t\r]|$)/m.test(installation),
    'Consumer installation unexpectedly invoked node-gyp rebuild');
  const installed = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'collidr');
  const cli = join(installed, 'dist/cli.js'); assert(existsSync(cli));
  assert(!existsSync(join(installed, 'src')));
  const tree = JSON.parse(npmRun(['ls', '--global', '--prefix', prefix, '--all', '--json']));
  function checkDeps(deps) { for (const [name, value] of Object.entries(deps ?? {})) {
    assert(!['typescript', 'vitest', '@types/node', '@types/better-sqlite3'].includes(name), `Development dependency installed: ${name}`);
    checkDeps(value.dependencies);
  } }
  checkDeps(tree.dependencies);
  const home = join(root, 'home'); const workspace = join(root, 'workspace'); const bin = join(root, 'providers');
  for (const dir of [home, workspace, bin]) mkdirSync(dir);
  const expected = [];
  for (const [provider, pkg] of [['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex']]) {
    let script;
    if (process.platform === 'win32') {
      const pkgDir = join(bin, 'node_modules', pkg); mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, bin: { [provider]: 'cli.js' } }));
      script = join(pkgDir, 'cli.js');
      writeFileSync(join(bin, `${provider}.cmd`), '@echo off\r\nexit /b 99\r\n');
    } else { script = join(bin, provider); }
    writeFileSync(script, '#!/usr/bin/env node\nif(process.argv.at(-1)!=="--version") process.exit(99); console.log("fake-provider 1.0");\n');
    chmodSync(script, 0o755); expected.push(script);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    PATH: [bin, dirname(process.execPath)].join(delimiter), COLLIDR_WORKSPACE: workspace, COLLIDR_DB: join(root, 'setup-hub.db') };
  assert.match(run(process.execPath, [cli, '--help'], { env }), /collidr/i);
  const configPath = join(root, 'runner.json');
  run(process.execPath, [cli, 'setup', '--yes', '--workspace', workspace, '--config', configPath, '--database', env.COLLIDR_DB], { env });
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.cliPath, cli);
  assert.deepEqual(config.agents.map(agent => agent.id), ['claude-managed', 'codex-managed']);
  for (const [index, agent] of config.agents.entries()) {
    assert.equal(agent.command, process.execPath); assert.deepEqual(agent.args, [expected[index]]);
  }
  for (const path of [config.database, `${config.database}.runner.db`]) assert(!existsSync(path), `--yes started or opened selected database: ${path}`);
  const probeEnv = { ...env, COLLIDR_DB: join(root, 'probe.db'), COLLIDR_PARTICIPANT: 'package-smoke' };
  assert.match(run(process.execPath, [cli, 'doctor'], { env: probeEnv }), /SQLite/i);
  client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve'], env: probeEnv, cwd: workspace }), { timeout: 15000 });
  const listed = await client.listTools({}, { timeout: 15000 });
  for (const name of ['register', 'whoami', 'list_threads', 'open_thread', 'submit_revision', 'read_revision', 'post', 'read_thread', 'inbox', 'wait_for_messages', 'ack', 'resolve']) assert(listed.tools.some(tool => tool.name === name), `Missing tool ${name}`);
  const who = await client.callTool({ name: 'whoami', arguments: {} }, undefined, { timeout: 15000 });
  assert(!who.isError);
  const identity = JSON.parse(who.content.find(item => item.type === 'text').text);
  assert.equal(identity.registered, true);
  assert.match(JSON.stringify(identity), /package-smoke/);
  const retained = join(repo, 'artifacts', packed.filename);
  mkdirSync(dirname(retained), { recursive: true }); cpSync(tarball, retained);
  console.log(`PASS: installed CLI, setup, doctor and MCP; tarball ${retained}\nSHA256 ${createHash('sha256').update(readFileSync(retained)).digest('hex')}`);
} catch (error) {
  failure = error;
} finally {
  try { if (client) await client.close(); } catch (error) { failure ??= error; }
  try {
    const rel = relative(realpathSync.native(tmpdir()), root);
    assert(rel && !rel.startsWith('..') && !resolve(root).endsWith('..'), 'Unsafe cleanup root');
    rmSync(root, { recursive: true, force: true });
  } catch (error) { failure ??= error; }
}
if (failure) throw failure;
