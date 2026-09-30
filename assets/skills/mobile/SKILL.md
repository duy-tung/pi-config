---
name: mobile
description: "Swift, Kotlin and Dart type discipline and review checks: exhaustive sum types, decoding at the boundary, main thread and lifecycle, device proof. Use when writing or reviewing iOS, Android or Flutter code."
---

# Mobile

The type checker is a proof assistant on every platform. Model variants as sum types and match them exhaustively, parse external data once where it enters, brand identifiers, and never lie to the compiler. This is P4 (parse at the system boundary) from the `principles` skill, in Swift, Kotlin, and Dart. Then prove user-facing changes on a simulator or emulator, not with a unit test alone.

Every snippet below compiles (Swift 6.2, Kotlin 2.4 with kotlinx.serialization 1.11, Dart 3.13), and deleting one variant's branch fails the build.

## Swift

| Rule | Summary |
|---|---|
| Enums with associated values | One case per state, carrying only that state's data. No optional-field bags (`isLoading` next to `error: String?` next to `diff: Diff?`). |
| Exhaustive switch | Switch over your own enums with no `default`, so a new case fails the build at every switch. `@unknown default` is only for enums you don't own, such as SDK enums. |
| Decode at the boundary | Decode JSON into `Decodable` types with `JSONDecoder`, then map to domain types in one place. For a payload with a discriminator, write `init(from:)` that switches on the `kind` key and throws on an unknown kind. |
| Brands | A single-field struct (`struct NoteID: Hashable { let rawValue: String }`), constructed only after validation. |
| No lies | No `!`, `as!`, or `try!` outside tests: bind with `guard let`, `as?`, or `do`/`catch`, or change the type so the fact is carried. |

```swift
enum DiffState {
    case loading
    case ready(diff: String)
    case failed(message: String)
}

func label(_ state: DiffState) -> String {
    switch state {
    case .loading: return "Loading"
    case .ready(let diff): return diff
    case .failed(let message): return "Failed: \(message)"
    }
}

struct NoteID: Hashable {
    let rawValue: String
}

enum NoteEvent: Decodable {
    case created(title: String)
    case deleted(id: NoteID)

    private enum CodingKeys: String, CodingKey { case kind, title, id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "created": self = .created(title: try c.decode(String.self, forKey: .title))
        case "deleted": self = .deleted(id: NoteID(rawValue: try c.decode(String.self, forKey: .id)))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(kind)")
        }
    }
}
```

## Kotlin

| Rule | Summary |
|---|---|
| Sealed interfaces | A `sealed interface` with `data object` and `data class` variants. |
| Exhaustive `when` | `when` over a sealed type with no `else`, so a new subtype fails compilation. |
| Decode at the boundary | kotlinx.serialization at the edge, with `@SerialName` per variant and `Json { ignoreUnknownKeys = true; classDiscriminator = "kind" }` for forward-compatible payloads. With Moshi, use its Kotlin codegen adapters. Gson ignores Kotlin nullability: a missing field becomes `null` inside a non-null property. |
| Brands | `@JvmInline value class NoteId(val value: String)`: no runtime cost, and it serializes as a plain string. |
| No lies | No `!!` or unsafe `as` casts outside tests: use `?.`, `as?`, or `requireNotNull(x) { "reason" }` at the boundary, or change the type so the fact is carried. |

```kotlin
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
@JvmInline
value class NoteId(val value: String)

@Serializable
data class Note(val id: NoteId, val title: String)

@Serializable
sealed interface Event {
    @Serializable @SerialName("created") data class Created(val note: Note) : Event
    @Serializable @SerialName("deleted") data class Deleted(val id: NoteId) : Event
}

val wire = Json { ignoreUnknownKeys = true; classDiscriminator = "kind" }

fun parseEvent(body: String): Event = wire.decodeFromString<Event>(body)  // throws SerializationException

fun describe(event: Event): String = when (event) {
    is Event.Created -> "created ${event.note.title}"
    is Event.Deleted -> "deleted ${event.id.value}"
}
```

## Dart

| Rule | Summary |
|---|---|
| Sealed classes | A `sealed class` with `final class` variants. |
| Exhaustive switch | A switch expression over a sealed type with no wildcard arm: a missing variant is a `non_exhaustive_switch_expression` error. |
| Decode at the boundary | `jsonDecode` returns `dynamic`: parse it immediately. Dart 3 map patterns check keys and types in one step. Keep `json_serializable` or `freezed` when the repo uses them. |
| Brands | `extension type NoteId(String value) {}`: no runtime cost, checked at compile time only. |
| No lies | No `!` or `as` on data you haven't checked, and no `dynamic` past the parse. |

```dart
sealed class DiffState {}

final class Loading extends DiffState {}

final class Ready extends DiffState {
  Ready(this.diff);
  final String diff;
}

final class Failed extends DiffState {
  Failed(this.message);
  final String message;
}

String label(DiffState state) => switch (state) {
      Loading() => 'Loading',
      Ready(:final diff) => diff,
      Failed(:final message) => 'Failed: $message',
    };

extension type const NoteId(String value) {}

final class Note {
  const Note(this.id, this.title);
  final NoteId id;
  final String title;
}

Note parseNote(Object? json) => switch (json) {
      {'id': String id, 'title': String title} => Note(NoteId(id), title),
      _ => throw FormatException('Invalid note: $json'),
    };
```

## Review checks: main thread and lifecycle

Check these in every review. Types don't catch them.

**iOS**

- UI state mutated off the main actor. Mark view models `@MainActor`. Under Swift 6 strict concurrency a data race is a compile error; silencing it with `@unchecked Sendable` or `nonisolated(unsafe)` needs a stated reason.
- Work started with `Task { }` in `onAppear` outlives the view. Use the `.task { }` modifier, which cancels when the view disappears.
- An escaping closure stored on `self` that captures `self` strongly: a retain cycle. Capture `[weak self]`.
- `@ObservedObject` on an object the view creates is recreated whenever the parent rebuilds the view. An owned object is `@StateObject`, or `@State` holding an `@Observable` model (iOS 17 and later).
- State left unsaved when the scene phase becomes `.background`. The system can terminate a background app without another callback.
- Blocking I/O on the main thread, and `DispatchQueue.main.sync` called from the main thread (a deadlock).

**Android**

- Network or disk I/O on the main thread. Move it into `withContext(Dispatchers.IO)`. `StrictMode` in debug builds catches the rest.
- Flows collected without lifecycle awareness keep running in the background. Use `repeatOnLifecycle(Lifecycle.State.STARTED)`, or `collectAsStateWithLifecycle()` in Compose.
- State lost on rotation or process death. Keep it in a `ViewModel` with `SavedStateHandle`, and use `rememberSaveable` in Compose.
- `GlobalScope` launches, and Activity or View references held in singletons, leak. Use `viewModelScope` or `lifecycleScope`.
- Side effects in a composable's body. Put them in `LaunchedEffect` or `DisposableEffect` with the right keys.

**Flutter**

- `BuildContext` used after an `await` without checking `context.mounted` (the `use_build_context_synchronously` lint).
- Controllers and subscriptions (`TextEditingController`, `AnimationController`, `StreamSubscription`) not disposed in `dispose`.
- A future created inside `build` (`FutureBuilder(future: fetchNotes())`) refetches on every rebuild. Create it once, in `initState`.
- Heavy computation on the UI isolate. Move it to `Isolate.run`.
- State left unsaved when the app is paused. Save it on `AppLifecycleState.paused` through an `AppLifecycleListener`.

**Build files.** A dependency change updates its lockfile (`Podfile.lock`, `pubspec.lock`, Gradle lockfiles): commit them together. Raising `minSdk` or the iOS deployment target drops users on older devices: say so in the PR.

## Prove it on a device

Unit tests and previews don't prove a user-facing change. Prove it on a simulator or emulator through the repo's verify skill (`.agents/skills/verify-<app>/`): load the `prove` skill to run it and return a verdict. If the repo has no verify skill, tell the user to run `/skill:create-verify`. For a one-off drive, use the iOS, Android, or Flutter recipe in [CONTROL-ADAPTERS.md](../create-verify/CONTROL-ADAPTERS.md).
