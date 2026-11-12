#!/usr/bin/env bash
# Run only in a disposable root container, never on an interactive desktop.
set -euo pipefail
if [[ "${WALLPAPER_PACKAGE_TEST:-}" != disposable-container || $(id -u) != 0 || $# != 2 ]]; then
    echo 'Use WALLPAPER_PACKAGE_TEST=disposable-container in a disposable root container; pass stable and manager .deb paths.' >&2
    exit 64
fi
[[ -f /.dockerenv || -f /run/.containerenv ]]
[[ ! -S /run/user/1000/bus && -z ${DISPLAY:-} && -z ${WAYLAND_DISPLAY:-} ]]
stable_deb=$(realpath "$1")
manager_deb=$(realpath "$2")
test "$(dpkg-deb -f "$stable_deb" Package)" = wallpaper-suite
test "$(dpkg-deb -f "$stable_deb" Version)" = 2.2.0
echo "4b048d383677f3f51381b315bb57f87f71261893cc12f22298b52bc95aceea5e  $stable_deb" | sha256sum --check
test "$(dpkg-deb -f "$manager_deb" Package)" = wallpaper-suite-settings-manager
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# The baseline is the immutable, released 2.2 package. Its files are not
# provided by, or rebuilt with, the supplemental manager candidate.
dpkg -i "$stable_deb"
dpkg-query -L wallpaper-suite | while IFS= read -r path; do
    if [[ -f "$path" && ! -L "$path" ]]; then sha256sum "$path"; fi
done > "$scratch/stable-files.sha256"
dpkg -i "$manager_deb"
sha256sum --check --quiet "$scratch/stable-files.sha256"
dpkg-query -L wallpaper-suite-settings-manager > "$scratch/manager-files"
if grep -Eq '/gnome-shell/extensions/|/glib-2.0/schemas/' "$scratch/manager-files"; then
    echo 'Manager package must not own extension or schema files' >&2; exit 1
fi
test -x /usr/bin/wallpaper-suite-manager
test -f /usr/share/wallpaper-suite/settings-manager/manager/main.js
test ! -d /usr/share/wallpaper-suite/settings-manager/schemas
python3 - <<'PY'
import configparser
from pathlib import Path
s=configparser.ConfigParser(interpolation=None); s.read('/usr/share/dbus-1/services/tech.norvi.WallpaperManager1.service')
assert s['D-BUS Service']['Name']=='tech.norvi.WallpaperManager1'
assert s['D-BUS Service']['Exec']=='/usr/bin/wallpaper-suite-manager'
u=configparser.ConfigParser(interpolation=None); u.read('/usr/lib/systemd/user/wallpaper-suite-manager.service')
assert u['Service']['Type']=='dbus' and u['Service']['BusName']=='tech.norvi.WallpaperManager1'
assert u['Service']['ExecStart']=='/usr/bin/wallpaper-suite-manager'
assert 'Install' not in u
assert not list(Path('/etc/systemd/user').glob('*.wants/wallpaper-suite-manager.service'))
PY
mkdir -p "$scratch"/{config,data,state,cache,runtime}
chmod 700 "$scratch/runtime"
cat > "$scratch/bus.conf" <<EOF
<busconfig><type>session</type><listen>unix:tmpdir=$scratch/runtime</listen><auth>EXTERNAL</auth>
<servicedir>/usr/share/dbus-1/services</servicedir>
<policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy>
</busconfig>
EOF
# The service starts only through its installed D-Bus metadata. There is no
# host bus, desktop, user systemd or test replacement for the runtime here.
env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_SYSTEM_BUS_ADDRESS -u DBUS_STARTER_ADDRESS \
    -u DBUS_STARTER_BUS_TYPE -u DISPLAY -u WAYLAND_DISPLAY -u AT_SPI_BUS_ADDRESS \
    XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data" \
    XDG_STATE_HOME="$scratch/state" XDG_CACHE_HOME="$scratch/cache" \
    XDG_RUNTIME_DIR="$scratch/runtime" GSETTINGS_BACKEND=memory GIO_USE_VFS=local \
    dbus-run-session --config-file="$scratch/bus.conf" -- python3 - <<'PY'
import json, os, signal
from pathlib import Path
from gi.repository import Gio, GLib
b=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def call(n,p,i,m,a=None): return b.call_sync(n,p,i,m,a,None,Gio.DBusCallFlags.NONE,5000,None).unpack()
d='org.freedesktop.DBus'; dp='/org/freedesktop/DBus'; n='tech.norvi.WallpaperManager1'; p='/tech/norvi/WallpaperManager1'
assert call(d,dp,d,'NameHasOwner',GLib.Variant('(s)',(n,)))==(False,)
caps=call(n,p,n,'GetCapabilities'); assert caps[0]==1 and 'wallpaper.preview.v1' in caps[2] and 'wallpaper.apply.v1' in caps[2]
snapshot=call(n,p,n,'GetSnapshot'); assert snapshot[2] is False and snapshot[3]=='runtime-unavailable', snapshot
pid=call(d,dp,d,'GetConnectionUnixProcessID',GLib.Variant('(s)',(n,)))[0]
argv=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
assert b'/usr/share/wallpaper-suite/settings-manager/manager/main.js' in argv, argv
assert call(d,dp,d,'NameHasOwner',GLib.Variant('(s)',('dev.norvi.WallpaperSuite1',)))==(False,)
print(json.dumps({'activation':'installed Exec','pid':pid,'snapshot':snapshot,'capabilities':caps[2]}))
os.kill(pid,signal.SIGTERM)
PY
# Removal must leave both baseline extension bytes and user receipts intact.
mkdir -p "$scratch/state/wallpaper-suite"
printf '%s\n' keep-receipts > "$scratch/state/wallpaper-suite/keep"
dpkg --remove wallpaper-suite-settings-manager
sha256sum --check --quiet "$scratch/stable-files.sha256"
test "$(cat "$scratch/state/wallpaper-suite/keep")" = keep-receipts
test ! -e /usr/bin/wallpaper-suite-manager
test ! -e /usr/share/dbus-1/services/tech.norvi.WallpaperManager1.service
test ! -e /usr/lib/systemd/user/wallpaper-suite-manager.service
test ! -e /usr/share/wallpaper-suite/settings-manager/manager/main.js
echo 'PASS: installed manager activation and removal preserve the released extension'
