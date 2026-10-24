# Rise One Man Show — Android app

Native Android app for https://riseonemanshow.com. It loads the web app in a
WebView, so the user logs in with the **same account as the browser** and all
customers, jobs, and trips live in the **one shared server database**. There
is no local app database for customers or jobs — the phone never holds
business data on its own.

On top of the WebView, a foreground location service keeps GPS trip miles
tracking when the phone is locked or the app is backgrounded.

## How the pieces fit

- `MainActivity` — WebView (JavaScript + DOM storage on) pointed at
  https://riseonemanshow.com. Navigation stays inside the app. The page's
  geolocation prompt is granted only after `ACCESS_FINE_LOCATION` is granted.
  Exposes a JavaScript interface named `RiseNative`:
  - `isNative()` → `true`
  - `startTrip(callId)` → called by the web side when a travel leg starts
  - `stopTrip()` → called by the web side when the job starts (travel ends)
- `TripTrackingService` — foreground service (`foregroundServiceType="location"`).
  Started by `startTrip(callId)`, stopped by `stopTrip()` or its notification's
  Stop action. Shows a persistent notification
  "Rise One Man Show — Tracking trip miles". Uses
  `FusedLocationProviderClient`, high accuracy, ~10s interval, ~10m minimum
  displacement. Fixes with accuracy worse than 50m (or no accuracy) are dropped.
- Position upload — every accepted fix is POSTed **immediately** to
  `https://riseonemanshow.com/app/native-positions` as JSON
  `{call_id, lat, lng, accuracy_m, recorded_at}`, with the WebView session
  cookies attached (read from `CookieManager`) so the request is authenticated
  as the logged-in user. On failure (offline) the fix stays queued in memory
  and is retried with the next successful post. A 404 (no open trip) stops
  the service. A failed post never crashes the app.
- Permissions — `ACCESS_FINE_LOCATION` is requested first. Before
  `ACCESS_BACKGROUND_LOCATION` is ever requested, the app shows a prominent
  disclosure dialog stating in plain words that location is used ONLY during
  an active trip to record trip miles, including when the app is in the
  background or the phone is locked, and that tracking stops when the trip
  ends. `POST_NOTIFICATIONS` is requested on Android 13+ (best effort; the
  tracking notification is exempt while the foreground service runs).

Manifest permissions: `INTERNET`, `ACCESS_NETWORK_STATE`,
`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`,
`ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.

App identity: package `com.riseonemanshow.app`, app name
"Rise One Man Show", minSdk 26, targetSdk 34, compileSdk 34. Launcher icon
reuses the web app's `icon-512.png` as an adaptive-icon foreground over a
dark background.

## Web-side contract (owned by the parent, not this project)

The web app must implement `POST /app/native-positions` (authenticated via
the session cookie) that accepts the JSON above, appends miles to the open
trip for `call_id`, and returns 404 when there is no open trip. The web UI
calls `RiseNative.startTrip(callId)` when travel starts and
`RiseNative.stopTrip()` when the job starts.

## Building (debug only)

Prerequisites: JDK 17 and the Android SDK (command-line tools +
`platforms;android-34` + `build-tools;34.0.0`).

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/Android
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
cd rise-android
./gradlew assembleDebug          # needs gradle/wrapper/gradle-wrapper.jar
# or, with a local Gradle 8.7 install:
gradle assembleDebug
# to generate the wrapper jar once Gradle is installed:
gradle wrapper --gradle-version 8.7
```

Artifacts:

- APK: `app/build/outputs/apk/debug/app-debug.apk`
- AAB: `gradle bundleDebug` → `app/build/outputs/bundle/debug/app-debug.aab`

No release keystore is created by this project. Release signing (upload key,
Play App Signing) is a later step owned by the user, before any Play
submission. For Play review, the store listing's privacy policy must disclose
background location use during trips, matching the in-app disclosure.

## Phone-test checklist

1. Install `app-debug.apk` on the phone (allow install from this source).
2. Open the app and log in with the **same account as the browser** — confirm
   the same companies, customers, and jobs appear.
3. Open a scheduled job and start a travel leg. Grant fine location, then
   accept the background-location disclosure and grant it.
4. Confirm the persistent "Tracking trip miles" notification appears.
5. Lock the phone, drive/move a known distance, then unlock.
6. Start the job (travel ends) and confirm the trip miles in the app match
   the browser view of the same job — same account, same server data.
7. Tap Stop on the notification mid-trip and confirm tracking ends.
8. With the phone offline during a trip, confirm fixes are retried and land
   once connectivity returns (no crash, no lost miles beyond the trip window).
