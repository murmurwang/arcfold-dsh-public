# Runtime supply preparation

These are installer inputs, not a completed host lock. `host/package.json` names only the official complete DSH CLI and the fixed shared Cordis version. The maintenance command must create a **real** host lock by installing these public dependencies, then initialize a new official Web profile and add the already-built core/UI archives to obtain its real profile lock.

Run only through the coordinated engineering task:

```
node scripts/prepare-runtime-locks.mjs --release-dir <accepted-release> --output <new-output>
```

The output keeps the actual installation, commands, failures and generated `runtime/supply.json` companion. It is outside the core archive: the profile lock includes the core archive integrity, so embedding that lock back into the same archive would be circular. No development lock or cache seed is copied as a host/profile lock.

The optional `--offline-store <json>` describes `{storeDir,pnpmArchive,cacheDir?}`. Supply preparation needs the registry metadata cache as well as package contents for a new offline resolution. The installer copies these inputs before use and forbids links back into the immutable resources. Without them, the pinned pnpm archive and public registry packages are obtained from their declared public locations. A private research installation is never an installation source.

The generated `packages.json` records every concrete host/profile package consumer and each declared dependency, optional dependency and peer resolved by the official DSH resolver. Comparison preserves package contents, scope, duplicate consumers and shared-target groups; it permits only a change in physical hoist location. All declared Cordis consumers must use the one host instance. The UI React peer uses the fixed official browser shell/loader supply instead of pretending it is a server dependency. Its actual frontend assets and UI factory are bound. No host or browser is started by supply preparation.

The new profile's workspace policy is copied from `runtime/profile/pnpm-workspace.yaml`: official hoisted layout, peer auto-install disabled, lifecycle scripts disabled. The fresh default profile is also checked for those official layout/peer settings before applying the explicit release policy. A real `pnpm add` produces the profile lock; no cache lock is read as an installation lock.

Supported preparation target is currently macOS arm64 with Node 24.15.0 and pnpm 11.28.5. Other targets require their own verified supply, not a platform flag override. No lifecycle scripts, app boot, model calls, credentials or ledgers are involved. Generated version-profile assets and bootstrap home are separate from the durable native home supplied at runtime.
