#!/usr/bin/env python3
"""Rewrite a GNOME extension ZIP with stable ordering and timestamps."""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path
import tempfile
import zipfile


def normalized_datetime(epoch: int) -> tuple[int, int, int, int, int, int]:
    # ZIP's DOS timestamp cannot represent dates before 1980 and stores only
    # even seconds. Clamp/round once so two builds of one commit are identical.
    timestamp = max(epoch, 315_532_800)
    value = dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc)
    return (value.year, value.month, value.day, value.hour, value.minute, value.second // 2 * 2)


def normalize(path: Path, epoch: int) -> None:
    timestamp = normalized_datetime(epoch)
    with zipfile.ZipFile(path, "r") as source:
        members = [(info.filename, source.read(info.filename)) for info in source.infolist()]

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as output:
            for name, payload in sorted(members):
                info = zipfile.ZipInfo(name, timestamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (0o755 if name.endswith("/") else 0o644) << 16
                output.writestr(info, payload)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--epoch", type=int, required=True)
    args = parser.parse_args()
    normalize(args.archive, args.epoch)


if __name__ == "__main__":
    main()
