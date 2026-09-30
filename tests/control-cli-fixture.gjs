#!/usr/bin/gjs -m

import GLib from 'gi://GLib';

import {ControlService} from '../controlService.js';

const loop = new GLib.MainLoop(null, false);
const service = new ControlService({
    onNext(options, onDone) {
        if (!options.resetTimer || options.requestId === 'cli-hang')
            return true;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (options.requestId === 'cli-interrupted') {
                onDone({
                    ok: false,
                    code: 'interrupted',
                    message: 'fixture recovered an uncertain operation',
                    changed: false,
                    published: false,
                });
            } else if (options.requestId === 'cli-failure') {
                onDone({
                    ok: false,
                    code: 'render-failed',
                    message: 'fixture render failure',
                });
            } else {
                onDone({
                    ok: true,
                    code: 'published',
                    message: '',
                    changed: true,
                    published: true,
                });
            }
            return GLib.SOURCE_REMOVE;
        });
        return true;
    },
    getStatus: () => ({active: true, rotationEnabled: false}),
});

service.start();
loop.run();
service.stop();
