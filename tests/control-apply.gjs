import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {ControlService} from '../controlService.js';
const assert = (v, message) => { if (!v) throw new Error(message); };
const dir = GLib.dir_make_tmp('wallpaper-apply-ledger-XXXXXX');
const statePath = GLib.build_filenamev([dir, 'operations.json']);
let dispatched = 0, finish;
const options = {source: 'preferences', 'request-id': 'explicit-apply', monitor: '1920x1080+0+0',
    image: '/images/new.png', mode: 'fit', 'expected-image': '/images/old.png',
    'expected-mode': 'zoom', topology: '[["1920x1080+0+0",""]]'};
try {
    const service = new ControlService({statePath, onApply(value, onDone) {
        dispatched++; finish = onDone;
        assert(value.expectedImage === '/images/old.png' && value.mode === 'fit', 'Apply arguments survive normalization');
        return true;
    }});
    const id = service.Apply(options);
    assert(service.GetOperation(id)[1] === 'running', 'Apply is nonblocking and queryable');
    assert(service.Apply({...options}) === id && dispatched === 1, 'duplicate Apply never dispatches twice');
    const invalid = service.Apply({...options, 'request-id': 'invalid-mode', mode: 'wrong'});
    assert(service.GetOperation(invalid)[5] === 'invalid-options' && dispatched === 1, 'invalid mode cannot reach renderer');
    const invalidPath = service.Apply({...options, 'request-id': 'relative-path', image: 'relative.png'});
    assert(service.GetOperation(invalidPath)[5] === 'invalid-options', 'relative source is rejected');
    finish({ok: true, changed: true, published: true, code: 'published'});
    assert(service.GetOperation(id)[4] === true, 'successful publication is retained');
    service.stop();
    const restarted = new ControlService({statePath, onApply() { dispatched++; return true; }});
    assert(restarted.Apply(options) === id && dispatched === 1, 'reopen/restart replays the same Apply result');
    assert(restarted.GetOperation(id)[4] === true, 'durable result survives restart');
    restarted.stop();
    print('Apply validation, durable publication and restart/idempotency tests passed');
} finally {
    Gio.Subprocess.new(['rm', '-rf', '--', dir], Gio.SubprocessFlags.NONE).wait_check(null);
}
