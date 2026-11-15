import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const desktopPython = Object.freeze({
  path: 'runtime/desktop-python.tar.gz',
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
  bytes: 24981445,
  sha256: '81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b',
  // runtimeDigest of the pinned archive freshly unpacked by /usr/bin/tar.
  treeSha256: '59df7f39ee074442e75a776aacf8810c51b41a64ef5d37ad5e90da39a2a808d7',
});

const executable = 'python/bin/python3.12';
const cache = home => join(home, 'arcfold-desktop-counter');

export function readDesktopPythonArchive(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size !== desktopPython.bytes)
    throw new Error('Arcfold 文本计数文件不完整，请重新安装此版本。');
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== desktopPython.sha256)
    throw new Error('Arcfold 文本计数文件校验失败，请重新安装此版本。');
  return bytes;
}

export function isBundledDesktopPython(home, path) {
  return typeof home === 'string' && typeof path === 'string' &&
    /^[a-f0-9]{64}\/python\/bin\/python3\.\d+$/u.test(relative(cache(home), path));
}

function requirePrivateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error('Arcfold 文本计数目录的所有者或权限不符合要求。');
}

function runtimeDigest(root) {
  const hash = createHash('sha256');
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const entry = prefix + name;
      const stat = lstatSync(path);
      let record;
      if (stat.isDirectory()) {
        record = [entry, 'directory'];
      } else if (stat.isSymbolicLink()) {
        record = [entry, 'link', readlinkSync(path)];
      } else if (stat.isFile()) {
        record = [entry, 'file', createHash('sha256').update(readFileSync(path)).digest('hex')];
      } else {
        throw new Error('Arcfold 文本计数缓存校验失败。');
      }
      hash.update(JSON.stringify(record) + '\n');
      if (stat.isDirectory()) visit(path, entry + '/');
    }
  }
  visit(root, '');
  return hash.digest('hex');
}

function installedPython(path) {
  requirePrivateDirectory(path);
  if (runtimeDigest(path) !== desktopPython.treeSha256)
    throw new Error('Arcfold 文本计数缓存校验失败，请联系维护者修复此配置下的缓存。');
  const file = join(path, executable);
  if (!lstatSync(file).isFile() || realpathSync(file) !== file)
    throw new Error('Arcfold 文本计数程序无效，请检查本机安装。');
  accessSync(file, constants.X_OK);
  return file;
}

/** Extract the checked, relocatable runtime into this Desktop profile. */
export function prepareBundledDesktopPython(packageRoot, home) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('当前 Arcfold Desktop 安装包需要配备 Apple 芯片的 Mac。');
  const archive = join(packageRoot, desktopPython.path);
  if (!existsSync(archive)) throw new Error('当前安装包缺少 Arcfold 文本计数环境，请重新安装此版本。');
  const bytes = readDesktopPythonArchive(archive);
  const directory = cache(realpathSync(home));
  mkdirSync(directory, { mode: 0o700, recursive: true });
  requirePrivateDirectory(directory);
  const destination = join(directory, desktopPython.sha256);
  if (existsSync(destination)) return installedPython(destination);
  const stage = mkdtempSync(join(directory, '.install-'));
  try {
    const stagedArchive = join(stage, 'runtime.tar.gz');
    writeFileSync(stagedArchive, bytes, { mode: 0o600, flag: 'wx' });
    execFileSync('/usr/bin/tar', ['-xzf', stagedArchive, '-C', stage], {
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000,
    });
    rmSync(stagedArchive);
    installedPython(stage);
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    return installedPython(destination);
  } finally {
    rmSync(stage, { force: true, recursive: true });
  }
}
