// The three pnpm commands DSH's plugin manager runs for a local bundle update:
// `config get registry`, `add file:DIR --save-exact` and `remove NAME`. Each
// version is copied below .pnpm and linked, like pnpm, so its real path changes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const manifestPath = join(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const link = name => join(process.cwd(), 'node_modules', name);
if (command === 'config' && args.join(' ') === 'get registry') console.log('https://registry.invalid/');
else if (command === 'add' && args.length === 2 && args[0].startsWith('file:') && args[1] === '--save-exact') {
  const source = args[0].slice('file:'.length), pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const store = join(process.cwd(), 'node_modules/.pnpm', pkg.name.replace('/', '+') + '@' + pkg.version, 'node_modules', pkg.name);
  mkdirSync(dirname(store), { recursive: true }); cpSync(source, store, { recursive: true });
  rmSync(link(pkg.name), { force: true }); mkdirSync(dirname(link(pkg.name)), { recursive: true });
  symlinkSync(relative(dirname(link(pkg.name)), store), link(pkg.name));
  manifest.dependencies = { ...manifest.dependencies, [pkg.name]: args[0] }; save();
} else if (command === 'remove' && args.length === 1 && manifest.dependencies?.[args[0]]) {
  rmSync(link(args[0]), { force: true }); delete manifest.dependencies[args[0]]; save();
} else { console.error('fake pnpm: unsupported ' + [command, ...args].join(' ')); process.exitCode = 1; }
