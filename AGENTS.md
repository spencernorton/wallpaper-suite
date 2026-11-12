# Wallpaper Suite

Preserve the installed extension UUID, schema and runtime control interface.
Keep full image decoding in the existing subprocess workers, outside Shell and
Settings. The standalone manager reuses domain helpers and delegates wallpaper
publication to the extension. Advertise only implemented, qualified capabilities.

Run the relevant core, GJS and isolated integration suites before release.
Use disposable session buses and configuration directories for tests. Never
install an experimental extension or modify an active desktop as a test.

Run `bash tests/test-settings-manager.sh` for standalone manager changes and the
relevant core, worker and packaging suites. Keep public source and documentation
free of private deployment identifiers. Public commits use the repository's
normal signed-off contributor identity and concise prose.
