# Run the private desktop in development

Use the pinned Node and Bun versions from `package.json` and `bun.lock`. Install dependencies with
`bun install --frozen-lockfile`. In PowerShell:

```powershell
$env:OPENBOT_PRIVATE_BUILD = '1'
bun scripts/dev-services.ts app --isolated
```

The supervised private target starts only Electron and its renderer development server. It skips
the account API, Signal, account environment generation and showcase-profile seed. It uses the
normal process registry and `dev:automation` ownership checks. The official build keeps its
existing service selection.

Private development has a separate `OpenBot Private Dev ...` profile. Its agent workspaces stay
under that profile. A packaged private app normally uses the `OpenBot Private` profile and the
`~/OpenBot Private` workspace root. An explicit `--user-data-dir` keeps its workspaces under that
selected profile, as development does.
Do not point a test build at an existing production profile or a real Vault.

## An explicit test directory

Some Windows environments reject atomic writes or hard links in an EFS-encrypted profile folder.
Do not reset the host credential to work around a failed write. Keep the failed profile for diagnosis
and choose a fresh local test directory on a filesystem that supports those operations:

```powershell
$env:OPENBOT_PRIVATE_DEV_DATA_DIR = 'D:\OpenBot-Test\profile'
$env:OPENBOT_DEV_REGISTRY_DIR = 'D:\OpenBot-Test\dev-registry'
bun scripts/dev-services.ts app --isolated --dry-run
bun scripts/dev-services.ts app --isolated
```

The registry directory must be owned by the current user, with no other untrusted writer. The
supervisor validates that ACL. The data override must be absolute and is passed to Electron as
`--user-data-dir`; the registry reports that exact directory. These are development process
settings, not system environment changes or a profile migration.

When Bun is launched by PowerShell 7, its Windows PowerShell 5 child can inherit incompatible
module paths. If `Get-Acl` cannot load `Microsoft.PowerShell.Security`, set this for that terminal
before the supervised commands:

```powershell
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
```

Keep the same `OPENBOT_DEV_REGISTRY_DIR` for `bun run dev:status`, `bun run dev:stop`, and
`bun run dev:automation`. Name the instance that the supervisor reports before UI mutations.
Stop only that registered stack. No app-data deletion is part of this procedure.

## An explicit directory for the installed app

On the first start of a new private profile, the installed app can use the same directory choice:

```powershell
& "$env:LOCALAPPDATA\Programs\OpenBot Private\OpenBot Private.exe" `
  '--user-data-dir=D:\OpenBot-Test\profile'
```

The database and host identity stay in `D:\OpenBot-Test\profile`; newly created workspaces, shared
files and downloads stay under `D:\OpenBot-Test\profile\workspaces`. Without the argument, the
packaged app keeps its normal private profile and `~/OpenBot Private` workspace root. An explicit
local-server child root still takes priority.

Keep the same argument and path on every later launch and after an upgrade. Apply it to the
shortcut or launch command that starts this private instance. Removing the argument selects the
default profile; it does not find or move the profile on D:.

On Windows, enabling launch at login from this installed private instance preserves its explicit
profile path. The setting uses the existing private app login item; enabling it from a different
profile replaces that one item. Starting the app does not enable startup or change an existing
item. The setting reads as enabled only when its command matches the current explicit profile and
Windows permits that item to start. Shortcuts still need the same profile argument.

Choose the layout before first use. This is not a migration for an old profile that already mixes
a database on one drive with workspaces on another. Stored agent workspace paths are not rewritten
and files are not moved. Shared/download roots and managed recovery paths follow the selected root,
so changing this choice for such a profile needs separate migration and preservation checks.

## Private HTTPS

Set the host's complete Tailscale HTTPS origin in Settings > Private access. The default private
gateway binds `127.0.0.1:43187`. Then configure the official Tailscale client:

```powershell
tailscale serve --bg http://127.0.0.1:43187
tailscale serve status
```

The tailnet owner must enable Serve/HTTPS if Tailscale presents a confirmation URL. Do not enable
Funnel. A Clash TUN needs compatible private-host DNS and routing; a healthy direct-IP test alone
does not prove normal hostname traffic works. Test HTTPS and WSS before pairing a real phone.
