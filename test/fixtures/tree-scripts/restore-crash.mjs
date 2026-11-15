import { readFileSync } from 'node:fs';
import { TreeRepository } from '../../../src/tree/repository.mjs';
import { SnapshotService } from '../../../src/tree/snapshots.mjs';
import { FixtureWorkspaceIO } from './helpers.mjs';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const repository = new TreeRepository({ treeFilename: input.treeFilename, userId: 'fixture-user' });
const io = new FixtureWorkspaceIO({ workspace: input.workspace, runtimeRoot: input.runtimeRoot, protectedRoots: [input.storageRoot, input.treeFilename] });
const context = () => ({ actor: { kind: 'user', id: 'fixture-user' }, sessionPolicy: { mode: 'workspace-write', workspaceRoot: input.workspace } });
const snapshots = new SnapshotService({ repository, workspace: input.workspace, runtimeRoot: input.runtimeRoot, storageRoot: input.storageRoot, protectedRoots: [input.treeFilename], context, io, allowUnconfinedFixture: true,
  fault: stage => { if (stage === input.stage) process.exit(72); } });
await snapshots.apply(input.command); throw new Error('Requested crash boundary was not reached');
