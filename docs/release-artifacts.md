# Release artifacts

Wallpaper Suite releases are produced from source with GNOME's own pack path,
`gnome-extensions pack`:

```sh
build/package-extension.sh dist
```

The command stages only runtime files, invokes `gnome-extensions pack`, then
normalizes ZIP ordering and timestamps using the current commit timestamp. It
emits five files:

- `wallpaper-suite@spencercnorton.github.io.shell-extension.zip`
- `wallpaper-suite@spencercnorton.github.io.shell-extension.zip.sha256`
- `wallpaper-suitectl`
- `wallpaper-suitectl.sha256`
- `release-manifest.json` with the semantic version, source commit, build
  epoch, and SHA-256 digests for both executable artifacts

`tests/test-package.sh` builds the artifact twice from identical inputs and
requires byte-for-byte equality. CI retains the package, CLI, checksums, and
manifest for 30 days on merge requests, the default branch, and tags.

Before installation, verify the checksum and inspect `release-manifest.json`.
Use `gnome-extensions install --force <archive>`; shell-side changes become
active only after a logout/login on Wayland.
