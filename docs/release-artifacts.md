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

## Supplemental settings manager candidate

Pull-request CI's `package` job produces
`wallpaper-settings-manager-debian-candidate`, containing the
`wallpaper-suite-settings-manager` Debian package, its source revision in
`build-info.json`, and `SHA256SUMS.txt`. This is an opt-in pre-release artifact,
not a stable extension update. Verify the exact CI run and source revision as
well as the checksums before installing it. The `.deb` itself is unsigned;
checksums do not establish publisher identity on their own.

The manager depends on the installed `wallpaper-suite` package, version 2.2.0
or later. It owns its helpers and workers under
`/usr/share/wallpaper-suite/settings-manager/`, the
`/usr/bin/wallpaper-suite-manager` wrapper, D-Bus activation metadata and a
static user service. It does not own any extension or schema files, enable the
extension, start the service during installation, or restart GNOME Shell.
A settings client activates `tech.norvi.WallpaperManager1` on demand. The
existing extension continues to own `dev.norvi.WallpaperSuite1` and remains
the sole wallpaper publisher.

Before an opt-in installation, check for user-local activation overrides at
`$XDG_DATA_HOME/dbus-1/services/tech.norvi.WallpaperManager1.service` and
`$XDG_CONFIG_HOME/systemd/user/wallpaper-suite-manager.service`, using the
usual XDG defaults when unset. A custom user unit or activation entry takes
precedence over system packaging and must be reviewed separately. Check the
actual bus owner's command and unit fragment before accepting the new service.

Version 2.2's runtime has the required Apply, Next and operation-status methods.
Its missing optional runtime identity method is reported as unverified current
render provenance; it does not disable otherwise safe controls. If a delegated
request's acknowledgement is lost and its receipt cannot be recovered, the
manager reports an unknown outcome and does not resubmit it.

To remove the candidate, close settings clients, stop only
`wallpaper-suite-manager.service` for the affected user if it is running, then
remove `wallpaper-suite-settings-manager`. Do not stop the extension or restart
Shell. Package removal keeps user settings, receipts and caches. It does not
undo wallpaper or rotation changes made during the test; preserve a separate
configuration backup when that rollback is desired.

`tests/test-manager-deb.sh` installs the checksum-pinned released 2.2 package in
a disposable container, installs the supplement, activates its installed D-Bus
entry on a private session bus, then removes it. It verifies extension/schema
file hashes and package ownership throughout. The test deliberately refuses
an interactive desktop and requires an explicit disposable-container marker.
