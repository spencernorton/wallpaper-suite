import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {topologyFromState, attachIdentities} from './displayIdentity.js';

export class DisplayIdentityClient {
    constructor(onChanged = null) {
        this._onChanged = onChanged;
        this._generation = 0;
        this._state = [];
        this.pending = false;
        this.error = '';
        this._closed = false;
        this._subscription = 0;
        try { this._bus = Gio.DBus.session; }
        catch (error) { this.error = `${error.message || error}`; return; }
        this._subscription = this._bus.signal_subscribe('org.gnome.Mutter.DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged', '/org/gnome/Mutter/DisplayConfig',
            null, Gio.DBusSignalFlags.NONE, () => this.refresh());
        this.refresh();
    }

    refresh() {
        if (this._closed || !this._bus) return;
        const generation = ++this._generation;
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this.pending = true;
        this._bus.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NONE, 3000, this._cancellable, (connection, result) => {
                if (this._closed || generation !== this._generation) return;
                try {
                    this._state = topologyFromState(connection.call_finish(result).deepUnpack());
                    this.error = '';
                } catch (error) {
                    this._state = [];
                    this.error = `${error.message || error}`;
                }
                this.pending = false;
                this._onChanged?.();
            });
    }

    attach(monitors, bindings = {}) {
        return attachIdentities(monitors, this._state, bindings);
    }

    dispose() {
        this._closed = true;
        this._cancellable?.cancel();
        if (this._subscription) this._bus.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        this._onChanged = null;
    }
}
