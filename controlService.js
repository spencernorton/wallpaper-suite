// Stable session-bus control surface for Wallpaper Suite.
//
// The exported contract intentionally knows nothing about GNOME Shell. The
// current extension supplies the action callback; a later standalone
// controller can own the same bus name without changing clients such as DING.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const CONTROL_BUS_NAME = 'dev.norvi.WallpaperSuite1';
export const CONTROL_OBJECT_PATH = '/dev/norvi/WallpaperSuite1';
export const CONTROL_INTERFACE = 'dev.norvi.WallpaperSuite1';
export const CONTROL_API_VERSION = 1;

export const CONTROL_INTERFACE_XML = `
<node>
  <interface name="${CONTROL_INTERFACE}">
    <method name="Next">
      <arg name="options" type="a{sv}" direction="in"/>
      <arg name="operation_id" type="s" direction="out"/>
    </method>
    <method name="GetOperation">
      <arg name="operation_id" type="s" direction="in"/>
      <arg name="found" type="b" direction="out"/>
      <arg name="state" type="s" direction="out"/>
      <arg name="ok" type="b" direction="out"/>
      <arg name="changed" type="b" direction="out"/>
      <arg name="published" type="b" direction="out"/>
      <arg name="code" type="s" direction="out"/>
      <arg name="message" type="s" direction="out"/>
      <arg name="started_at_ms" type="x" direction="out"/>
      <arg name="finished_at_ms" type="x" direction="out"/>
    </method>
    <method name="GetStatus">
      <arg name="api_version" type="u" direction="out"/>
      <arg name="active" type="b" direction="out"/>
      <arg name="busy" type="b" direction="out"/>
      <arg name="rotation_enabled" type="b" direction="out"/>
      <arg name="current_operation_id" type="s" direction="out"/>
    </method>
    <signal name="OperationFinished">
      <arg name="operation_id" type="s"/>
      <arg name="ok" type="b"/>
      <arg name="code" type="s"/>
      <arg name="message" type="s"/>
    </signal>
  </interface>
</node>`;

const ALLOWED_SOURCES = new Set([
    'cli',
    'dbus',
    'desktop-menu',
    'indicator',
    'preferences',
    'shortcut',
]);

const LEDGER_VERSION = 1;
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_LEDGER_RECORDS = 256;
const OPERATION_STATES = new Set(['running', 'succeeded', 'failed', 'cancelled']);
const OPTION_KEYS = new Set(['source', 'reset-timer', 'request-id']);

function _unpack(value) {
    if (value && typeof value.deepUnpack === 'function')
        return value.deepUnpack();
    if (value && typeof value.unpack === 'function')
        return value.unpack();
    return value;
}

function _boundedString(value, fallback = '', maxLength = 512) {
    const text = `${value ?? fallback}`;
    return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function _terminalState(result) {
    if (result?.ok === true)
        return 'succeeded';
    if (['cancelled', 'disposed', 'stale', 'superseded'].includes(result?.code))
        return 'cancelled';
    return 'failed';
}

function _ledgerString(value, label, maxLength, {allowEmpty = true} = {}) {
    if (typeof value !== 'string' || value.length > maxLength ||
        (!allowEmpty && value.length === 0))
        throw new Error(`invalid ${label}`);
    return value;
}

function _ledgerTimestamp(value, label, {allowZero = true} = {}) {
    if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0))
        throw new Error(`invalid ${label}`);
    return value;
}

export class ControlService {
    constructor(options = {}) {
        this._onNext = options.onNext || (() => false);
        this._getStatus = options.getStatus || (() => ({}));
        this._onAvailabilityChanged = options.onAvailabilityChanged || null;
        this._maxOperations = Math.max(8, Number(options.maxOperations) || 64);
        this._maxActive = Math.max(1, Number(options.maxActive) || 16);
        this._statePath = `${options.statePath || ''}`.trim();
        this._operations = new Map();
        this._order = [];
        this._idempotency = new Map();
        this._ownerId = 0;
        this._exported = null;
        this._available = null;
        this._stopped = false;
        this._stateFault = '';
        this._loadLedger();
    }

    get available() {
        return this._available === true;
    }

    start() {
        if (this._ownerId || this._stopped)
            return;
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            CONTROL_BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            connection => this._onBusAcquired(connection),
            () => this._setAvailable(Boolean(this._exported)),
            () => this._setAvailable(false)
        );
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        for (const operation of this._operations.values()) {
            if (operation.state === 'running') {
                this._complete(operation, {
                    ok: false,
                    code: 'cancelled',
                    message: 'Wallpaper Suite control service stopped',
                });
            }
        }
        try { this._exported?.unexport(); } catch (_) {}
        this._exported = null;
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._setAvailable(false);
    }

    Next(rawOptions = {}) {
        const options = this._normalizeOptions(rawOptions);
        const idempotencyIdentity = options.requestId
            ? `${options.source}\u0000${options.requestId}`
            : '';
        if (idempotencyIdentity) {
            const existingId = this._idempotency.get(idempotencyIdentity);
            if (existingId && this._operations.has(existingId))
                return existingId;
        }

        const operation = {
            id: GLib.uuid_string_random(),
            state: 'running',
            ok: false,
            changed: false,
            published: false,
            code: 'running',
            message: '',
            source: options.source,
            requestId: options.requestId,
            idempotencyIdentity,
            startedAtMs: Date.now(),
            finishedAtMs: 0,
        };
        if (!this._remember(operation)) {
            this._complete(operation, {
                ok: false,
                code: 'state-store-failed',
                message: 'The durable operation record could not be saved',
            });
            return operation.id;
        }

        if (!options.valid) {
            this._complete(operation, {
                ok: false,
                code: 'invalid-options',
                message: options.error,
            });
            return operation.id;
        }

        if (this._stopped) {
            this._complete(operation, {
                ok: false,
                code: 'inactive',
                message: 'Wallpaper Suite control service is stopped',
            });
            return operation.id;
        }

        if (this._activeCount() > this._maxActive) {
            this._complete(operation, {
                ok: false,
                code: 'busy',
                message: 'Too many wallpaper actions are already in progress',
            });
            return operation.id;
        }

        try {
            const accepted = this._onNext({
                resetTimer: options.resetTimer,
                source: options.source,
                requestId: options.requestId,
            }, result => this._complete(operation, result));
            if (accepted === false && operation.state === 'running') {
                this._complete(operation, {
                    ok: false,
                    code: 'inactive',
                    message: 'Wallpaper Suite is not ready',
                });
            }
        } catch (error) {
            this._complete(operation, {
                ok: false,
                code: 'internal-error',
                message: `${error?.message || error}`,
            });
        }
        return operation.id;
    }

    GetOperation(operationId) {
        const operation = this._operations.get(`${operationId || ''}`);
        if (!operation)
            return [false, 'unknown', false, false, false, 'not-found', '', 0, 0];
        return [
            true,
            operation.state,
            operation.ok,
            operation.changed,
            operation.published,
            operation.code,
            operation.message,
            operation.startedAtMs,
            operation.finishedAtMs,
        ];
    }

    GetStatus() {
        let status = {};
        try { status = this._getStatus() || {}; } catch (_) {}
        const current = [...this._order].reverse()
            .map(id => this._operations.get(id))
            .find(operation => operation?.state === 'running');
        return [
            CONTROL_API_VERSION,
            status.active !== false && !this._stopped && !this._stateFault,
            Boolean(current),
            status.rotationEnabled === true,
            current?.id || '',
        ];
    }

    _normalizeOptions(rawOptions) {
        const input = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
        const has = key => Object.prototype.hasOwnProperty.call(input, key);
        const rawSource = has('source') ? _unpack(input.source) : 'dbus';
        const rawResetTimer = has('reset-timer')
            ? _unpack(input['reset-timer'])
            : true;
        const rawRequestId = has('request-id')
            ? _unpack(input['request-id'])
            : '';

        let error = '';
        const unknownKey = Object.keys(input).find(key => !OPTION_KEYS.has(key));
        if (unknownKey)
            error = `unsupported option: ${unknownKey}`;
        else if (typeof rawSource !== 'string' || !ALLOWED_SOURCES.has(rawSource))
            error = 'source must be a supported string value';
        else if (typeof rawResetTimer !== 'boolean')
            error = 'reset-timer must be a boolean';
        else if (typeof rawRequestId !== 'string')
            error = 'request-id must be a string';
        else if (has('request-id') && !rawRequestId.trim())
            error = 'request-id must not be blank';
        else if (rawRequestId.trim().length > 128)
            error = 'request-id must be at most 128 characters';

        return {
            valid: !error,
            error,
            source: typeof rawSource === 'string' && ALLOWED_SOURCES.has(rawSource)
                ? rawSource
                : 'dbus',
            resetTimer: typeof rawResetTimer === 'boolean' ? rawResetTimer : true,
            requestId: typeof rawRequestId === 'string'
                ? rawRequestId.trim().slice(0, 128)
                : '',
        };
    }

    _onBusAcquired(connection) {
        if (this._stopped)
            return;
        try {
            this._exported?.unexport();
            this._exported = Gio.DBusExportedObject.wrapJSObject(
                CONTROL_INTERFACE_XML,
                this
            );
            this._exported.export(connection, CONTROL_OBJECT_PATH);
        } catch (error) {
            console.error(`wallpaper-suite: failed to export control API: ${error}`);
            this._exported = null;
        }
    }

    _setAvailable(available) {
        const next = available === true && !this._stopped;
        if (this._available === next)
            return;
        this._available = next;
        try { this._onAvailabilityChanged?.(next); } catch (_) {}
    }

    _remember(operation) {
        this._operations.set(operation.id, operation);
        this._order.push(operation.id);
        if (operation.idempotencyIdentity)
            this._idempotency.set(operation.idempotencyIdentity, operation.id);
        this._trim();
        return this._persistLedger();
    }

    _activeCount() {
        let count = 0;
        for (const operation of this._operations.values()) {
            if (operation.state === 'running')
                count++;
        }
        return count;
    }

    _complete(operation, result = {}) {
        if (!operation || operation.state !== 'running')
            return false;
        operation.ok = result?.ok === true;
        operation.changed = result?.changed === true;
        operation.published = result?.published === true;
        operation.code = _boundedString(
            result?.code,
            operation.ok ? 'completed' : 'failed',
            96
        );
        operation.message = _boundedString(result?.message, '', 512);
        operation.state = _terminalState({
            ok: operation.ok,
            code: operation.code,
        });
        operation.finishedAtMs = Date.now();
        this._trim();
        const terminalSaved = this._persistLedger();
        if (!terminalSaved && operation.ok) {
            const originalCode = operation.code;
            const originalMessage = operation.message;
            operation.ok = false;
            operation.state = 'failed';
            operation.code = operation.published ? 'partial' : 'durability-failed';
            operation.message = _boundedString([
                originalMessage || originalCode,
                'the terminal operation record could not be saved durably',
            ].filter(Boolean).join('; '), '', 512);
            // A transient first write can still preserve the degraded result.
            // If this retry also fails, callers nevertheless observe failure
            // in-memory instead of a false durable-success guarantee.
            this._persistLedger();
        }
        try {
            this._exported?.emit_signal(
                'OperationFinished',
                new GLib.Variant('(sbss)', [
                    operation.id,
                    operation.ok,
                    operation.code,
                    operation.message,
                ])
            );
        } catch (error) {
            console.warn(`wallpaper-suite: failed to emit operation result: ${error}`);
        }
        return true;
    }

    _trim() {
        while (this._operations.size > this._maxOperations) {
            const removableIndex = this._order.findIndex(id =>
                this._operations.get(id)?.state !== 'running');
            if (removableIndex < 0)
                break;
            const [id] = this._order.splice(removableIndex, 1);
            const removed = this._operations.get(id);
            this._operations.delete(id);
            if (removed?.idempotencyIdentity &&
                this._idempotency.get(removed.idempotencyIdentity) === id) {
                this._idempotency.delete(removed.idempotencyIdentity);
            }
        }
    }

    _loadLedger() {
        if (!this._statePath)
            return;
        const stateFile = Gio.File.new_for_path(this._statePath);
        if (!stateFile.query_exists(null))
            return;
        let decoded;
        try {
            const info = stateFile.query_info(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                throw new Error('control ledger is not a regular file');
            const size = Number(info.get_size());
            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LEDGER_BYTES)
                throw new Error(`control ledger exceeds ${MAX_LEDGER_BYTES} bytes`);
            const [ok, contents] = GLib.file_get_contents(this._statePath);
            if (!ok)
                throw new Error('control ledger could not be read');
            if (contents.length > MAX_LEDGER_BYTES)
                throw new Error(`control ledger exceeds ${MAX_LEDGER_BYTES} bytes`);
            decoded = JSON.parse(new TextDecoder().decode(contents));
        } catch (error) {
            // Malformed or unreadable state fails closed: overwriting it could
            // erase an identity whose action already reached URI publication.
            this._stateFault = `${error}`;
            console.warn(`wallpaper-suite: control ledger is unusable: ${error}`);
            return;
        }
        let recoveredRunning = false;
        const loaded = [];
        const loadedIds = new Set();
        const loadedIdentities = new Set();
        try {
            if (decoded?.version !== LEDGER_VERSION || !Array.isArray(decoded.operations) ||
                decoded.operations.length > MAX_LEDGER_RECORDS)
                throw new Error('unsupported or malformed control ledger');
            for (const raw of decoded.operations) {
                if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                    throw new Error('invalid operation record');
                const id = _ledgerString(raw.id, 'operation id', 128, {allowEmpty: false});
                const state = _ledgerString(raw.state, 'operation state', 16,
                    {allowEmpty: false});
                const code = _ledgerString(raw.code, 'operation code', 96,
                    {allowEmpty: false});
                const message = _ledgerString(raw.message, 'operation message', 512);
                const source = _ledgerString(raw.source, 'operation source', 64,
                    {allowEmpty: false});
                const requestId = _ledgerString(raw.requestId, 'request id', 128).trim();
                if (!OPERATION_STATES.has(state) || !ALLOWED_SOURCES.has(source) ||
                    typeof raw.ok !== 'boolean' || typeof raw.changed !== 'boolean' ||
                    typeof raw.published !== 'boolean' || loadedIds.has(id))
                    throw new Error('invalid operation record fields');
                if ((state === 'succeeded') !== raw.ok)
                    throw new Error('operation state/result mismatch');
                const startedAtMs = _ledgerTimestamp(
                    raw.startedAtMs, 'operation start timestamp', {allowZero: false});
                const finishedAtMs = _ledgerTimestamp(
                    raw.finishedAtMs, 'operation finish timestamp');
                if ((state === 'running' && finishedAtMs !== 0) ||
                    (state !== 'running' && finishedAtMs === 0))
                    throw new Error('operation timestamp/state mismatch');
                const identity = requestId ? `${source}\u0000${requestId}` : '';
                if (identity && loadedIdentities.has(identity))
                    throw new Error('duplicate request identity');
                loadedIds.add(id);
                if (identity)
                    loadedIdentities.add(identity);
                const operation = {
                    id,
                    state,
                    ok: raw.ok,
                    changed: raw.changed,
                    published: raw.published,
                    code,
                    message,
                    source,
                    requestId,
                    idempotencyIdentity: identity,
                    startedAtMs,
                    finishedAtMs,
                };
                if (operation.state === 'running') {
                    operation.state = 'failed';
                    operation.ok = false;
                    operation.code = 'interrupted';
                    operation.message =
                        'GNOME Shell restarted before the operation result was recorded';
                    operation.finishedAtMs = Date.now();
                    recoveredRunning = true;
                }
                loaded.push(operation);
            }
        } catch (error) {
            this._stateFault = `${error}`;
            console.warn(`wallpaper-suite: control ledger is unusable: ${error}`);
            return;
        }
        for (const operation of loaded) {
            this._operations.set(operation.id, operation);
            this._order.push(operation.id);
            if (operation.idempotencyIdentity)
                this._idempotency.set(operation.idempotencyIdentity, operation.id);
        }
        this._trim();
        if (recoveredRunning && !this._persistLedger())
            this._stateFault = 'recovered operation ledger could not be saved';
    }

    _persistLedger() {
        if (!this._statePath)
            return true;
        if (this._stateFault)
            return false;
        const directory = GLib.path_get_dirname(this._statePath);
        const temporaryPath = `${this._statePath}.tmp-${GLib.uuid_string_random()}`;
        try {
            if (GLib.mkdir_with_parents(directory, 0o700) < 0)
                throw new Error(`could not create ${directory}`);
            const operations = this._order
                .map(id => this._operations.get(id))
                .filter(Boolean)
                .map(operation => ({
                    id: operation.id,
                    state: operation.state,
                    ok: operation.ok,
                    changed: operation.changed,
                    published: operation.published,
                    code: operation.code,
                    message: operation.message,
                    source: operation.source,
                    requestId: operation.requestId,
                    startedAtMs: operation.startedAtMs,
                    finishedAtMs: operation.finishedAtMs,
                }));
            if (!GLib.file_set_contents(temporaryPath, JSON.stringify({
                version: LEDGER_VERSION,
                operations,
            })))
                throw new Error('temporary ledger write was rejected');
            try { GLib.chmod(temporaryPath, 0o600); } catch (_) {}
            if (GLib.rename(temporaryPath, this._statePath) !== 0)
                throw new Error('atomic ledger replacement failed');
            return true;
        } catch (error) {
            try { GLib.unlink(temporaryPath); } catch (_) {}
            console.error(`wallpaper-suite: failed to persist control ledger: ${error}`);
            return false;
        }
    }
}
