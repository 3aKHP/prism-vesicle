# Linux portable

English | [简体中文](../../zh-CN/start/linux-portable.md)

For Linux and WSL users. The Linux channel currently offers only a single-file ELF binary plus an asset pack (`.deb` is not published yet; a row will be added on the [routing page](../README.md) when it is).

> Deployment tip: **install it in the environment you usually create in** — if you write character cards in WSL, install in WSL; if you write in Windows, use a Windows channel. Don't cross `/mnt/c`.

## Download and verify

From the official Release:

- The ELF binary `prism-vesicle-linux-x64-<version>`
- The asset pack `prism-vesicle-assets-<version>.zip`

Compare against `SHA256SUMS.txt` with `sha256sum`:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Linux artifacts have no Authenticode concern; this section is shorter than the Windows one and does not discuss signing.

## Layout and executable bit

```bash
chmod +x prism-vesicle-linux-x64-<version>
```

Extract the asset pack so the three pieces sit alongside the binary (same contract as the Windows build):

```text
any folder/
├── prism-vesicle-linux-x64-<version>
├── harness-manifest.json
├── assets/
└── host-assets/
```

The asset version must match the binary; replace both together when upgrading.

## PATH

The binary always looks for resources beside its **own real location** (a symlink invocation also resolves to the real path), so either of these works — pick one:

- Symlink from a PATH directory (such as `~/.local/bin`) to the real binary: `ln -s /opt/prism-vesicle/prism-vesicle-linux-x64-<version> ~/.local/bin/vesicle`
- Or add the real binary's directory to PATH.

For the short `vesicle` name, rename the binary or use the symlink above.

## Configure, check, start

```bash
vesicle setup          # or hand-edit ~/.config/prism-vesicle/providers.yaml + .env
vesicle doctor
cd /path/to/my-project
vesicle .
```

Configuration lives in `~/.config/prism-vesicle/` (`XDG_CONFIG_HOME` takes precedence).

## Update

Replace the binary and re-extract the asset pack; user configuration and projects are unaffected. See [Reference: Update · uninstall · migrate](../reference/update-uninstall-migrate.md).

## Next step

→ [First conversation](../tutorials/first-conversation.md)
