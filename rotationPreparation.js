// One optional look-ahead render. It never publishes, persists assignments,
// or commits a selection. Foreground work always takes precedence.

import GLib from 'gi://GLib';

export class RotationPreparation {
    constructor({scheduler, compositor, snapshot, protectedPaths}) {
        this._scheduler = scheduler;
        this._compositor = compositor;
        this._snapshot = snapshot;
        this._protectedPaths = protectedPaths;
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
                    if (result.ok)
                        entry.path = result.path;
                    else
                        this._entry = null;
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
        this._release(entry?.path);
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
            this._release(entry.path);
        }
    }

    dispose() {
        this._disposed = true;
        this.invalidate();
        this._compositor.dispose();
    }
}
