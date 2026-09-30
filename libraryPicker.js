// Responsive wallpaper-library picker with bounded, cancellable thumbnail IO.

import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {LibraryIndexer} from './libraryIndex.js';
import {
    PAGE_SIZE,
    SORT_OPTIONS,
    TYPE_OPTIONS,
    pageForPath,
    pageSlice,
    prepareLibraryRecords,
} from './libraryModel.js';
import {
    ThumbnailLoader,
    indexedFileFingerprint,
    pruneThumbnailCache,
} from './thumbnailCache.js';

const TILE_W = 192;
const TILE_H = 108;
const THUMBNAIL_CONCURRENCY = 2;

export function openLibraryPicker(parent, libraryPath, currentPath, onPick) {
    if (!libraryPath || !GLib.file_test(libraryPath, GLib.FileTest.IS_DIR)) {
        _emptyDialog(parent, 'Library not set',
            'Pick a library folder in General → Wallpaper Library first.');
        return;
    }

    const win = new Adw.Window({
        transient_for: parent,
        modal: true,
        title: 'Pick wallpaper from library',
        default_width: 1080,
        default_height: 760,
    });
    let records = [];
    const state = {
        page: 0,
        query: '',
        sort: 'name-asc',
        kind: 'all',
        loader: null,
        generation: 0,
        searchTimer: 0,
        indexPulseTimer: 0,
        indexStartTimer: 0,
        indexing: true,
        terminal: false,
        closed: false,
        viewKey: '',
        viewRecords: [],
        indexer: new LibraryIndexer(_moduleDirectory(), {
            probeDimensions: false,
        }),
    };

    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const header = new Adw.HeaderBar();
    const titleWidget = new Adw.WindowTitle({
        title: 'Wallpaper Library',
        subtitle: `Indexing ${GLib.path_get_basename(libraryPath)}…`,
    });
    header.set_title_widget(titleWidget);
    root.append(header);

    const search = new Gtk.SearchEntry({
        placeholder_text: 'Search names or folders',
        hexpand: true,
        margin_start: 18,
        margin_end: 18,
        margin_top: 12,
        tooltip_text: 'Filter the wallpaper library',
        sensitive: false,
    });
    root.append(search);

    const controls = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: false,
        min_children_per_line: 1,
        max_children_per_line: 3,
        column_spacing: 12,
        row_spacing: 8,
        margin_start: 18,
        margin_end: 18,
        margin_top: 10,
        margin_bottom: 6,
    });
    const typeDropDown = new Gtk.DropDown({
        model: _stringList(TYPE_OPTIONS.map(option => option.label)),
        tooltip_text: 'Filter by image format',
    });
    const sortDropDown = new Gtk.DropDown({
        model: _stringList(SORT_OPTIONS.map(option => option.label)),
        tooltip_text: 'Sort library',
    });
    const currentButton = new Gtk.Button({
        label: 'Current selection',
        tooltip_text: 'Jump to the currently assigned wallpaper',
    });
    typeDropDown.sensitive = false;
    sortDropDown.sensitive = false;
    currentButton.sensitive = false;
    controls.append(typeDropDown);
    controls.append(sortDropDown);
    controls.append(currentButton);
    root.append(controls);

    const statusBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_start: 18,
        margin_end: 18,
        margin_top: 4,
        margin_bottom: 6,
    });
    const statusLabel = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        wrap: true,
        max_width_chars: 72,
        css_classes: ['caption', 'dim-label'],
    });
    const progress = new Gtk.ProgressBar({
        width_request: 180,
        valign: Gtk.Align.CENTER,
        show_text: false,
        tooltip_text: 'Wallpaper library indexing progress',
    });
    const retryButton = new Gtk.Button({
        label: 'Retry',
        visible: false,
        tooltip_text: 'Scan the wallpaper library again',
    });
    statusBox.append(statusLabel);
    statusBox.append(progress);
    statusBox.append(retryButton);
    root.append(statusBox);
    statusLabel.label = 'Indexing wallpaper names and metadata in the background…';
    progress.fraction = 0;
    progress.visible = true;

    const scrolled = new Gtk.ScrolledWindow({
        hexpand: true,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    const flow = new Gtk.FlowBox({
        valign: Gtk.Align.START,
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        column_spacing: 12,
        row_spacing: 12,
        margin_start: 18,
        margin_end: 18,
        margin_top: 8,
        margin_bottom: 12,
        min_children_per_line: 1,
        max_children_per_line: 8,
    });
    scrolled.set_child(flow);
    root.append(scrolled);

    const pager = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.CENTER,
        spacing: 12,
        margin_top: 8,
        margin_bottom: 14,
    });
    const previousButton = new Gtk.Button({
        label: 'Previous',
        tooltip_text: 'Show the previous page',
    });
    const pageLabel = new Gtk.Label({width_chars: 18, xalign: 0.5});
    const nextButton = new Gtk.Button({
        label: 'Next',
        tooltip_text: 'Show the next page',
    });
    previousButton.sensitive = false;
    nextButton.sensitive = false;
    pager.append(previousButton);
    pager.append(pageLabel);
    pager.append(nextButton);
    root.append(pager);

    function preparedView() {
        const key = JSON.stringify([state.query, state.sort, state.kind]);
        if (key !== state.viewKey) {
            state.viewRecords = prepareLibraryRecords(records, state);
            state.viewKey = key;
        }
        return state.viewRecords;
    }

    function rebuild() {
        if (state.indexing || state.terminal || state.closed)
            return;
        const generation = ++state.generation;
        if (state.loader)
            state.loader.cancel();
        state.loader = null;
        _clearFlowBox(flow);

        const filtered = preparedView();
        const page = pageSlice(filtered, state.page, PAGE_SIZE);
        state.page = page.page;
        pageLabel.label = `Page ${page.page + 1} of ${page.totalPages}`;
        previousButton.sensitive = page.page > 0;
        nextButton.sensitive = page.page + 1 < page.totalPages;
        currentButton.sensitive = Boolean(currentPath) &&
            pageForPath(filtered, currentPath, PAGE_SIZE) >= 0;

        if (page.totalItems === 0) {
            statusLabel.label = 'No wallpapers match these filters.';
            progress.fraction = 0;
            progress.visible = false;
            return;
        }

        const workerPath = GLib.build_filenamev([_moduleDirectory(), 'thumbnail-worker.js']);
        const loader = new ThumbnailLoader(workerPath, {
            width: TILE_W,
            height: TILE_H,
            concurrency: THUMBNAIL_CONCURRENCY,
        });
        state.loader = loader;

        let finished = 0;
        let failed = 0;
        progress.visible = true;
        progress.fraction = 0;
        statusLabel.label = `Loading ${page.items.length} thumbnails…`;

        for (const record of page.items) {
            const tile = _buildTile(record.path, record.path === currentPath);
            tile.button.connect('clicked', () => {
                if (!tile.available) {
                    statusLabel.label = tile.errorMessage ||
                        `${GLib.path_get_basename(record.path)} is unavailable.`;
                    return;
                }
                onPick(record.path);
                win.close();
            });
            flow.append(tile.button);

            loader.enqueue(record.path, result => {
                if (generation !== state.generation)
                    return;
                finished++;
                if (result.error) {
                    failed++;
                    tile.showError(result.error);
                } else {
                    try {
                        const texture = Gdk.Texture.new_from_file(
                            Gio.File.new_for_path(result.outputPath));
                        tile.showTexture(texture);
                    } catch (error) {
                        failed++;
                        tile.showError(error);
                    }
                }
                progress.fraction = finished / page.items.length;
                if (finished < page.items.length) {
                    statusLabel.label = `Loaded ${finished} of ${page.items.length}`;
                } else if (failed > 0) {
                    statusLabel.label = `${page.totalItems} matching · ${failed} thumbnail${failed === 1 ? '' : 's'} unavailable`;
                } else {
                    statusLabel.label = `${page.totalItems} matching · thumbnails ready`;
                    progress.visible = false;
                }
            }, record.fingerprint);
        }
    }

    search.connect('search-changed', () => {
        if (state.searchTimer)
            GLib.Source.remove(state.searchTimer);
        state.searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            state.searchTimer = 0;
            state.query = search.text;
            state.page = 0;
            rebuild();
            return GLib.SOURCE_REMOVE;
        });
    });
    typeDropDown.connect('notify::selected', () => {
        state.kind = TYPE_OPTIONS[typeDropDown.selected].id;
        state.page = 0;
        rebuild();
    });
    sortDropDown.connect('notify::selected', () => {
        state.sort = SORT_OPTIONS[sortDropDown.selected].id;
        state.page = 0;
        rebuild();
    });
    previousButton.connect('clicked', () => {
        state.page--;
        rebuild();
        scrolled.vadjustment.value = 0;
    });
    nextButton.connect('clicked', () => {
        state.page++;
        rebuild();
        scrolled.vadjustment.value = 0;
    });
    currentButton.connect('clicked', () => {
        const filtered = preparedView();
        const targetPage = pageForPath(filtered, currentPath, PAGE_SIZE);
        if (targetPage >= 0) {
            state.page = targetPage;
            rebuild();
            scrolled.vadjustment.value = 0;
        }
    });

    win.connect('close-request', () => {
        state.closed = true;
        state.generation++;
        if (state.searchTimer)
            GLib.Source.remove(state.searchTimer);
        state.searchTimer = 0;
        if (state.indexPulseTimer)
            GLib.Source.remove(state.indexPulseTimer);
        state.indexPulseTimer = 0;
        if (state.indexStartTimer)
            GLib.Source.remove(state.indexStartTimer);
        state.indexStartTimer = 0;
        if (state.loader)
            state.loader.cancel();
        state.loader = null;
        state.indexer?.dispose();
        state.indexer = null;
        return false;
    });

    function setBusy(busy) {
        try {
            root.update_state([Gtk.AccessibleState.BUSY], [busy]);
        } catch (_) {}
    }

    function beginIndex() {
        if (state.closed || !state.indexer)
            return;
        state.indexing = true;
        state.terminal = false;
        state.page = 0;
        retryButton.visible = false;
        search.sensitive = false;
        typeDropDown.sensitive = false;
        sortDropDown.sensitive = false;
        currentButton.sensitive = false;
        previousButton.sensitive = false;
        nextButton.sensitive = false;
        titleWidget.subtitle = `Indexing ${GLib.path_get_basename(libraryPath)}…`;
        statusLabel.label = 'Indexing wallpaper names and metadata in the background…';
        progress.fraction = 0;
        progress.visible = true;
        setBusy(true);
        _clearFlowBox(flow);

        if (state.indexPulseTimer)
            GLib.Source.remove(state.indexPulseTimer);
        state.indexPulseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            progress.pulse();
            return GLib.SOURCE_CONTINUE;
        });

        state.indexer.scanAsync(libraryPath, {probeDimensions: false}, result => {
            if (state.closed)
                return;
            if (state.indexPulseTimer)
                GLib.Source.remove(state.indexPulseTimer);
            state.indexPulseTimer = 0;
            state.indexing = false;
            progress.visible = false;
            setBusy(false);

            if (!result.ok) {
                state.terminal = true;
                retryButton.label = 'Retry';
                retryButton.visible = true;
                titleWidget.subtitle = 'Index unavailable';
                statusLabel.label = `Library index failed: ${result.message || result.code}`;
                _showFlowMessage(flow, 'dialog-error-symbolic',
                    'The library could not be read. Your current wallpaper was not changed.');
                return;
            }

            records = result.files.map(_recordFromIndex);
            state.viewKey = '';
            state.viewRecords = [];
            const suffix = [];
            if (result.truncated)
                suffix.push('index limit reached');
            if (result.errors.length > 0) {
                suffix.push(
                    `${result.errors.length} recoverable error${result.errors.length === 1 ? '' : 's'}`);
            }
            titleWidget.subtitle = [
                `${records.length} image${records.length === 1 ? '' : 's'}`,
                GLib.path_get_basename(libraryPath),
                ...suffix,
            ].join(' · ');

            if (records.length === 0) {
                state.terminal = true;
                retryButton.label = 'Rescan';
                retryButton.visible = true;
                statusLabel.label = 'No supported images were found in this library.';
                _showFlowMessage(flow, 'image-missing-symbolic',
                    'Add images to this folder, then choose Rescan.');
                return;
            }

            search.sensitive = true;
            typeDropDown.sensitive = true;
            sortDropDown.sensitive = true;
            statusLabel.label = `${records.length} wallpapers indexed`;
            rebuild();
        });
    }

    retryButton.connect('clicked', () => beginIndex());
    setBusy(true);
    win.set_content(root);
    win.present();
    // Let GTK paint the modal before bounded cache maintenance. The scan
    // starts only after pruning, so no newly resolved cache hit can be deleted
    // between path calculation and texture loading.
    state.indexStartTimer = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        state.indexStartTimer = 0;
        if (!state.closed) {
            pruneThumbnailCache();
            beginIndex();
        }
        return GLib.SOURCE_REMOVE;
    });
    return win;
}

function _buildTile(path, isCurrent) {
    let available = false;
    let errorMessage = '';
    const button = new Gtk.Button({
        css_classes: isCurrent
            ? ['flat', 'wallpaper-tile', 'suggested-action']
            : ['flat', 'wallpaper-tile'],
        sensitive: false,
        tooltip_text: path,
    });
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const frame = new Gtk.Frame({css_classes: ['view']});
    const overlay = new Gtk.Overlay();
    const picture = new Gtk.Picture({
        width_request: TILE_W,
        height_request: TILE_H,
        can_shrink: false,
    });
    const spinner = new Gtk.Spinner({
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Loading thumbnail',
    });
    spinner.start();
    const errorIcon = new Gtk.Image({
        icon_name: 'image-missing-symbolic',
        pixel_size: 32,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        visible: false,
    });
    overlay.set_child(picture);
    overlay.add_overlay(spinner);
    overlay.add_overlay(errorIcon);
    frame.set_child(overlay);
    box.append(frame);

    const filename = new Gtk.Label({
        label: GLib.path_get_basename(path),
        ellipsize: 3,
        max_width_chars: 20,
        css_classes: isCurrent ? ['caption', 'accent'] : ['caption'],
        tooltip_text: path,
    });
    box.append(filename);
    const stateLabel = new Gtk.Label({
        label: isCurrent ? 'Current' : ' ',
        css_classes: isCurrent ? ['caption', 'accent'] : ['caption', 'dim-label'],
    });
    box.append(stateLabel);
    button.set_child(box);

    return {
        button,
        get available() { return available; },
        get errorMessage() { return errorMessage; },
        showTexture(texture) {
            available = true;
            errorMessage = '';
            picture.set_paintable(texture);
            spinner.stop();
            spinner.visible = false;
            errorIcon.visible = false;
            button.sensitive = true;
        },
        showError(error) {
            available = false;
            errorMessage = `${GLib.path_get_basename(path)} is unavailable: ${error.message || error}`;
            spinner.stop();
            spinner.visible = false;
            errorIcon.visible = true;
            stateLabel.label = 'Unavailable';
            stateLabel.css_classes = ['caption', 'error'];
            // Keep the failed tile keyboard-focusable. Activation explains
            // the failure in the modal status area but never selects it.
            button.sensitive = true;
            button.tooltip_text = `${path}\n${error.message || error}`;
            try {
                button.update_property(
                    [Gtk.AccessibleProperty.DESCRIPTION],
                    [errorMessage]
                );
            } catch (_) {}
        },
    };
}

function _recordFromIndex(record) {
    return {
        path: record.path,
        name: record.name || GLib.path_get_basename(record.path),
        modifiedUsec: Number(record.mtimeSec || 0) * 1e6 +
            Number(record.mtimeUsec || 0),
        fingerprint: indexedFileFingerprint(record),
    };
}

function _showFlowMessage(flow, iconName, message) {
    _clearFlowBox(flow);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        margin_top: 72,
    });
    box.append(new Gtk.Image({icon_name: iconName, pixel_size: 48}));
    box.append(new Gtk.Label({
        label: message,
        wrap: true,
        max_width_chars: 48,
        justify: Gtk.Justification.CENTER,
        css_classes: ['dim-label'],
    }));
    flow.append(box);
}

function _clearFlowBox(flow) {
    let child = flow.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        flow.remove(child);
        child = next;
    }
}

function _moduleDirectory() {
    return Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
}

function _stringList(items) {
    const list = new Gtk.StringList();
    for (const item of items)
        list.append(item);
    return list;
}

function _emptyDialog(parent, heading, body) {
    const dialog = new Adw.AlertDialog({heading, body});
    dialog.add_response('ok', 'OK');
    dialog.set_default_response('ok');
    dialog.present(parent);
}
