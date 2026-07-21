# Code Signing Policy

[English](./CODE_SIGNING_POLICY.md) | [简体中文](./CODE_SIGNING_POLICY.zh-CN.md)

Last updated: 2026-07-21

## Current Status

Prism Vesicle does not currently Authenticode-sign its Windows artifacts. Code signing is deferred until the project has a stronger basis for a signing provider; no version deadline is set, and the earlier `1.0.0-beta.1` target is superseded. All current Windows executables and installers are intentionally unsigned. Every GitHub Release must identify the Windows executable and installer as unsigned, link this policy, provide SHA-256 checksums, and tell users not to disable Windows security features globally. Release integrity currently rests on the official GitHub Release source, SHA-256 checksums, and npm registry signatures with SLSA provenance.

Historical release artifacts remain unsigned unless their individual GitHub Release notes explicitly say otherwise. In particular, the existence of a checksum or npm provenance record does not mean that a Windows executable has an Authenticode signature.

If Windows signing is taken up later, each applicable GitHub Release will state which Windows files are signed, and this policy will be updated with the active signing provider information.

## Signed Files And Source

The sections below describe the scope, roles, controls, and verification standard for any future Windows signing. No production signing is performed today; Windows signing is deferred as described above.

The intended Authenticode scope is limited to Windows executables produced for a protected Prism Vesicle release:

- the versioned portable Windows executable;
- the guided Windows installer;
- the uninstaller generated as part of that installer.

Only artifacts built from the public [`3aKHP/prism-vesicle`](https://github.com/3aKHP/prism-vesicle) repository are eligible. A production signing request must originate from a protected `v<version>` tag whose commit is on the protected `main` history and whose version matches `package.json`. Pull request, `develop`, local, and ad hoc builds are not production signing inputs.

Signed-file metadata restrictions must identify the product as Prism Vesicle and require one consistent product version throughout each build.

The distribution contains open-source upstream assets and dependencies. Their presence does not make an unrelated upstream executable a Prism Vesicle-authored binary, and such an executable will not be submitted for signing under this project identity.

## Roles And Approval

Prism Vesicle is currently maintained by one individual:

| Role | Current holder | Responsibility |
|---|---|---|
| Author and committer | [`3aKHP`](https://github.com/3aKHP) | Trusted to modify the source repository. External contributors propose changes through pull requests and retain their public authorship. |
| Repository reviewer | [`3aKHP`](https://github.com/3aKHP) | Review external contributions and grant the human repository approval. Maintainer-authored release work is additionally checked by protected CI and the repository's documented independent review process. |
| Signing approver | [`3aKHP`](https://github.com/3aKHP) | Inspect the release identity and build provenance, then approve or reject the signing request. |

Every production signing request is manually approved. A successful build or tag push does not by itself authorize the signing provider to sign an artifact. The approver checks the repository, tag, commit, version, expected artifact names, and successful release gates before approval.

The signing certificate's private key is generated and retained in the signing provider's hardware security module. It is not exported to the maintainer, stored in this repository, or placed in GitHub Actions secrets.

## Release Controls

The public release process is documented in [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md). Its signing controls are intended to provide the following chain:

1. Reviewed release work is merged to protected `main`.
2. A protected annotated version tag identifies the accepted source commit.
3. GitHub Actions builds the Windows executable from that exact public source.
4. The signing approver manually reviews the signing request.
5. The signed executable is verified before it is staged in the installer.
6. The installer and generated uninstaller are signed and verified.
7. Release checksums and provenance are generated for the final publication artifacts.

Any signing failure, identity mismatch, unexpected file, or failed verification blocks publication of the affected Windows artifact.

## User Verification

First download files only from the project's [official GitHub Releases](https://github.com/3aKHP/prism-vesicle/releases). Check the individual Release notes to determine whether that version is signed.

On Windows, open the executable's **Properties**, select **Digital Signatures**, inspect the signer, and open **Details** to verify that Windows reports the signature as valid. Advanced users can also run:

```powershell
Get-AuthenticodeSignature .\PrismVesicleSetup-<version>-windows-x64.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

The expected result for a release described as signed is `Status: Valid`, with a trusted certificate chain from the signing provider and a timestamp. Also compare the file against `SHA256SUMS.txt` from the same Release. A valid signature identifies the signed publisher and detects post-signing changes; it does not guarantee that the software is defect-free or that Microsoft SmartScreen will never show a reputation warning for a new release.

## Incident And Revocation Handling

If a signature is invalid, the signer is unexpected, a signed file is found outside the documented release process, or signing credentials or approval access may be compromised:

1. Do not run or redistribute the file.
2. Open a [GitHub issue](https://github.com/3aKHP/prism-vesicle/issues) containing only the Release URL, filename, SHA-256 hash, signature status, and a screenshot of the certificate details. Do not attach the executable, credentials, tokens, or private data.
3. The maintainer will suspend affected publication, investigate the public build and approval record, notify the signing provider, and request certificate or signature revocation when warranted.
4. A corrected build will use a new version. Published tags and artifacts will not be silently replaced.

Privacy and data-transfer behavior are documented in the [Privacy Policy](./PRIVACY.md).
