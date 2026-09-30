# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/spencercnorton/wallpaper-suite/security/advisories/new)**.
Do not open a public issue, and do not include real credentials, personal
photos or personal paths in the report — a description and a minimal
reproduction are enough.

There is no e-mail address for security reports; the advisory form is the
only channel, and it is the one that is monitored. You will get an
acknowledgement within a week. Fixes ship as a tagged release; the advisory
is published once the release is out, and credits you unless you ask
otherwise.

## Supported versions

Only the latest tagged release is supported.

## What the extension does with your files

- **Images** are read from the library folder you choose and decoded in a
  separate process (`compositor-worker.js`, `thumbnail-worker.js`) with
  GdkPixbuf, so a malformed image cannot stall GNOME Shell.
- **Composites and thumbnails** are written under `~/.cache/wallpaper-suite/`;
  the janitor deletes only files it recognises by exact name.
- **The control API** is on the session bus, reachable only by processes of the
  same user. Its operation ledger is `~/.local/state/wallpaper-suite/`.
- Nothing leaves the machine: the extension opens no network connections.
