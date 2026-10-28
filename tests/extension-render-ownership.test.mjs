import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import {resolveAssignments, withIdentityAliases, withIdentityPins, topologyKey} from '../displayIdentity.js';
import {hasUnresolvedPins} from '../runtimeCore.js';

const root = process.argv[2] || path.resolve(import.meta.dirname, '..');

/**
 * Load the real extension class while replacing only its unavailable Shell/GI
 * imports. This keeps the ownership assertions tied to the production method
 * bodies instead of maintaining a second test-only implementation.
 */
function loadExtensionClass() {
    let source = readFileSync(path.join(root, 'extension.js'), 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    source = source.replace(
        'export default class WallpaperSuiteExtension extends Extension',
        'class WallpaperSuiteExtension extends Extension'
    );
    source += '\nglobalThis.__WallpaperSuiteExtension = WallpaperSuiteExtension;\n';

    class EmptyClass {}
    const context = vm.createContext({
        console,
        logError() {},
        GObject: {registerClass: value => value},
        GLib: {
            PRIORITY_DEFAULT: 0,
            PRIORITY_DEFAULT_IDLE: 0,
            SOURCE_REMOVE: false,
            Source: {remove() {}},
            timeout_add() { return 1; },
            idle_add() { return 2; },
        },
        Gio: {
            File: {
                new_for_path(filePath) {
                    return {get_uri: () => `file://${filePath}`};
                },
            },
        },
        St: {Icon: EmptyClass},
        Extension: EmptyClass,
        Main: {notify() {}, panel: {addToStatusArea() {}}},
        PanelMenu: {Button: EmptyClass},
        PopupMenu: {
            PopupMenuItem: EmptyClass,
            PopupSeparatorMenuItem: EmptyClass,
        },
        MonitorManager: EmptyClass,
        Compositor: EmptyClass,
        Scheduler: EmptyClass,
        resolveAssignments, withIdentityAliases, withIdentityPins, topologyKey,
        hasUnresolvedPins,
    });
    new vm.Script(source, {filename: path.join(root, 'extension.js')})
        .runInContext(context);
    return context.__WallpaperSuiteExtension;
}

function fingerprint(assignments) {
    return JSON.stringify(Object.entries(assignments).sort(([left], [right]) =>
        left.localeCompare(right)));
}

function monitorFingerprint(monitors) {
    return JSON.stringify([...(monitors || [])]
        .map(monitor => ({
            connector: `${monitor.connector || ''}`,
            x: Number(monitor.x),
            y: Number(monitor.y),
            width: Number(monitor.width),
            height: Number(monitor.height),
        }))
        .sort((left, right) => left.connector.localeCompare(right.connector)));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class ControlledCompositor {
    constructor() {
        this.generation = 0;
        this.active = null;
        this.cancelled = [];
        this.released = [];
    }

    compositeAsync(_monitors, _assignments, _modes, _quality, _options, onDone) {
        const generation = ++this.generation;
        const previous = this.active;
        this.active = {generation, onDone};

        // Compositor's real last-request-wins path increments its generation
        // before synchronously completing the superseded callback.
        if (previous) {
            previous.onDone({
                ok: false,
                code: 'superseded',
                message: 'A newer render replaced this request',
                generation: previous.generation,
                durationMs: 0,
            });
        }
        return generation;
    }

    complete(generation, result) {
        assert.equal(this.active?.generation, generation,
            'only the active render generation can complete');
        const active = this.active;
        this.active = null;
        active.onDone({
            ok: true,
            code: 'rendered',
            message: '',
            generation,
            path: `/cache/composite-${generation}.jpg`,
            durationMs: 1,
            cacheHit: false,
            ...result,
        });
    }

    cancel(generation) {
        if (this.active?.generation !== generation)
            return false;
        const active = this.active;
        this.active = null;
        this.cancelled.push(generation);
        active.onDone({
            ok: false,
            code: 'cancelled',
            message: 'Render was cancelled before publication',
            generation,
            durationMs: 0,
        });
        return true;
    }

    releaseObsolete(candidatePaths, protectedPaths) {
        this.released.push({
            candidatePaths: [...candidatePaths],
            protectedPaths: [...protectedPaths],
        });
    }
}

function makeHarness(ExtensionClass, {previousAssignments, selectedAssignments, token}) {
    const extension = new ExtensionClass();
    const compositor = new ControlledCompositor();
    const monitors = [{
        connector: 'only', x: 0, y: 0, width: 1920, height: 1080,
    }];
    const state = {
        'monitor-assignments': clone(previousAssignments),
        'monitor-modes': {only: 'zoom'},
    };
    const observations = {
        commits: [],
        discards: [],
        completions: [],
        publications: [],
        statusWrites: [],
        scheduledApplies: 0,
        scheduledOptions: [],
        invalidations: 0,
        deadlineResets: 0,
        selectionCalls: [],
    };
    let activeOutput = '/cache/previous.jpg';

    const request = {
        done: false,
        phase: 'apply',
        resetTimer: false,
        source: 'manual',
        previousAssignments: clone(previousAssignments),
        contextFingerprint: fingerprint(previousAssignments),
        assignments: clone(selectedAssignments),
        fingerprint: fingerprint(selectedAssignments),
        monitorFingerprint: monitorFingerprint(monitors),
        selectionGeneration: token,
        cursorCommitRequired: true,
        renderGeneration: 0,
        onDone: result => observations.completions.push(result),
    };

    extension._lifecycleGeneration = 1;
    extension._settings = {
        get_boolean: () => false,
        get_int: () => 92,
        get_string: key => key === 'rotation-mode' ? 'sequential' : '',
    };
    extension._bgSettings = {};
    extension._ssSettings = {};
    extension._monitorMgr = {monitors};
    extension._compositor = compositor;
    extension._scheduler = {
        commitSelection(assignments, selectionGeneration) {
            observations.commits.push({assignments: clone(assignments), selectionGeneration});
            return true;
        },
        discardSelection(assignments, selectionGeneration) {
            observations.discards.push({assignments: clone(assignments), selectionGeneration});
            return true;
        },
        invalidatePool() { observations.invalidations++; },
        resetDeadline() { observations.deadlineResets++; },
        markRotationSuccess() {},
        cancelSelection() { return false; },
        pickNextAsync(monitors, currentAssignments, onDone) {
            const generation = 100 + observations.selectionCalls.length;
            observations.selectionCalls.push({
                monitors: clone(monitors),
                currentAssignments: clone(currentAssignments),
                onDone,
                generation,
            });
            return generation;
        },
    };
    extension._indicator = {_refresh() {}};
    extension._lastRenderResult = null;
    extension._lastNotifiedRenderCode = null;
    extension._shuffleRequests = new Set([request]);
    extension._pendingShuffleApply = request;
    extension._manualShuffleQueue = [];
    extension._manualDrainId = 0;
    extension._shuttingDown = false;
    extension._readDict = key => clone(state[key]);
    extension._writeDict = (key, value) => { state[key] = clone(value); };
    extension._activeWallpaperPaths = () => new Set([activeOutput]);
    extension._publishUri = uri => {
        observations.publications.push(uri);
        activeOutput = uri.slice('file://'.length);
        return true;
    };
    extension._writeRuntimeStatus = update => observations.statusWrites.push(update);
    extension._scheduleApply = options => {
        observations.scheduledApplies++;
        observations.scheduledOptions.push(options || {});
    };

    return {extension, compositor, observations, request, state};
}

const ExtensionClass = loadExtensionClass();
const previousAssignments = {only: '/library/previous.jpg'};
const selectedAssignments = {only: '/library/selected.jpg'};

// Render and publication failures are transactional: selected assignments
// never become durable unless the corresponding composite is published.
for (const failure of ['render', 'publication']) {
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: failure === 'render' ? 81 : 82,
    });
    if (failure === 'publication')
        harness.extension._publishUri = () => false;

    harness.extension.applyComposite();
    harness.compositor.complete(1, failure === 'render' ? {
        ok: false,
        code: 'decode-failed',
        message: 'synthetic decode failure',
        path: null,
    } : {});

    assert.deepEqual(harness.state['monitor-assignments'], previousAssignments,
        `${failure} failure restores the pre-selection assignments`);
    assert.equal(harness.observations.commits.length, 0,
        `${failure} failure never commits the tentative cursor`);
    assert.equal(harness.observations.discards.length, 1,
        `${failure} failure discards the tentative cursor once`);
    assert.equal(harness.observations.scheduledApplies, 0,
        `${failure} failure needs no durable-assignment rollback`);
    assert.equal(harness.observations.completions.length, 1,
        `${failure} failure completes the action exactly once`);
}

// Disable is also a transactional cancellation boundary. It restores the
// assignment that was actually published, not the uncommitted selection.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 85,
    });
    harness.extension.applyComposite();
    harness.extension._cancelShuffleRequests();

    assert.deepEqual(harness.state['monitor-assignments'], previousAssignments,
        'disable restores the last published assignment snapshot');
    assert.deepEqual(harness.compositor.cancelled, [1],
        'disable cancels the exact active render');
    assert.equal(harness.observations.discards.length, 1,
        'disable discards the tentative cursor once');
    assert.equal(harness.observations.completions.length, 1,
        'disable completes the logical request once');
    assert.equal(harness.observations.completions[0].code, 'cancelled',
        'disable exposes stable cancellation status');
}

// Explicit Next actions are serialized. B cannot select against A's tentative
// choice, a scheduled tick cannot displace A, and a failed B retains A's
// successfully published assignment.
{
    const newerAssignments = {only: '/library/newer-then-failed.jpg'};
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 86,
    });
    const replacementResults = [];
    harness.extension.applyComposite();
    harness.extension.shuffleNow({onDone: result => replacementResults.push(result)});
    assert.equal(harness.observations.selectionCalls.length, 0,
        'B waits in the manual FIFO while A owns publication');
    assert.equal(harness.extension.shuffleNow({source: 'scheduled'}), false,
        'a scheduled tick yields while an explicit action is active');
    assert.equal(harness.observations.selectionCalls.length, 0,
        'the yielded scheduled tick never starts selection');

    harness.compositor.complete(1);
    assert.deepEqual(harness.state['monitor-assignments'], selectedAssignments,
        'A becomes durable only after its composite is published');
    harness.extension._drainManualQueue();
    const selection = harness.observations.selectionCalls.at(-1);
    assert.deepEqual(selection.currentAssignments, selectedAssignments,
        'B selects from A\'s published state, never its tentative state');
    selection.onDone({
        ok: true,
        code: 'selected',
        changed: true,
        generation: selection.generation,
        assignments: newerAssignments,
    });
    assert.equal(harness.observations.scheduledOptions.at(-1).immediate, true,
        'a selected Next action requests prompt rendering');
    const replacement = harness.extension._pendingShuffleApply;
    assert.deepEqual(clone(replacement.previousAssignments), selectedAssignments,
        'B records A as its published rollback baseline');
    harness.extension.applyComposite();
    harness.compositor.complete(2, {
        ok: false,
        code: 'decode-failed',
        message: 'synthetic replacement failure',
        path: null,
    });
    assert.deepEqual(harness.state['monitor-assignments'], selectedAssignments,
        'failed B retains the last published assignment from A');
    assert.equal(replacementResults[0].code, 'decode-failed',
        'replacement failure completes with its actionable reason');
}

// When A fails, queued B starts from the prior durable assignment. A current-
// only library is then reported as a successful no-op rather than selecting the
// failed tentative value or corrupting sequential progress.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 89,
    });
    const queuedResults = [];
    harness.extension.applyComposite();
    harness.extension.shuffleNow({onDone: result => queuedResults.push(result)});
    harness.compositor.complete(1, {
        ok: false,
        code: 'decode-failed',
        message: 'synthetic first-action failure',
        path: null,
    });
    harness.extension._drainManualQueue();
    const selection = harness.observations.selectionCalls.at(-1);
    assert.deepEqual(selection.currentAssignments, previousAssignments,
        'queued B uses the durable state after A fails');
    selection.onDone({
        ok: true,
        code: 'no-alternative',
        changed: false,
        published: false,
        generation: selection.generation,
        assignments: previousAssignments,
    });
    assert.equal(queuedResults[0].code, 'no-alternative',
        'a current-only queued action completes as an accurate no-op');
    assert.deepEqual(harness.state['monitor-assignments'], previousAssignments,
        'the no-op leaves durable assignment state unchanged');
}

// A manual action arriving during an already-running scheduled render waits
// for that publication, then runs next. This avoids selecting against a timer
// action that can still change durable state during indexing.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 90,
    });
    harness.request.source = 'scheduled';
    const manualResults = [];
    harness.extension.applyComposite();
    harness.extension.shuffleNow({
        source: 'desktop-menu',
        onDone: result => manualResults.push(result),
    });
    assert.equal(harness.observations.selectionCalls.length, 0,
        'manual action queues behind an in-flight scheduled publication');
    harness.compositor.complete(1);
    harness.extension._drainManualQueue();
    const selection = harness.observations.selectionCalls.at(-1);
    assert.deepEqual(selection.currentAssignments, selectedAssignments,
        'queued manual action selects from the timer\'s published state');
    selection.onDone({
        ok: true,
        code: 'no-alternative',
        changed: false,
        generation: selection.generation,
        assignments: selectedAssignments,
    });
    assert.equal(manualResults[0].code, 'no-alternative',
        'the queued desktop action completes through the normal result contract');
}

// A successful manual no-op still honors reset-timer, preventing an enabled
// scheduled rotation from firing immediately after the explicit action.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 91,
    });
    harness.extension._shuffleRequests.clear();
    harness.extension._pendingShuffleApply = null;
    harness.extension._settings.get_boolean = key => key === 'rotation-enabled';
    const completions = [];
    harness.extension.shuffleNow({
        resetTimer: true,
        onDone: result => completions.push(result),
    });
    const selection = harness.observations.selectionCalls.at(-1);
    selection.onDone({
        ok: true,
        code: 'no-alternative',
        changed: false,
        generation: selection.generation,
        assignments: previousAssignments,
    });
    assert.equal(harness.observations.deadlineResets, 1,
        'manual no-op resets the enabled schedule exactly once');
    assert.equal(completions[0].timerReset, true,
        'the operation result reports the honored timer reset');
}

// Mode and quality changes do not invalidate the selected image, but they do
// invalidate rendered bytes. Ownership survives while a current render is
// scheduled; the stale output is never published.
for (const mutation of ['modes', 'quality']) {
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: mutation === 'modes' ? 87 : 88,
    });
    harness.extension.applyComposite();
    if (mutation === 'modes') {
        harness.state['monitor-modes'] = {only: 'fit'};
    } else {
        harness.extension._settings.get_int = key =>
            key === 'composite-quality' ? 80 : 0;
    }
    harness.compositor.complete(1);

    assert.equal(harness.observations.publications.length, 0,
        `${mutation} mutation blocks obsolete rendered bytes`);
    assert.equal(harness.observations.discards.length, 0,
        `${mutation} mutation retains the selected image token`);
    assert.equal(harness.request.done, false,
        `${mutation} mutation keeps logical ownership for the replacement render`);
    assert.equal(harness.extension._pendingShuffleApply, harness.request,
        `${mutation} mutation leaves the request claimable`);
    assert.equal(harness.observations.scheduledApplies, 1,
        `${mutation} mutation schedules one current-settings render`);
    assert.equal(harness.compositor.released.at(-1).candidatePaths[0],
        '/cache/composite-1.jpg',
    `${mutation} mutation releases only the unpublished stale output`);
}

// Configuration and topology are checked once more after rendering, directly
// before URI publication. A stale composite can never reach the desktop.
for (const mutation of ['assignments', 'monitors']) {
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: mutation === 'assignments' ? 83 : 84,
    });
    harness.extension.applyComposite();
    const userEdited = {only: '/library/user-edited-during-render.jpg'};
    if (mutation === 'assignments') {
        harness.state['monitor-assignments'] = clone(userEdited);
    } else {
        harness.extension._monitorMgr.monitors = [{
            connector: 'new-layout', x: 100, y: 0, width: 2560, height: 1440,
        }];
    }
    harness.compositor.complete(1);

    assert.equal(harness.observations.publications.length, 0,
        `${mutation} mutation blocks stale URI publication`);
    assert.equal(harness.observations.commits.length, 0,
        `${mutation} mutation cannot commit a stale cursor`);
    assert.equal(harness.observations.completions.length, 1,
        `${mutation} mutation completes the action once`);
    assert.equal(harness.observations.completions[0].code, 'stale-context',
        `${mutation} mutation reports stable stale-context status`);
    assert.deepEqual(
        harness.state['monitor-assignments'],
        mutation === 'assignments' ? userEdited : previousAssignments,
        `${mutation} mutation preserves the newest valid assignment owner`
    );
    assert.equal(harness.compositor.released.at(-1).candidatePaths[0],
        '/cache/composite-1.jpg',
    `${mutation} mutation releases only its unpublished rendered output`);
}

// A mode/quality/layout reapply of the same selected assignments transfers
// ownership to render B. Render A's stale callback must not consume the token.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 41,
    });

    harness.extension.applyComposite();
    assert.equal(harness.request.renderGeneration, 1, 'render A owns generation 1');

    harness.extension.applyComposite(true);
    assert.equal(harness.request.renderGeneration, 2, 'render B takes ownership');
    assert.equal(harness.request.done, false, 'render A stale callback leaves request live');
    assert.equal(harness.observations.discards.length, 0,
        'render A stale callback does not discard the sequential cursor');
    assert.equal(harness.observations.commits.length, 0,
        'render A stale callback cannot commit');
    assert.equal(harness.observations.publications.length, 0,
        'render A stale callback cannot publish');

    harness.compositor.complete(2);
    assert.equal(harness.observations.publications.length, 1,
        'successful render B publishes exactly once');
    assert.deepEqual(harness.observations.commits, [{
        assignments: selectedAssignments,
        selectionGeneration: 41,
    }], 'successful render B commits the original selection token exactly once');
    assert.equal(harness.observations.discards.length, 0,
        'successful ownership transfer never discards the token');
    assert.equal(harness.observations.completions.length, 1,
        'the logical shuffle request completes exactly once');
    assert.equal(harness.request.done, true, 'the request is terminal after render B');
    assert.equal(harness.extension._pendingShuffleApply, null,
        'the committed request releases pending ownership');
}

// Cursor diagnostics follow the mode used for selection, not a mode setting
// that may change while its render is in flight.
for (const scenario of [
    {requiredAtSelection: true, currentMode: 'random', expectsError: true},
    {requiredAtSelection: false, currentMode: 'sequential', expectsError: false},
]) {
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: scenario.requiredAtSelection ? 61 : 62,
    });
    harness.request.cursorCommitRequired = scenario.requiredAtSelection;
    harness.extension._settings.get_string = key =>
        key === 'rotation-mode' ? scenario.currentMode : '';
    harness.extension._scheduler.commitSelection = (assignments, selectionGeneration) => {
        harness.observations.commits.push({
            assignments: clone(assignments),
            selectionGeneration,
        });
        return false;
    };

    harness.extension.applyComposite();
    harness.compositor.complete(1);
    const lastStatus = harness.observations.statusWrites.at(-1);
    assert.equal(Boolean(lastStatus.lastSelectionError), scenario.expectsError,
        'cursor failure wording is bound to selection-time commit ownership');
}

// URI publication followed by assignment-store rejection is an explicit
// partial result. The cursor is discarded instead of advancing beyond the
// durable assignment baseline, and diagnostics preserve the state failure.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 63,
    });
    harness.extension._writeDict = () => false;
    harness.extension.applyComposite();
    harness.compositor.complete(1);

    assert.deepEqual(harness.state['monitor-assignments'], previousAssignments,
        'a rejected assignment write leaves the durable baseline intact');
    assert.equal(harness.observations.commits.length, 0,
        'a rejected assignment write cannot advance the sequential cursor');
    assert.equal(harness.observations.discards.length, 1,
        'the tentative cursor is discarded exactly once');
    assert.equal(harness.observations.completions[0].code, 'partial',
        'publication plus state rejection is reported as partial');
    assert.equal(harness.observations.completions[0].published, true,
        'the partial result accurately records that URI publication happened');
    assert.match(harness.observations.statusWrites.at(-1).lastSelectionError,
        /monitor assignments could not be saved/,
    'runtime diagnostics retain the assignment persistence failure');
}

// Async selections use compare-and-swap preconditions: an assignment edit or
// monitor-layout change made while indexing always wins over the stale result.
for (const mutation of ['assignments', 'monitors']) {
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: mutation === 'assignments' ? 64 : 65,
    });
    harness.extension._shuffleRequests.clear();
    harness.extension._pendingShuffleApply = null;
    const completions = [];
    harness.extension.shuffleNow({onDone: result => completions.push(result)});
    const selection = harness.observations.selectionCalls.at(-1);
    const liveAssignments = mutation === 'assignments'
        ? {only: '/library/user-edited.jpg'}
        : previousAssignments;
    if (mutation === 'assignments') {
        harness.state['monitor-assignments'] = clone(liveAssignments);
    } else {
        harness.extension._monitorMgr.monitors = [{
            connector: 'new-layout', x: 100, y: 0, width: 2560, height: 1440,
        }];
    }
    selection.onDone({
        ok: true,
        code: 'selected',
        generation: selection.generation,
        cursorCommitRequired: true,
        assignments: {only: '/library/stale-scan-choice.jpg'},
    });

    assert.equal(completions.length, 1, `${mutation} mutation completes once`);
    assert.equal(completions[0].code, 'stale-context',
        `${mutation} mutation rejects the stale scan result`);
    assert.deepEqual(harness.state['monitor-assignments'], liveAssignments,
        `${mutation} mutation is never overwritten by the stale selection`);
    assert.equal(harness.extension._pendingShuffleApply, null,
        `${mutation} mutation leaves no stale publication owner`);
    assert.equal(harness.observations.scheduledApplies, 0,
        `${mutation} mutation never schedules stale assignments`);
    assert.equal(harness.observations.discards.at(-1).selectionGeneration,
        selection.generation, `${mutation} mutation discards its tentative cursor`);
}

// A two-item sequence requested twice advances in FIFO order: A publishes
// before B even selects, B remains in-memory while rendering, and only B's
// successful URI publication makes its assignment durable.
{
    const newerAssignments = {only: '/library/newer.jpg'};
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 57,
    });

    harness.extension.applyComposite();
    assert.equal(harness.request.renderGeneration, 1,
        'new-selection scenario starts with render A active');
    assert.equal(harness.extension.shuffleNow(), true,
        'a second manual action is accepted into the FIFO');
    assert.equal(harness.observations.selectionCalls.length, 0,
        'the second action does not select while render A is active');
    harness.compositor.complete(1);
    harness.extension._drainManualQueue();
    const selection = harness.observations.selectionCalls.at(-1);
    assert.deepEqual(selection.currentAssignments, selectedAssignments,
        'the second action starts from A after A publishes');
    selection.onDone({
        ok: true,
        code: 'selected',
        generation: selection.generation,
        assignments: newerAssignments,
    });
    assert.deepEqual(harness.state['monitor-assignments'], selectedAssignments,
        'B remains tentative before its composite is published');
    assert.equal(harness.extension._pendingShuffleApply.done, false,
        'B owns the pending publication token');
    harness.extension.applyComposite();
    harness.compositor.complete(2);
    assert.deepEqual(harness.state['monitor-assignments'], newerAssignments,
        'B becomes durable only after its own publication');
    assert.equal(harness.observations.publications.length, 2,
        'A and B each publish exactly once in order');
    assert.equal(harness.observations.commits.length, 2,
        'each sequential selection token commits exactly once');
}

// A preflight failure caused by monitor removal retires the logical request
// and also stops its already-running worker instead of merely suppressing a
// later publication callback.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 69,
    });
    harness.extension.applyComposite();
    harness.extension._monitorMgr.monitors = [];
    harness.extension.applyComposite();

    assert.deepEqual(harness.compositor.cancelled, [1],
        'monitor-removal preflight cancels the exact active render');
    assert.equal(harness.observations.publications.length, 0,
        'preflight failure cannot publish the retired render');
    assert.equal(harness.observations.commits.length, 0,
        'preflight failure cannot commit its cursor');
    assert.equal(harness.observations.completions.length, 1,
        'preflight failure completes the logical request once');
    assert.equal(harness.observations.completions[0].code, 'no-monitors',
        'preflight failure preserves its actionable reason');
}

// A library-folder change while rendering is terminal. It cancels the worker,
// discards the tentative token, restores the pre-selection assignments, and
// prevents the cancelled result from reaching publication.
{
    const harness = makeHarness(ExtensionClass, {
        previousAssignments,
        selectedAssignments,
        token: 73,
    });

    harness.extension.applyComposite();
    assert.equal(harness.request.renderGeneration, 1,
        'folder-change scenario starts with an active render');

    harness.extension._onWallpaperFolderChanged();
    assert.deepEqual(harness.compositor.cancelled, [1],
        'folder change cancels the exact active render generation');
    assert.deepEqual(harness.observations.discards, [{
        assignments: selectedAssignments,
        selectionGeneration: 73,
    }], 'folder change discards the exact tentative sequential token once');
    assert.equal(harness.observations.commits.length, 0,
        'folder change cannot commit the cancelled selection');
    assert.equal(harness.observations.publications.length, 0,
        'folder change cannot publish the cancelled render');
    assert.deepEqual(harness.state['monitor-assignments'], previousAssignments,
        'folder change restores the pre-selection assignments');
    assert.equal(harness.observations.scheduledApplies, 0,
        'folder cancellation needs no durable-assignment rollback');
    assert.equal(harness.observations.invalidations, 1,
        'the old library index is invalidated after request cancellation');
    assert.equal(harness.observations.completions.length, 1,
        'the cancelled logical request completes exactly once');
    assert.equal(harness.request.done, true, 'folder cancellation is terminal');
    assert.equal(harness.extension._pendingShuffleApply, null,
        'folder cancellation releases pending ownership');
}

// Explicit Apply stages both image and mode until publication, and a failed
// decode never makes the preview durable.
for (const fail of [false, true]) {
    const h = makeHarness(ExtensionClass, {previousAssignments, selectedAssignments, token: 90});
    h.extension._shuffleRequests.clear();
    h.extension._pendingShuffleApply = null;
    const results = [];
    const accepted = h.extension.applyMonitor({monitor: 'only', image: '/library/preview.jpg', mode: 'fit',
        expectedImage: previousAssignments.only, expectedMode: 'zoom',
        topology: topologyKey(h.extension._monitorMgr.monitors), source: 'preferences',
        onDone: result => results.push(result)});
    assert.equal(accepted, true);
    assert.equal(h.observations.scheduledOptions.at(-1).immediate, true,
        'explicit Apply requests prompt rendering');
    assert.deepEqual(h.state['monitor-assignments'], previousAssignments, 'preview is not durable before render');
    assert.equal(h.state['monitor-modes'].only, 'zoom');
    h.extension.applyComposite();
    h.compositor.complete(1, fail ? {ok: false, code: 'decode-failed', message: 'Bad image'} : {});
    assert.equal(h.observations.publications.length, fail ? 0 : 1);
    assert.equal(h.state['monitor-assignments'].only, fail ? previousAssignments.only : '/library/preview.jpg');
    assert.equal(h.state['monitor-modes'].only, fail ? 'zoom' : 'fit');
    assert.equal(results.length, 1);
    assert.equal(results[0].published === true, !fail);
}

// A pin toggled while a rotation worker is active must prevent that stale
// selection from reaching the desktop.
{
    const h = makeHarness(ExtensionClass, {previousAssignments, selectedAssignments, token: 91});
    let pins = [];
    h.extension._settings.get_strv = () => pins;
    h.request.pinFingerprint = '[]';
    h.extension.applyComposite();
    pins = ['only'];
    h.compositor.complete(1);
    assert.equal(h.observations.publications.length, 0, 'new pin cancels stale rotation publication');
    assert.deepEqual(h.state['monitor-assignments'], previousAssignments);
    assert.equal(h.request.done, true);
}

// Apply checks the expected current selection before accepting a queued edit.
{
    const h = makeHarness(ExtensionClass, {previousAssignments, selectedAssignments, token: 92});
    h.extension._shuffleRequests.clear(); h.extension._pendingShuffleApply = null;
    let result;
    h.extension.applyMonitor({monitor: 'only', image: '/library/preview.jpg', mode: 'fit',
        expectedImage: '/library/stale.jpg', expectedMode: 'zoom',
        topology: topologyKey(h.extension._monitorMgr.monitors), onDone: value => { result = value; }});
    assert.equal(result.code, 'stale-context');
    assert.deepEqual(h.state['monitor-assignments'], previousAssignments);
    assert.equal(h.observations.publications.length, 0);
}

console.log('extension render ownership, explicit Apply and pin-change tests passed');
