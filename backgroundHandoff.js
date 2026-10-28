// Prepare the native background texture before publishing its URI. The old
// desktop stays visible throughout decoding; only this wallpaper's fade is
// shortened, without changing the user's animation settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const LOAD_TIMEOUT_MS = 15000;
const FADE_MS = 160;

export class BackgroundHandoff {
    constructor({getManagers, imageCache = Meta.BackgroundImageCache.get_default(),
        laters = global.compositor.get_laters()} = {}) {
        this._getManagers = getManagers || (() => []);
        this._imageCache = imageCache;
        this._laters = laters;
        this._preparation = null;
        this._watch = null;
        this._readyImage = null;
        this._disposed = false;
    }

    get busy() {
        return Boolean(this._preparation);
    }

    prepare(path, onDone) {
        const request = {onDone, image: null, signal: 0, timeout: 0,
            startedUs: GLib.get_monotonic_time(), done: false};
        const previous = this._preparation;
        this._preparation = request;
        if (previous)
            this._complete(previous, false, 'superseded', 'A newer wallpaper replaced this preparation');
        if (request.done || this._preparation !== request)
            return;
        if (this._disposed) {
            this._complete(request, false, 'cancelled', 'Wallpaper Suite was disabled');
            return;
        }
        try {
            request.image = this._imageCache.load(Gio.File.new_for_path(path));
            const loaded = () => {
                const success = request.image.get_success();
                this._complete(request, success, success ? 'ready' : 'background-load-failed',
                    success ? '' : 'GNOME could not load the replacement background');
            };
            if (request.image.is_loaded()) {
                loaded();
            } else {
                request.signal = request.image.connect('loaded', loaded);
                request.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOAD_TIMEOUT_MS, () => {
                    request.timeout = 0;
                    this._complete(request, false, 'background-load-timeout',
                        'GNOME did not finish preparing the replacement background');
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (error) {
            this._complete(request, false, 'background-load-failed', String(error));
        }
    }

    _complete(request, ok, code, message) {
        if (request.done)
            return;
        request.done = true;
        if (request.signal)
            request.image.disconnect(request.signal);
        if (request.timeout)
            GLib.Source.remove(request.timeout);
        if (this._preparation === request)
            this._preparation = null;
        if (ok)
            this._readyImage = request.image;
        request.onDone({ok, code, message,
            preparationMs: (GLib.get_monotonic_time() - request.startedUs) / 1000});
    }

    // Install before writing settings: BackgroundManager emits changed only
    // after its replacement is loaded. Its native opacity transition has been
    // created by BEFORE_REDRAW, so it can be retimed without replacing Shell
    // methods or destroying an actor that Shell still owns.
    watchPublication(uri) {
        this._clearWatch(this._watch);
        const file = Gio.File.new_for_uri(uri);
        const watch = {entries: [], laters: new Set(), timeout: 0, image: this._readyImage};
        this._watch = watch;
        const finish = () => {
            if (watch.entries.every(entry => entry.matched) && !watch.laters.size)
                this._clearWatch(watch);
        };
        for (const manager of this._getManagers()) {
            const oldActor = manager.backgroundActor;
            if (!oldActor)
                continue;
            const entry = {manager, oldActor, changed: 0, destroyed: false, destroy: 0, matched: false};
            watch.entries.push(entry);
            entry.destroy = oldActor.connect('destroy', () => { entry.destroyed = true; });
            entry.changed = manager.connect('changed', () => {
                const current = manager.backgroundActor;
                if (current === oldActor || !current?.content?.background?._file?.equal(file))
                    return;
                entry.matched = true;
                const id = this._laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                    watch.laters.delete(id);
                    const stillCurrent = manager.backgroundActor === current &&
                        current.content?.background?._file?.equal(file);
                    if (!this._disposed && !entry.destroyed && stillCurrent) {
                        const transition = oldActor.get_transition('opacity');
                        if (transition && transition.get_duration() > FADE_MS)
                            transition.set_duration(FADE_MS);
                    }
                    finish();
                    return GLib.SOURCE_REMOVE;
                });
                watch.laters.add(id);
            });
        }
        if (watch.entries.length) {
            watch.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                watch.timeout = 0;
                this._clearWatch(watch);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._clearWatch(watch);
        }
        return () => this._clearWatch(watch);
    }

    _clearWatch(watch) {
        if (!watch || watch.cleared)
            return;
        watch.cleared = true;
        if (watch.timeout)
            GLib.Source.remove(watch.timeout);
        for (const id of watch.laters)
            this._laters.remove(id);
        for (const entry of watch.entries) {
            entry.manager.disconnect(entry.changed);
            if (!entry.destroyed)
                entry.oldActor.disconnect(entry.destroy);
        }
        if (this._watch === watch) {
            this._watch = null;
            if (this._readyImage === watch.image)
                this._readyImage = null;
        }
    }

    dispose() {
        this._disposed = true;
        if (this._preparation)
            this._complete(this._preparation, false, 'cancelled', 'Wallpaper Suite was disabled');
        this._clearWatch(this._watch);
        this._readyImage = null;
    }
}
