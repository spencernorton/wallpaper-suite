#!/usr/bin/gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    ControlService,
    CONTROL_API_VERSION,
    CONTROL_BUS_NAME,
    CONTROL_INTERFACE,
    CONTROL_OBJECT_PATH,
} from '../controlService.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function optionString(value) {
    return new GLib.Variant('s', value);
}

function optionBoolean(value) {
    return new GLib.Variant('b', value);
}

// The in-memory contract is queryable, exactly-once, idempotent, and bounded.
const pending = [];
const direct = new ControlService({
    onNext(options, onDone) {
        pending.push({options, onDone});
        return true;
    },
    getStatus: () => ({active: true, rotationEnabled: false}),
    maxOperations: 8,
    maxActive: 2,
});

const first = direct.Next({
    source: optionString('desktop-menu'),
    'reset-timer': optionBoolean(true),
    'request-id': optionString('click-1'),
});
const duplicate = direct.Next({
    source: optionString('desktop-menu'),
    'reset-timer': optionBoolean(true),
    'request-id': optionString('click-1'),
});
assert(first === duplicate, 'a caller retry returns the original operation id');
assert(pending.length === 1, 'an idempotent retry never dispatches twice');
assert(pending[0].options.source === 'desktop-menu' &&
    pending[0].options.resetTimer === true,
'allowlisted action options reach the engine');

pending[0].onDone({ok: true, code: 'published', message: ''});
pending[0].onDone({ok: false, code: 'late-error', message: 'ignored'});
const completed = direct.GetOperation(first);
assert(completed[0] && completed[1] === 'succeeded' && completed[2] &&
    completed[5] === 'published',
'the first terminal result wins and remains queryable');
assert(direct.GetStatus()[0] === CONTROL_API_VERSION &&
    direct.GetStatus()[2] === false,
'status reports the stable API version and idle state');

const invalidBlank = direct.Next({
    source: optionString('cli'),
    'request-id': optionString('   '),
});
const invalidType = direct.Next({
    source: optionString('cli'),
    'request-id': optionString('invalid-type'),
    'reset-timer': optionString('true'),
});
const invalidUnknown = direct.Next({
    source: optionString('cli'),
    'request-id': optionString('invalid-unknown'),
    reset_timer: optionBoolean(false),
});
assert(direct.GetOperation(invalidBlank)[5] === 'invalid-options' &&
    direct.GetOperation(invalidType)[5] === 'invalid-options' &&
    direct.GetOperation(invalidUnknown)[5] === 'invalid-options',
'blank identifiers, mistyped values, and unknown keys fail explicitly');
assert(pending.length === 1, 'invalid options never reach the wallpaper engine');

const activeA = direct.Next({'request-id': optionString('active-a')});
const activeB = direct.Next({'request-id': optionString('active-b')});
const rejected = direct.Next({'request-id': optionString('over-capacity')});
assert(direct.GetOperation(activeA)[1] === 'running' &&
    direct.GetOperation(activeB)[1] === 'running',
'the configured active-operation bound is honored');
assert(direct.GetOperation(rejected)[1] === 'failed' &&
    direct.GetOperation(rejected)[5] === 'busy',
'excess actions complete explicitly as busy');

direct.stop();
assert(direct.GetOperation(activeA)[1] === 'cancelled' &&
    direct.GetOperation(activeB)[1] === 'cancelled',
'service shutdown completes every accepted operation once');
const afterStop = direct.Next({'request-id': optionString('after-stop')});
assert(direct.GetOperation(afterStop)[5] === 'inactive' && pending.length === 3,
    'a stopped service cannot dispatch another engine action');

// Request identity and terminal results survive a Shell/service restart. A
// request found running after a crash is conservatively closed as interrupted,
// so retrying the same identifier can never advance the wallpaper twice.
const ledgerDirectory = GLib.dir_make_tmp('wallpaper-suite-control-XXXXXX');
const ledgerPath = GLib.build_filenamev([ledgerDirectory, 'operations.json']);
let durableDispatches = 0;
const durable = new ControlService({
    statePath: ledgerPath,
    onNext(_options, onDone) {
        durableDispatches++;
        onDone({ok: true, code: 'published', changed: true, published: true});
        return true;
    },
});
const durableId = durable.Next({
    source: optionString('desktop-menu'),
    'request-id': optionString('durable-published'),
});
assert(durable.GetOperation(durableId)[1] === 'succeeded',
    'the durable service records a terminal publication');

let restartedDispatches = 0;
const restarted = new ControlService({
    statePath: ledgerPath,
    onNext() {
        restartedDispatches++;
        return true;
    },
});
assert(restarted.Next({
    source: optionString('desktop-menu'),
    'request-id': optionString('durable-published'),
}) === durableId && restartedDispatches === 0,
'a terminal retry after restart returns the original operation without dispatch');

const interruptedId = restarted.Next({
    source: optionString('cli'),
    'request-id': optionString('interrupted-running'),
});
assert(restarted.GetOperation(interruptedId)[1] === 'running',
    'the synthetic crash leaves one durable running operation');
let recoveredDispatches = 0;
const recovered = new ControlService({
    statePath: ledgerPath,
    onNext() {
        recoveredDispatches++;
        return true;
    },
});
const recoveredResult = recovered.GetOperation(interruptedId);
assert(recoveredResult[1] === 'failed' && recoveredResult[5] === 'interrupted',
    'a running record is closed conservatively after restart');
assert(recovered.Next({
    source: optionString('cli'),
    'request-id': optionString('interrupted-running'),
}) === interruptedId && recoveredDispatches === 0,
'retrying an interrupted identity never dispatches a second advance');
assert(durableDispatches === 1 && restartedDispatches === 1,
    'only distinct durable request identities dispatch');
try { GLib.unlink(ledgerPath); } catch (_) {}
try { GLib.rmdir(ledgerDirectory); } catch (_) {}

const corruptDirectory = GLib.dir_make_tmp('wallpaper-suite-corrupt-XXXXXX');
const corruptPath = GLib.build_filenamev([corruptDirectory, 'operations.json']);
GLib.file_set_contents(corruptPath, '{not-json');
let corruptDispatches = 0;
const corrupt = new ControlService({
    statePath: corruptPath,
    onNext() {
        corruptDispatches++;
        return true;
    },
});
const corruptId = corrupt.Next({
    source: optionString('cli'),
    'request-id': optionString('must-not-overwrite-corrupt-state'),
});
assert(corrupt.GetOperation(corruptId)[5] === 'state-store-failed' &&
    corruptDispatches === 0,
'a corrupt existing ledger fails closed instead of risking a duplicate action');
assert(corrupt.GetStatus()[1] === false,
    'a corrupt durable ledger reports the control service inactive');
try { GLib.unlink(corruptPath); } catch (_) {}
try { GLib.rmdir(corruptDirectory); } catch (_) {}

const oversizedDirectory = GLib.dir_make_tmp('wallpaper-suite-oversized-XXXXXX');
const oversizedPath = GLib.build_filenamev([oversizedDirectory, 'operations.json']);
GLib.file_set_contents(oversizedPath, 'x'.repeat(256 * 1024 + 1));
const oversized = new ControlService({statePath: oversizedPath});
assert(oversized.GetStatus()[1] === false,
    'an oversized ledger is rejected before JSON parsing on the Shell main loop');
try { GLib.unlink(oversizedPath); } catch (_) {}
try { GLib.rmdir(oversizedDirectory); } catch (_) {}

const invalidRecordDirectory = GLib.dir_make_tmp('wallpaper-suite-record-XXXXXX');
const invalidRecordPath = GLib.build_filenamev([invalidRecordDirectory, 'operations.json']);
GLib.file_set_contents(invalidRecordPath, JSON.stringify({
    version: 1,
    operations: [{
        id: 'invalid-timestamp',
        state: 'succeeded',
        ok: true,
        changed: true,
        published: true,
        code: 'published',
        message: '',
        source: 'cli',
        requestId: 'invalid-timestamp',
        startedAtMs: Number.MAX_SAFE_INTEGER + 1,
        finishedAtMs: 1,
    }],
}));
const invalidRecord = new ControlService({statePath: invalidRecordPath});
assert(invalidRecord.GetStatus()[1] === false,
    'unsafe ledger timestamps fail closed before D-Bus int64 marshalling');
try { GLib.unlink(invalidRecordPath); } catch (_) {}
try { GLib.rmdir(invalidRecordDirectory); } catch (_) {}

const durabilityDirectory = GLib.dir_make_tmp('wallpaper-suite-durability-XXXXXX');
const durabilityPath = GLib.build_filenamev([durabilityDirectory, 'operations.json']);
const durability = new ControlService({
    statePath: durabilityPath,
    onNext(_options, onDone) {
        onDone({
            ok: true,
            code: 'published',
            changed: true,
            published: true,
        });
        return true;
    },
});
let durabilityWrites = 0;
durability._persistLedger = () => ++durabilityWrites !== 2;
const durabilityId = durability.Next({
    source: optionString('cli'),
    'request-id': optionString('terminal-write-failure'),
});
const durabilityResult = durability.GetOperation(durabilityId);
assert(durabilityResult[1] === 'failed' && durabilityResult[2] === false &&
    durabilityResult[4] === true && durabilityResult[5] === 'partial',
'a failed terminal ledger write cannot be reported as durable success');
try { GLib.rmdir(durabilityDirectory); } catch (_) {}

// Exercise the real session-bus export, reply tuple, result signal, and lookup.
let replyId = '';
let signalId = '';
let busError = null;
let lookupComplete = false;
let queryStarted = false;
const loop = new GLib.MainLoop(null, false);

const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
    busError = new Error('timed out waiting for control service D-Bus round trip');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

function maybeQuery() {
    if (!replyId || !signalId || queryStarted)
        return;
    queryStarted = true;
    Gio.DBus.session.call(
        CONTROL_BUS_NAME,
        CONTROL_OBJECT_PATH,
        CONTROL_INTERFACE,
        'GetOperation',
        new GLib.Variant('(s)', [replyId]),
        new GLib.VariantType('(bsbbbssxx)'),
        Gio.DBusCallFlags.NONE,
        3000,
        null,
        (connection, result) => {
            try {
                const reply = connection.call_finish(result).deepUnpack();
                assert(reply[0] === true && reply[1] === 'succeeded' &&
                    reply[2] === true && reply[5] === 'published',
                'GetOperation returns the terminal result over D-Bus');
                lookupComplete = true;
            } catch (error) {
                busError = error;
            }
            loop.quit();
        }
    );
}

const subscriptionId = Gio.DBus.session.signal_subscribe(
    null,
    CONTROL_INTERFACE,
    'OperationFinished',
    CONTROL_OBJECT_PATH,
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => {
        const [id, ok, code] = parameters.deepUnpack();
        if (ok && code === 'published') {
            signalId = id;
            maybeQuery();
        }
    }
);

const exported = new ControlService({
    onNext(_options, onDone) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            onDone({ok: true, code: 'published', message: ''});
            return GLib.SOURCE_REMOVE;
        });
        return true;
    },
    onAvailabilityChanged(available) {
        if (!available)
            return;
        Gio.DBus.session.call(
            CONTROL_BUS_NAME,
            CONTROL_OBJECT_PATH,
            CONTROL_INTERFACE,
            'Next',
            new GLib.Variant('(a{sv})', [{
                source: optionString('cli'),
                'request-id': optionString('dbus-roundtrip'),
                'reset-timer': optionBoolean(true),
            }]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            3000,
            null,
            (connection, result) => {
                try {
                    [replyId] = connection.call_finish(result).deepUnpack();
                    maybeQuery();
                } catch (error) {
                    busError = error;
                    loop.quit();
                }
            }
        );
    },
});

exported.start();
loop.run();
if (GLib.MainContext.default().find_source_by_id(timeoutId))
    GLib.Source.remove(timeoutId);
Gio.DBus.session.signal_unsubscribe(subscriptionId);
exported.stop();

if (busError)
    throw busError;
assert(replyId === signalId && lookupComplete,
    'the D-Bus reply, completion signal, and retained lookup share one id');

print('control service tests passed');
