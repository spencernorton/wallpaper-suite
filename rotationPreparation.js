// One optional look-ahead render. It never publishes, persists assignments,
// or commits a selection. Foreground work always takes precedence.

import GLib from 'gi://GLib';

export class RotationPreparation {
    constructor({scheduler, compositor, snapshot, protectedPaths, createImagePreparer = null,
        mayWarm = () => true}) {
        this._scheduler = scheduler;
        this._compositor = compositor;
        this._snapshot = snapshot;
        this._protectedPaths = protectedPaths;
        this._createImagePreparer = createImagePreparer;
        this._mayWarm = mayWarm;
        this._entry = null;
        this._timer = 0;
        this._disposed = false;
    }

    schedule() {
        if (this._disposed || this._timer)
            return;
        const snapshot = this._snapshot();
        if (!snapshot)
            return;
        if (this._entry?.context === snapshot.context)
            return;
        this.invalidate();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 1200, () => {
            this._timer = 0;
            const current = this._snapshot();
            if (!current || this._disposed)
                return GLib.SOURCE_REMOVE;
            const choice = this._scheduler.prepareNext(current.monitors, current.assignments);
            if (!choice)
                return GLib.SOURCE_REMOVE;
            const entry = {context: current.context, choice, generation: 0, path: null};
            this._entry = entry;
            entry.generation = this._compositor.compositeAsync(current.monitors,
                choice.assignments, current.modes, current.quality,
                // A unique output prevents a cancelled background worker from
                // ever overwriting an active foreground generation.
                {force: true, background: true}, result => {
                    if (this._disposed || this._entry !== entry ||
                        this._snapshot()?.context !== entry.context) {
                        if (this._entry === entry)
                            this._entry = null;
                        this._release(result.path);
                        return;
                    }
                    if (result.ok) {
                        entry.renderedPath = result.path;
                        this._warmImage(entry);
                    } else {
                        this._entry = null;
                    }
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    take() {
        const entry = this._entry;
        const current = this._snapshot();
        if (!entry?.path || !current || entry.context !== current.context) {
            this.invalidate();
            return null;
        }
        this._entry = null;
        return entry;
    }

    release(entry) {
        if (!entry || entry.released)
            return;
        entry.released = true;
        if (entry.idleTimer)
            GLib.Source.remove(entry.idleTimer);
        const preparer = entry.preparer;
        entry.preparer = null;
        preparer?.dispose();
        this._release(entry.renderedPath || entry.path);
    }

    _warmImage(entry) {
        if (!this._createImagePreparer) {
            entry.path = entry.renderedPath;
            return;
        }
        // Texture upload belongs to Mutter's main loop. Defer that optional
        // warm-up until input is idle, rather than interrupting a drag or typing.
        if (!this._mayWarm()) {
            entry.idleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 250, () => {
                entry.idleTimer = 0;
                if (this._disposed || this._entry !== entry ||
                    this._snapshot()?.context !== entry.context) {
                    if (this._entry === entry)
                        this._entry = null;
                    this.release(entry);
                } else {
                    this._warmImage(entry);
                }
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        entry.preparer = this._createImagePreparer();
        entry.preparer.prepare(entry.renderedPath, result => {
            if (!result.ok || this._disposed || this._entry !== entry ||
                this._snapshot()?.context !== entry.context) {
                if (this._entry === entry)
                    this._entry = null;
                this.release(entry);
                return;
            }
            entry.path = entry.renderedPath;
        });
    }

    _release(path) {
        if (path)
            this._compositor.releaseObsolete([path], this._protectedPaths());
    }

    invalidate() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        const entry = this._entry;
        this._entry = null;
        if (entry) {
            this._compositor.cancel(entry.generation);
            this.release(entry);
        }
    }

    dispose() {
        this._disposed = true;
        this.invalidate();
        this._compositor.dispose();
    }
}
