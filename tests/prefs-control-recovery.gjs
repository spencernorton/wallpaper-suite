#!/usr/bin/gjs -m

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {ControlService} from '../controlService.js';

if (ARGV.length !== 2)
    throw new Error('Expected SOURCE_ROOT SCHEMA_EXTENSION_DIR');

const [sourceRoot, extensionDir] = ARGV;
const resource = Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource);

Gtk.init();
Adw.init();

const metadataFile = Gio.File.new_for_path(
    GLib.build_filenamev([sourceRoot, 'metadata.json']));
const [, metadataBytes] = metadataFile.load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
metadata.dir = Gio.File.new_for_path(extensionDir);
metadata.path = sourceRoot;

const moduleUri = Gio.File.new_for_path(
    GLib.build_filenamev([sourceRoot, 'prefs.js'])).get_uri();
const {default: Preferences} = await import(moduleUri);

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function option(value) {
    return new GLib.Variant('s', value);
}

function writePending(settings, requestId, operationId = '') {
    const value = {'request-id': requestId};
    if (operationId)
        value['operation-id'] = operationId;
    assert(settings.set_value(
        'control-pending-operation',
        new GLib.Variant('a{ss}', value)
    ), 'test pending state was saved');
}

let engineDispatches = 0;
let dbusNextCalls = 0;
let failure = null;
let timeoutId = 0;
let started = false;
const loop = new GLib.MainLoop(null, false);

const service = new ControlService({
    getStatus: () => ({active: true, rotationEnabled: false}),
    onNext(_options, onDone) {
        engineDispatches++;
        onDone({
            ok: true,
            changed: true,
            published: true,
            code: 'published',
            message: '',
        });
        return true;
    },
    onAvailabilityChanged(available) {
        if (available && !started) {
            started = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                runKnownOperationCase();
                return GLib.SOURCE_REMOVE;
            });
        }
    },
});

const knownRequestId = 'prefs-known-operation';
const knownOperationId = service.Next({
    source: option('preferences'),
    'request-id': option(knownRequestId),
});
const lostReplyRequestId = 'prefs-lost-next-reply';
service.Next({
    source: option('preferences'),
    'request-id': option(lostReplyRequestId),
});
assert(engineDispatches === 2, 'two distinct setup requests reached the engine');

const originalNext = service.Next.bind(service);
service.Next = options => {
    dbusNextCalls++;
    return originalNext(options);
};

function finish(error = null) {
    if (failure || !loop.is_running())
        return;
    failure = error;
    if (timeoutId && GLib.MainContext.default().find_source_by_id(timeoutId))
        GLib.Source.remove(timeoutId);
    timeoutId = 0;
    service.stop();
    loop.quit();
}

function waitForCleared(preferences, settings, onDone) {
    let attempts = 0;
    const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        try {
            const pending = settings.get_value(
                'control-pending-operation').deepUnpack();
            if (!preferences._controlActionActive &&
                Object.keys(pending).length === 0) {
                onDone();
                return GLib.SOURCE_REMOVE;
            }
            if (++attempts >= 200)
                throw new Error('Preferences recovery did not complete');
            return GLib.SOURCE_CONTINUE;
        } catch (error) {
            finish(error);
            return GLib.SOURCE_REMOVE;
        }
    });
    assert(pollId > 0, 'recovery poll source was created');
}

function openRecoveryCase(requestId, operationId, onDone) {
    const preferences = new Preferences(metadata);
    const settings = preferences.getSettings();
    writePending(settings, requestId, operationId);
    const window = new Adw.PreferencesWindow();
    preferences.fillPreferencesWindow(window);
    window.present();
    preferences._triggerNext();
    waitForCleared(preferences, settings, () => {
        window.close();
        onDone();
    });
}

function runKnownOperationCase() {
    const beforeNextCalls = dbusNextCalls;
    openRecoveryCase(knownRequestId, knownOperationId, () => {
        try {
            assert(dbusNextCalls === beforeNextCalls,
                'a retained operation ID is queried without replaying Next');
            assert(engineDispatches === 2,
                'known-operation recovery cannot dispatch another wallpaper action');
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                runLostReplyCase();
                return GLib.SOURCE_REMOVE;
            });
        } catch (error) {
            finish(error);
        }
    });
}

function runLostReplyCase() {
    const beforeNextCalls = dbusNextCalls;
    openRecoveryCase(lostReplyRequestId, '', () => {
        try {
            assert(dbusNextCalls === beforeNextCalls + 1,
                'a lost Next reply is recovered by replaying the same request identity');
            assert(engineDispatches === 2,
                'same-ID replay returns the retained result without a second action');
            finish();
        } catch (error) {
            finish(error);
        }
    });
}

timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
    finish(new Error('timed out waiting for the control service recovery test'));
    return GLib.SOURCE_REMOVE;
});
service.start();
loop.run();

if (failure)
    throw failure;
print('preferences control recovery tests passed');
