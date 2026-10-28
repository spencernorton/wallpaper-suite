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
        laters = global.compositor.get_laters(), mayRelease = () => true} = {}) {
        this._getManagers = getManagers || (() => []);
        this._imageCache = imageCache;
        this._laters = laters;
        this._mayRelease = mayRelease;
        this._retiredImages = [];
        this._retireTimer = 0;
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
        const watch = {entries: [], laters: new Set(), timeout: 0, image: this._readyImage,
            file, uri, settingsHooks: [], previousImages: []};
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
            this._observeOwnedSettings(watch);
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

    _observeOwnedSettings(watch) {
        const backgrounds = [...new Set(watch.entries.map(entry => entry.oldActor.content?.background))];
        // A static Shell Background on the supported versions can update its
        // native image without throwing away three large monitor framebuffers.
        // Other actors, slideshows, and pending foreign changes use Shell's
        // normal replacement path instead.
        if (!backgrounds.length || !backgrounds.every(background =>
            background?.isLoaded && !background._animation && !background._changedIdleId &&
            background._settings?.schema_id === 'org.gnome.desktop.background' &&
            background._fileWatches && typeof background._cache?.disconnect === 'function' &&
            typeof background.set_file === 'function'))
            return;
        watch.backgrounds = backgrounds;
        for (const background of backgrounds) {
            if (background._file) {
                const previous = this._imageCache.load(background._file);
                if (previous.is_loaded() && previous.get_success())
                    watch.previousImages.push(previous);
            }
        }
        for (const settings of new Set(backgrounds.map(background => background._settings))) {
            const id = settings.connect('change-event', (source, keys) => {
                const names = keys && Array.from(keys, key =>
                    typeof key === 'string' ? key : GLib.quark_to_string(key));
                const owned = names?.length && names.every(key =>
                    ['picture-uri', 'picture-uri-dark', 'picture-options'].includes(key)) &&
                    source.get_string('picture-uri') === watch.uri &&
                    source.get_string('picture-uri-dark') === watch.uri &&
                    source.get_string('picture-options') === 'spanned';
                if (!owned || watch.cleared) {
                    this._clearWatch(watch);
                    return false;
                }
                // Handle only this exact transaction on the Background's own
                // settings instance. Every other consumer and settings change
                // retains normal GSettings notification behavior.
                return true;
            });
            watch.settingsHooks.push({settings, id});
        }
    }

    commitPublication(uri) {
        const watch = this._watch;
        if (!watch?.backgrounds || watch.cleared || watch.uri !== uri)
            return false;
        if (watch.entries.some(entry => entry.destroyed || entry.manager.backgroundActor !== entry.oldActor) ||
            watch.backgrounds.some(background => background._changedIdleId || background._cancellable?.is_cancelled())) {
            this._clearWatch(watch);
            return false;
        }
        try {
            for (const background of watch.backgrounds) {
                for (const id of Object.values(background._fileWatches))
                    background._cache.disconnect(id);
                // Managed outputs are immutable. Watching a retired filename
                // would cause a second reload when exact cache cleanup unlinks it.
                background._fileWatches = {};
                background._file = watch.file;
                background._style = background._settings.get_enum('picture-options');
                background.set_file(watch.file, background._style);
            }
            if (watch.timeout)
                GLib.Source.remove(watch.timeout);
            watch.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                watch.timeout = 0;
                this._clearWatch(watch);
                return GLib.SOURCE_REMOVE;
            });
            return true;
        } catch (error) {
            this._clearWatch(watch);
            // If a Shell integration changed underneath us, rebuild from the
            // verified settings through Shell's ordinary path.
            for (const background of watch.backgrounds)
                background._emitChangedSignal?.();
            console.warn(`wallpaper-suite: using native background replacement: ${error}`);
            return false;
        }
    }

    _clearWatch(watch) {
        if (!watch || watch.cleared)
            return;
        watch.cleared = true;
        if (watch.timeout)
            GLib.Source.remove(watch.timeout);
        for (const id of watch.laters)
            this._laters.remove(id);
        for (const {settings, id} of watch.settingsHooks)
            settings.disconnect(id);
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
        if (!this._disposed && watch.previousImages.length) {
            this._retiredImages.push(...watch.previousImages);
            this._retiredImages = this._retiredImages.slice(-2);
            if (!this._retireTimer) {
                this._retireTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 250, () => {
                    if (!this._mayRelease())
                        return true;
                    this._retireTimer = 0;
                    this._retiredImages = [];
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    dispose() {
        this._disposed = true;
        if (this._preparation)
            this._complete(this._preparation, false, 'cancelled', 'Wallpaper Suite was disabled');
        this._clearWatch(this._watch);
        this._readyImage = null;
        if (this._retireTimer)
            GLib.Source.remove(this._retireTimer);
        this._retireTimer = 0;
        this._retiredImages = [];
    }
}
