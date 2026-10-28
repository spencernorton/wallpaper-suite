# Contributing to Wallpaper Suite

Thanks for your interest. This is a small project with one maintainer, so the
process is deliberately light.

## How changes land

GitHub is the development home. Branch from `main` and open a pull request
into `main`. The checks must pass before merge. Changes ship in tagged
releases.

Use a GitHub noreply address for commit authorship if you prefer to keep your
personal address private. Public history is public data.

## Working on the code

```bash
tests/run-core-tests.sh             # the core suite CI runs first
build/package-extension.sh dist     # the release zip, reproducibly
tests/test-package.sh               # the zip installs cleanly
```

CI also runs the GJS integration tests, the GTK smoke tests under Xvfb, a
compatibility pass on Ubuntu 24.04 (GNOME 46) and 26.04 (GNOME 50), and a
lintian-checked Debian package build. See `.github/workflows/ci.yml` for the
exact commands.

`tests/test-manager-smoke.sh` exercises previews, Apply, pinning, Next, Undo
and lost-reply recovery against a private D-Bus fixture. The underlying
`tests/manager-smoke.gjs` can also exercise the real extension with
`WALLPAPER_TEST_REAL_ENGINE=1`, only in a disposable GNOME account or a
separate mounted home containing `.wallpaper-suite-test-home`. It changes
wallpaper settings and must never target an ordinary desktop session.
Qualify live monitor rearrangement, scaling and reconnects there too.

- Work that decodes or scales images stays out of GNOME Shell's main loop:
  it belongs in a worker subprocess.
- Test a change in a real GNOME Shell session, and say which version and
  monitor layout in the pull request. Wayland needs a log-out to load it.
- A bug fix carries a regression test.
- Commits carry a `Signed-off-by:` line (`git commit -s`, the Developer
  Certificate of Origin). There is no CLA.
- No secrets, hostnames, personal data, personal photos or personal paths in
  the diff; the privacy check rejects them.

## Out of scope

- Downloading wallpapers from the internet. The library is a local folder.
- Per-workspace wallpapers. Monitors are the unit.

## Pull request checklist

- [ ] `tests/run-core-tests.sh` passes and the package builds
- [ ] Tested in GNOME Shell (say which version and monitor layout)
- [ ] Commits are signed off
- [ ] `CHANGELOG.md` updated under `## Unreleased` if behaviour changed
