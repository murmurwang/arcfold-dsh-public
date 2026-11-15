import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

// The release builder invokes this same function from its private source copy.
// Dependencies are read from an existing installation; nothing is installed.
export async function buildMethodUi({ dependencyRoot = resolve(root, '../..') } = {}) {
  const require = createRequire(join(resolve(dependencyRoot), 'package.json'));
  const esbuildPackage = JSON.parse(await readFile(require.resolve('esbuild/package.json'), 'utf8'));
  assert.equal(esbuildPackage.version, '0.28.2', 'The UI builder requires the frozen esbuild version');
  const { build, version } = await import(pathToFileURL(require.resolve('esbuild')).href);
  assert.equal(version, esbuildPackage.version);
  const css = await readFile(join(root, 'src/style.css'), 'utf8');
  const treeCss = await readFile(join(root, 'src/tree-style.css'), 'utf8');
  const result = await build({ absWorkingDir: root, entryPoints: ['src/client.mjs'], outfile: 'lib/client.js',
    bundle: true, write: false, metafile: true, format: 'cjs', platform: 'browser', target: 'es2022', charset: 'utf8',
    external: ['react'], define: { __ARCFOLD_METHOD_CSS__: JSON.stringify(css), __ARCFOLD_TREE_CSS__: JSON.stringify(treeCss) },
    banner: { js: 'window.__ModuleLoader__.load({id:"@arcfold/dsh-method-ui",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
    footer: { js: 'return module.exports;}});' },
  });
  const output = result.metafile.outputs['lib/client.js'];
  assert.ok(output && output.bytes > 0, 'The real UI client was not built');
  assert.ok(output.imports.some(item => item.path === 'react' && item.external === true), 'React must be supplied by the host');
  assert.ok(output.imports.every(item => item.path === 'react' && item.external === true), 'Unexpected external UI dependency');
  assert.ok(Object.keys(result.metafile.inputs).every(path => path.startsWith('src/') && !path.includes('node_modules')),
    'The client must not bundle a second React or another dependency');
  assert.equal(result.outputFiles.length, 1);
  assert.equal(result.outputFiles[0].path, join(root, 'lib/client.js'));
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'lib/client.js'), result.outputFiles[0].contents);
  const inputs = await Promise.all([...Object.keys(result.metafile.inputs), 'src/style.css', 'src/tree-style.css', 'build.mjs'].sort()
    .map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
  return { esbuildVersion: version, external: ['react'], inputs,
    output: { path: 'lib/client.js', bytes: output.bytes, sha256: hash(result.outputFiles[0].contents) },
    metafile: result.metafile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || args.length === 2 && args[0] === '--dependencies', 'Use --dependencies <frozen installation>');
  await buildMethodUi(args.length ? { dependencyRoot: args[1] } : {});
}
