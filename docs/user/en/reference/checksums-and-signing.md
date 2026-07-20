# Checksums and signing

English | [简体中文](../../zh-CN/reference/checksums-and-signing.md)

After downloading Vesicle, verifying the file confirms it was not tampered with and really comes from this project. Two things are distinct: a **checksum** confirms the bytes; a **signature** confirms the publisher.

## Checksum: confirm the bytes

Every GitHub Release ships a `SHA256SUMS.txt`. After downloading, compare in the same directory.

Windows (PowerShell):

```powershell
Get-FileHash .\prism-vesicle-windows-x64-<version>.exe -Algorithm SHA256
Get-FileHash .\prism-vesicle-assets-<version>.zip -Algorithm SHA256
```

Linux / WSL:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Match the computed hash against the line for that file in `SHA256SUMS.txt`; a match means the bytes are identical to the release.

## Signature: confirm the publisher

Windows executables can carry an Authenticode signature. **A checksum is not a signature** — a hash detects changes after download but cannot prove who published the file.

**Current status (`1.0.0-alpha.2`)**: the Windows executable and installer are **intentionally unsigned**. The SignPath Foundation application for this project (submitted 2026-07-15) is still pending. This exception is only for a small, informed test group and must end no later than `1.0.0-beta.1`. So during alpha:

- Download only from the [official GitHub Releases](https://github.com/3aKHP/prism-vesicle/releases);
- Always verify against `SHA256SUMS.txt` as shown above;
- **Do not** disable Windows security features globally to bypass prompts.

Full policy in [Code Signing Policy](../../../../CODE_SIGNING_POLICY.md).

## How to verify once signing is enabled

When a Release's notes say its Windows files are signed, verify like this:

1. Right-click the executable → **Properties** → **Digital Signatures**, inspect the signer, and open **Details** to confirm Windows reports the signature valid.
2. Or with PowerShell:

```powershell
Get-AuthenticodeSignature .\PrismVesicleSetup-<version>-windows-x64.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

Expected: `Status: Valid`, with a trusted SignPath Foundation certificate chain and a timestamp.

> A valid signature identifies the publisher and detects post-signing changes, but **cannot** guarantee the software is defect-free or that Microsoft SmartScreen will never show a reputation warning for a new release.

## If you suspect a file

If a signature is invalid, the signer is unexpected, or you find a "signed" project file outside the official release process: do not run or redistribute it. Open an issue at [GitHub Issues](https://github.com/3aKHP/prism-vesicle/issues) with only the Release URL, filename, SHA-256, signature status, and a certificate screenshot — **do not** attach the executable, credentials, or private data. Handling is in [Code Signing Policy](../../../../CODE_SIGNING_POLICY.md).
