// Live monitor enumeration for the extension (shell-side).
// Prefs uses Gdk directly; this module is only loaded in extension.js.
//
// Geometry describes where to render. Unique hardware identity comes from
// Mutter's DisplayConfig API and follows the display through layout changes.
// Legacy geometry assignments remain available when identity is ambiguous.

import {DisplayIdentityClient} from './displayIdentityClient.js';

export function monitorKey(x, y, w, h) {
    return `${w}x${h}+${x}+${y}`;
}

export class MonitorManager {
    constructor(settings = null) {
        this._settings = settings;
        this._monitors = [];
        this._refresh();
        this._identities = new DisplayIdentityClient(() => this._callback?.(this.monitors));
    }

    _refresh() {
        const display = global.display;
        const n = display.get_n_monitors();
        const list = [];
        for (let i = 0; i < n; i++) {
            const rect = display.get_monitor_geometry(i);
            list.push({
                index: i,
                connector: monitorKey(rect.x, rect.y, rect.width, rect.height),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
        }
        this._monitors = list;
    }

    // Always re-read. This used to hand back a snapshot taken at construction
    // and refreshed only from 'monitors-changed' — so if the extension was
    // constructed while the layout was mid-flight (enable() runs on every
    // unlock, exactly while DisplayPort panels are waking and mutter is still
    // applying monitors.xml over its computed default scale), that wrong
    // layout stuck for the whole session and every rotation rendered to it.
    // Observed on a three-monitor desktop: rendered 11520x2160, then latched
    // onto a single 2560x1440 (one 4K panel at 150%) and stayed there for 2h+.
    // get_n_monitors()/get_monitor_geometry() are trivial C calls; callers that
    // captured an earlier value still compare against a fresh one, which is
    // what the layout-changed guards actually want.
    get monitors() {
        this._refresh();
        let bindings = {};
        try { bindings = this._settings?.get_value('display-bindings').deepUnpack() || {}; } catch (_) {}
        return this._identities.attach(this._monitors, bindings);
    }

    get ready() { return !this._identities.pending; }

    connectChange(callback) {
        this._callback = callback;
        // GNOME 50: 'monitors-changed' is on Meta.MonitorManager, not Meta.Display.
        // Use global.backend.get_monitor_manager() if available, fall back to display.
        let source = null;
        try {
            if (global.backend && global.backend.get_monitor_manager)
                source = global.backend.get_monitor_manager();
        } catch (_) {}
        if (!source) source = global.display;
        this._signalSource = source;
        this._signalId = source.connect('monitors-changed', () => {
            this._refresh();
            this._identities.refresh();
            callback(this.monitors);
        });
        return this._signalId;
    }

    disconnect() {
        this._identities.dispose();
        this._callback = null;
        if (this._signalId && this._signalSource) {
            this._signalSource.disconnect(this._signalId);
            this._signalId = 0;
            this._signalSource = null;
        }
    }
}
