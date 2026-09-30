# Control adapters

Recipes for driving each surface from Pi. Use the repo's existing harness first. When it has none, pick the recipe for the surface here and copy the real commands, with this repo's names, into the generated skill.

Every recipe provides the same capabilities:

| Capability | What it means |
|---|---|
| Bring up | Start one instance for this run and wait for its readiness signal. |
| Inspect | Read state without changing it: accessibility tree, view hierarchy, API read-back, a read-only database query, logs. |
| Drive | Real user actions through stable handles. |
| Capture | Screenshot, snapshot, transcript, or response body into the evidence directory. Add video when the bug involves motion or timing. |
| Reset | Return the feature to a known state, so a second repro attempt is independent. |
| Cleanup | Stop what this run started. Keep the evidence. |

Arranging a precondition (fixture data, a permission grant, a feature flag) is allowed. Injecting the symptom is not: the symptom must come from real interaction.

## Every surface: isolation and cleanup

- **One instance per run.** Each run gets its own port, data directory, browser profile, tmux session, simulator, or emulator.
- **Never double-drive a shared instance.** If the app cannot run twice side by side (a fixed port, a single-instance lock, a shared database), the generated skill says so and refuses to drive any instance this run did not start.
- **Kill what you started.** Record each PID, process group, session name, and device ID when you create it, and clean up exactly those. Never `pkill`, `killall`, or kill whatever happens to hold a port.
- **Evidence lives outside scratch.** Cleanup deletes scratch wholesale; the evidence directory survives.
- **Wait for a state, not a clock.** Poll for the readiness signal with a bounded loop. A fixed sleep is either too short or wasted time.

### Run scaffold

Bash tool calls do not share shell variables. The first call writes a run file of exports, and every later call sources it, so helper scripts and child processes see the same values:

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
SCRATCH="${TMPDIR:-/tmp}/verify-notes-$RUN_ID"     # instances, profiles, data: deleted by cleanup
EVIDENCE="$PWD/.tstack/verify-notes/$RUN_ID"       # proof: survives cleanup
PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
mkdir -p "$SCRATCH" "$EVIDENCE"
printf 'export RUN_ID=%q SCRATCH=%q EVIDENCE=%q PORT=%q\n' "$RUN_ID" "$SCRATCH" "$EVIDENCE" "$PORT" > "$SCRATCH/run.env"
echo "$RUN_ID"
# Every later call starts with:
#   source "${TMPDIR:-/tmp}/verify-notes-<RUN_ID>/run.env"
```

Start a long-lived process in its own process group, so cleanup can stop it and every child it spawned:

```bash
( set -m; nohup env PORT="$PORT" NOTES_DATA_DIR="$SCRATCH/data" npm run dev -- --port "$PORT" \
    > "$SCRATCH/server.log" 2>&1 & echo $! >> "$SCRATCH/pids" )
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/" > /dev/null 2>&1 && break; sleep 1; done
```

Doctor: the process is alive and the port's listener belongs to our process group, not to a copy the user started:

```bash
listener="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)"
[ -n "$listener" ] && [ "$(ps -o pgid= -p "$listener" | tr -d ' ')" = "$(head -1 "$SCRATCH/pids")" ] \
  && echo "doctor: port $PORT is ours" || echo "doctor: port $PORT is NOT ours"
```

Add the app's own identity check: a version endpoint, `--version` output, or a build hash compared with `git rev-parse --short HEAD`.

Cleanup:

```bash
while read -r pgid; do kill -TERM -- "-$pgid" 2>/dev/null; done < "$SCRATCH/pids"
rm -rf "$SCRATCH"
ls -la "$EVIDENCE"    # the proof must still be here
```

## Web

### Playwright scripts

The primary path. A script in the verify skill's `scripts/` needs no harness support: any agent with a shell runs it the same way, and its output is the evidence. Install the library and a browser once: `npm i -D playwright` (or use the repo's `@playwright/test`), then `npx playwright install chromium`. A helper such as `.agents/skills/verify-notes/scripts/drive-create-note.mjs`:

```js
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const [url, evidence] = process.argv.slice(2);
const browser = await chromium.launch();                     // fresh profile every run
const context = await browser.newContext({ recordVideo: { dir: evidence } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
try {
  await page.goto(url);
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Release checklist');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.getByRole('status').filter({ hasText: 'Note saved' }).waitFor();
  await page.screenshot({ path: `${evidence}/saved.png`, fullPage: true });
  await writeFile(`${evidence}/saved.aria.txt`, await page.locator('body').ariaSnapshot());
} finally {
  await context.tracing.stop({ path: `${evidence}/trace.zip` });   // open with: npx playwright show-trace
  await context.close();
  await browser.close();
}
```

Run it with `node .agents/skills/verify-notes/scripts/drive-create-note.mjs "http://127.0.0.1:$PORT/" "$EVIDENCE/create-note"`.

- Locate by `getByRole(role, { name })`, then `getByLabel`, then `getByTestId` (the repo's test-id attribute). `getByText` is the last resort.
- Wait on a locator (`waitFor()`, or `expect(...).toBeVisible()` in a spec), never on a timer.
- The repo already has specs: run one against this run's instance, for example `npx playwright test e2e/notes.spec.ts --trace on --output "$EVIDENCE/playwright"`, passing the URL the way the repo's config reads it. For Cypress: `npx cypress run --spec cypress/e2e/notes.cy.ts --config "baseUrl=http://127.0.0.1:$PORT,screenshotsFolder=$EVIDENCE/cypress/screenshots,videosFolder=$EVIDENCE/cypress/videos,video=true"`.
- Flutter web renders to a canvas. Role locators find nothing until semantics are on: call `SemanticsBinding.instance.ensureSemantics()` in a debug entry point.

### Browser MCP servers (optional)

Use one only when the user has configured it. The user adds it to `~/.pi/agent/mcp.json`; the agent cannot (`allowInstall: false`), so give them the entry, for example `"playwright": {"command": "npx", "args": ["@playwright/mcp@latest", "--isolated", "--headless"]}` under `mcpServers`. Call its tools through the `mcp` proxy: `mcp({connect: "playwright"})`, `mcp({search: "snapshot"})` for the exact names (the proxy prefixes each tool with its server name), then `mcp({tool: "<name>", args: {...}})`. Tool names below omit that prefix.

- **Playwright MCP.** `--isolated` keeps the profile in memory. A persistent profile serves one browser at a time, so parallel runs need `--isolated` or a distinct `--user-data-dir`. For a signed-in run, `--storage-state <file>` loads cookies into the isolated context.
  - Inspect with `browser_snapshot`: the accessibility tree, with a ref for each element. Pass `filename` to save it as evidence.
  - Drive with `browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`, and `browser_press_key`. Each targets a ref from the latest snapshot. Take a new snapshot after every navigation.
  - Wait with `browser_wait_for` on `text` or `textGone`.
  - Capture with `browser_take_screenshot` (`filename`, `fullPage`), `browser_start_video` and `browser_stop_video`, `browser_console_messages`, and `browser_network_requests`.
  - Clean up with `browser_close`.
- **Chrome DevTools MCP.** The entry runs `npx -y chrome-devtools-mcp@latest --isolated --headless`. `take_snapshot` returns the accessibility tree with a `uid` per element; `click`, `fill`, `fill_form`, and `press_key` take that `uid`. It also has `wait_for`, `take_screenshot` (`filePath`), `list_console_messages`, `list_network_requests`, and `performance_start_trace` with `performance_stop_trace` for performance work. `--browserUrl http://127.0.0.1:<port>` attaches it to a Chrome or Electron instance started with a remote debugging port.

Snapshots name elements by role and accessible name. Drive by those, never by generated class names.

## Electron

- **Playwright's Electron support** launches the app and hands back a normal page:

  ```js
  import { _electron as electron } from 'playwright';

  const app = await electron.launch({ args: ['.'], env: { ...process.env, NOTES_DATA_DIR: process.env.SCRATCH + '/data' } });
  const window = await app.firstWindow();
  await window.getByRole('button', { name: 'New note' }).click();
  await window.screenshot({ path: `${process.env.EVIDENCE}/create-note/window.png` });
  await app.close();
  ```

- **CDP.** Start the app with `--remote-debugging-port=<port>` (for example `npx electron . --remote-debugging-port="$PORT"`). It is ready when `curl -fsS "http://127.0.0.1:$PORT/json/version"` answers. Attach with Playwright's `chromium.connectOverCDP("http://127.0.0.1:$PORT")` and use `browser.contexts()[0].pages()`, or point an MCP server at it (Chrome DevTools MCP `--browserUrl`, Playwright MCP `--cdp-endpoint`). An MCP server's endpoint is fixed when the server starts, so it pairs with a fixed debug port: one Electron instance at a time, and the skill says so.
- **Profile.** Give the run its own user data: the app's data-dir flag or env var, or an `app.setPath('userData', ...)` hook behind a test-only env var. Without one, an app that holds a single-instance lock refuses to start beside the user's copy, so the skill refuses to run while that copy is open.
- **Main process.** `--inspect=<port>` exposes the Node inspector for read-only inspection of main-process state.

## CLI

Plain Bash. Isolate config and data through the environment, and keep the command, stdout, stderr, and exit code:

```bash
mkdir -p "$EVIDENCE/create-cli"
cmd=(./bin/notes create --title "CLI note" --format json)
printf '%q ' "${cmd[@]}" > "$EVIDENCE/create-cli/cmd.txt"
env HOME="$SCRATCH/home" XDG_CONFIG_HOME="$SCRATCH/config" XDG_DATA_HOME="$SCRATCH/data" \
  "${cmd[@]}" > "$EVIDENCE/create-cli/stdout.txt" 2> "$EVIDENCE/create-cli/stderr.txt"
echo $? > "$EVIDENCE/create-cli/exit.txt"
```

- Add the app's own data-dir variable when it has one.
- Assert on machine-readable output (`--json`, `--format json`). Keep the human output in the transcript.
- Read the stored state back through a second command (`notes list --format json`) or a read-only look at the data directory.

## TUI

Drive the TUI in a tmux session only this run uses. Fix the terminal size so layouts reproduce:

```bash
S="verify-notes-$RUN_ID"
tmux new-session -d -s "$S" -x 120 -y 40 "env HOME=$SCRATCH/home ./bin/notes-tui"
wait_for() { for _ in $(seq 1 50); do tmux capture-pane -p -t "$S" | grep -qF -- "$1" && return 0; sleep 0.2; done; return 1; }
wait_for 'notes>'                                  # a prompt string, not a sleep
tmux send-keys -t "$S" -l 'add Release checklist'  # -l sends the text literally
tmux send-keys -t "$S" Enter
wait_for 'Note saved: Release checklist'
tmux capture-pane -p -t "$S" > "$EVIDENCE/create-tui/screen.txt"   # -e keeps colors
tmux kill-session -t "$S"                          # only the session this run created
```

- `capture-pane` trims trailing spaces. Match a prompt without its trailing space, or capture with `-N`.
- Named keys (`Enter`, `Escape`, `C-c`, `Up`) go without `-l`; typed text goes with `-l`.
- For a scripted PTY instead of tmux, use Python's `pexpect` (`spawn` with `dimensions=(40, 120)`, then `expect` and `sendline`) or `expect(1)`.

## HTTP and API services

Launch without auto-reload, so the PID you record is the server:

| Framework | Launch for verification |
|---|---|
| FastAPI | `uvicorn app.main:app --host 127.0.0.1 --port "$PORT"` (not `--reload`, not `fastapi dev`) |
| Django | `python manage.py migrate`, then `python manage.py runserver "127.0.0.1:$PORT" --noreload` |
| Flask | `flask --app app run --host 127.0.0.1 --port "$PORT" --no-reload` |
| Node | the repo's start script, with the port passed the way the app reads it |

- **Disposable data.** Point the app at a database only this run uses: a SQLite file in `$SCRATCH`, or a throwaway Postgres database (`createdb "notes_verify_$RUN_ID"`), passed through the app's own setting (often `DATABASE_URL`).
- **Readiness.** Poll a health route, or `/openapi.json` for FastAPI, until it answers.
- **Drive** with curl, and keep the request, status, and body:

  ```bash
  mkdir -p "$EVIDENCE/create"
  body='{"title": "Release checklist"}'
  printf '%s\n' "POST /notes $body" > "$EVIDENCE/create/request.txt"
  curl -sS -X POST "http://127.0.0.1:$PORT/notes" -H 'content-type: application/json' -d "$body" \
    -o "$EVIDENCE/create/response.json" -w '%{http_code}\n' > "$EVIDENCE/create/status.txt"
  ```

  For multi-step flows (sign in, then act), a helper script with `httpx.Client(base_url=...)` keeps the cookies and writes each exchange to the evidence directory.
- **Read back** through the API (a GET) and through a read-only view of storage:
  - SQLite: `sqlite3 -readonly "$SCRATCH/app.db" "select id, title from notes where title = 'Release checklist'"`
  - Postgres: `PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -c "select id, title from notes where title = 'Release checklist'"`
  - Django ORM: `python manage.py shell -c "from notes.models import Note; print(list(Note.objects.filter(title='Release checklist').values()))"`
- **Auth.** Create a disposable user through the app's own path: its signup endpoint, or `python manage.py createsuperuser --noinput` with the `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and `DJANGO_SUPERUSER_PASSWORD` env vars.
- **Background workers** (Celery, RQ, Dramatiq, arq). Start the worker for the run too, or report the side effect as not proven. Eager mode is not the production path.
- **Outbound mail and webhooks.** Capture them at the production boundary: Django's file-based email backend writing to the evidence directory, or a local receiver for webhooks.

## iOS (macOS with Xcode)

On any other OS, report the feature blocked with that prerequisite. Create a simulator only this run uses; pick a device type from `xcrun simctl list devicetypes`:

```bash
UDID="$(xcrun simctl create "verify-notes-$RUN_ID" "iPhone 16")"
echo "$UDID" > "$SCRATCH/udid"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID"                    # waits until boot finishes
xcodebuild -scheme Notes -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$SCRATCH/dd" build             # add -workspace or -project as the repo needs
xcrun simctl install "$UDID" "$SCRATCH/dd/Build/Products/Debug-iphonesimulator/Notes.app"
xcrun simctl launch "$UDID" com.example.notes
( set -m; nohup xcrun simctl spawn "$UDID" log stream --style compact \
    --predicate 'subsystem == "com.example.notes"' > "$EVIDENCE/app.log" 2>&1 & echo $! >> "$SCRATCH/pids" )
xcrun simctl io "$UDID" screenshot "$EVIDENCE/create-note/saved.png"
```

`xcrun simctl spawn booted log stream` works only while exactly one simulator is booted; use the UDID.

- **XCUITest** (when the repo has a UI test target): `xcodebuild test -scheme NotesUITests -destination "platform=iOS Simulator,id=$UDID" -only-testing:NotesUITests/CreateNoteTests/testSaveNote -resultBundlePath "$EVIDENCE/create-note.xcresult"`. Elements resolve by accessibility identifier (`app.buttons["save-note"]`), set with `accessibilityIdentifier` in UIKit or `.accessibilityIdentifier("save-note")` in SwiftUI. Xcode 16 and later export the bundle's screenshots with `xcrun xcresulttool export attachments --path <bundle> --output-path <dir>`.
- **Maestro** (no test target needed; also drives Android, Flutter, and React Native):

  ```yaml
  appId: com.example.notes
  ---
  - launchApp:
      clearState: true
  - tapOn:
      id: "new-note"
  - inputText: "Release checklist"
  - tapOn:
      id: "save-note"
  - assertVisible: "Note saved"
  - takeScreenshot: create-note-saved
  ```

  Run it from the evidence directory with `maestro --device "$UDID" test <flow file>`. `maestro --device "$UDID" hierarchy` prints the view tree when you need a handle.
- **Other controls.** Deep links: `xcrun simctl openurl "$UDID" notes://new`. Permission preconditions: `xcrun simctl privacy "$UDID" grant photos com.example.notes`. Video: `xcrun simctl io "$UDID" recordVideo "$EVIDENCE/run.mp4"`, stopped with SIGINT.
- **Read-back.** `xcrun simctl get_app_container "$UDID" com.example.notes data` prints the app's data directory. Copy files out and read the copies: `sqlite3` for databases, `plutil -p` for plists.
- **Cleanup.** `xcrun simctl terminate "$UDID" com.example.notes`, `xcrun simctl shutdown "$UDID"`, `xcrun simctl delete "$UDID"`. Delete only the simulator this run created.

## Android

Start an emulator only this run uses. `-read-only` lets several emulators share one AVD. The serial follows the console port, an even number from 5554 to 5682 that no running emulator uses:

```bash
EMU_PORT=5570; SERIAL="emulator-$EMU_PORT"          # check `adb devices` first
( set -m; nohup emulator -avd Pixel_8_API_35 -port "$EMU_PORT" -read-only -no-window -no-audio -no-boot-anim \
    > "$SCRATCH/emulator.log" 2>&1 & echo $! >> "$SCRATCH/pids" )
adb -s "$SERIAL" wait-for-device
for _ in $(seq 1 90); do [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break; sleep 2; done
./gradlew :app:assembleDebug
adb -s "$SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$SERIAL" shell am start -W -n com.example.notes/.MainActivity
adb -s "$SERIAL" exec-out screencap -p > "$EVIDENCE/create-note/saved.png"
adb -s "$SERIAL" shell uiautomator dump /sdcard/ui.xml && adb -s "$SERIAL" pull /sdcard/ui.xml "$EVIDENCE/create-note/ui.xml"
```

Pass `-s "$SERIAL"` on every adb call (or export `ANDROID_SERIAL`), so no command lands on the user's phone.

- **Maestro.** The same flow as iOS: `maestro --device "$SERIAL" test <flow file>`.
- **Instrumented tests** (Espresso, UI Automator, Compose): `ANDROID_SERIAL="$SERIAL" ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.example.notes.CreateNoteTest`.
- **Handles.** `resource-id` and `content-desc` in the dump. In Compose, set `Modifier.testTag("save-note")` and put `Modifier.semantics { testTagsAsResourceId = true }` on the root, so UI Automator and Maestro see tags as resource IDs.
- **Raw input**, only after a fresh dump or screenshot: `adb -s "$SERIAL" shell input tap <x> <y>`, and `input text 'Release%schecklist'` (`%s` is a space).
- **Logs.** Clear with `adb -s "$SERIAL" logcat -c` before the drive, then save `adb -s "$SERIAL" logcat -d --pid="$(adb -s "$SERIAL" shell pidof -s com.example.notes | tr -d '\r')"`.
- **Read-back** (debuggable builds): `adb -s "$SERIAL" exec-out run-as com.example.notes cat databases/notes.db > "$SCRATCH/notes.db"`, and the same for `notes.db-wal`, or the newest rows are missing. Query the copy with `sqlite3`. Preferences live in `shared_prefs/<name>.xml`.
- **Video.** `adb -s "$SERIAL" shell screenrecord --time-limit 30 /sdcard/run.mp4`, then `adb -s "$SERIAL" pull /sdcard/run.mp4 "$EVIDENCE/"`.
- **Cleanup.** `adb -s "$SERIAL" emu kill` stops only this emulator.

## Flutter

List targets with `flutter devices`, start a simulator or emulator with the recipes above, and pass its ID with `-d`.

- **integration_test.** A test in the repo's `integration_test/` drives the real app on the device:

  ```dart
  import 'package:flutter/material.dart';
  import 'package:flutter_test/flutter_test.dart';
  import 'package:integration_test/integration_test.dart';
  import 'package:notes/main.dart' as app;

  void main() {
    final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

    testWidgets('create-save', (tester) async {
      app.main();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-note')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('title-field')), 'Release checklist');
      await tester.tap(find.byKey(const ValueKey('save-note')));
      await tester.pumpAndSettle();
      expect(find.text('Note saved'), findsOneWidget);
      await binding.convertFlutterSurfaceToImage(); // Android only, before the first screenshot
      await binding.takeScreenshot('create-note-saved');
    });
  }
  ```

  `flutter test integration_test/create_note_test.dart -d "$DEVICE_ID"` runs it. Screenshots need the driver: `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/create_note_test.dart -d "$DEVICE_ID"`, with this driver writing into the evidence directory:

  ```dart
  import 'dart:io';
  import 'package:integration_test/integration_test_driver_extended.dart';

  Future<void> main() => integrationDriver(
        onScreenshot: (name, bytes, [args]) async {
          final dir = Platform.environment['EVIDENCE'] ?? 'build/evidence';
          final file = File('$dir/$name.png');
          await file.create(recursive: true);
          await file.writeAsBytes(bytes);
          return true;
        },
      );
  ```

- **Maestro.** `Semantics(identifier: 'save-note', ...)` exposes an ID to Maestro, XCUITest, and UI Automator, so the Maestro flow above drives a Flutter app unchanged.
- **Screenshot without a test.** `flutter screenshot -d "$DEVICE_ID" -o "$EVIDENCE/home.png"`.

## Library

A library has no running app: the surface is its public API, used the way a consumer uses it.

- **npm.** `npm pack --pack-destination "$SCRATCH"`, then in a scratch consumer project `npm init -y` and `npm install "$SCRATCH"/<package>-<version>.tgz`, and run a script that imports only public entry points.
- **Python.** `uv build --wheel --out-dir "$SCRATCH/dist"` (or `python -m build --wheel --outdir "$SCRATCH/dist"`), then install the wheel into a fresh virtualenv in `$SCRATCH` and run a script that imports the public API.

Keep the consumer script, its output, and its exit code as evidence.

## Native desktop (not Electron)

Use the platform's UI test framework: an XCUITest macOS target, Appium's Windows driver, or AT-SPI tooling on Linux. No computer-use tool exists in this setup: when none of these reaches the app, report the feature blocked with that prerequisite.
