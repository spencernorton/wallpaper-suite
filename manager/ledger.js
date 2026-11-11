// Private durable request identities; never silently reset damaged metadata.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function validOperation(operation, id, purpose) {
    const p = operation.props;
    if (!p || Array.isArray(p) || operation.path !== `/tech/norvi/WallpaperManager1/operations/r${id.replaceAll('-', '')}` ||
        p.Id !== id || p.RequestId !== id || p.Kind !== purpose ||
        !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.State) ||
        !['queued', 'scan', 'decode', 'preview', 'validate', 'commit', 'publish', 'complete'].includes(p.Phase)) return false;
    for (const key of ['Progress', 'CompletedUnits', 'TotalUnits', 'StartedAtMs', 'FinishedAtMs'])
        if (!Number.isSafeInteger(p[key]) || p[key] < 0) return false;
    return p.Progress <= 10000 && typeof p.CanCancel === 'boolean' && typeof p.Partial === 'boolean' &&
        ['ResultCode', 'Message', 'Result', 'ResultInterface'].every(key => typeof p[key] === 'string' && p[key].length <= 4096) &&
        /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(p.Result);
}

export class Ledger {
    constructor(path) {
        this.path = path;
        this.fault = '';
        this.data = {schema: 1, revision: 0, requests: {}};
        try {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) {
                if (file.query_info('standard::size', 0, null).get_size() > 1024 * 1024)
                    throw new Error('Manager metadata exceeds its size limit');
                const [, bytes] = file.load_contents(null);
                const value = JSON.parse(new TextDecoder().decode(bytes));
                if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
                    !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests) ||
                    Object.keys(value.requests).length > 256)
                    throw new Error('Invalid manager metadata');
                for (const [id, request] of Object.entries(value.requests)) {
                    if (!/^[a-f0-9-]{36}$/.test(id) || typeof request.purpose !== 'string' ||
                        !Number.isSafeInteger(request.expires) || request.purpose.length > 64 ||
                        (request.operation && (!validOperation(request.operation, id, request.purpose) ||
                         typeof request.fingerprint !== 'string' || request.fingerprint.length > 65536)))
                        throw new Error('Invalid request receipt');
                    if (request.operation) {
                        delete request.operation.pollSource;
                        delete request.operation.polling;
                    }
                    if (['queued', 'running'].includes(request.operation?.props.State))
                        Object.assign(request.operation.props, {State: 'interrupted', Phase: 'complete',
                            CanCancel: false, ResultCode: 'outcome-unknown',
                            Message: 'The manager restarted; this action was not dispatched again.', FinishedAtMs: Date.now()});
                }
                this.data = value;
            }
        } catch (error) { this.fault = `${error.message || error}`; }
    }

    save() {
        if (this.fault) throw new Error(this.fault);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this.path), 0o700);
            const bytes = new TextEncoder().encode(JSON.stringify(this.data));
            if (bytes.length > 1024 * 1024) throw new Error('Manager receipt store is full');
            Gio.File.new_for_path(this.path).replace_contents(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) { this.fault = `${error.message || error}`; throw error; }
    }

    bump() {
        if (this.data.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision limit reached');
        this.data.revision++;
        this.save();
        return this.data.revision;
    }

    create(purpose) {
        const entries = Object.entries(this.data.requests);
        for (const [id, item] of entries)
            if (!item.operation && item.expires < Date.now()) delete this.data.requests[id];
        const terminal = Object.entries(this.data.requests).filter(([, r]) =>
            r.operation && !['queued', 'running'].includes(r.operation.props.State));
        while (Object.keys(this.data.requests).length >= 256 && terminal.length)
            delete this.data.requests[terminal.shift()[0]];
        if (Object.keys(this.data.requests).length >= 256) throw new Error('Too many retained requests');
        const id = GLib.uuid_string_random();
        this.data.requests[id] = {purpose, expires: Date.now() + 300000};
        this.save();
        return [id, this.data.requests[id].expires];
    }
}
