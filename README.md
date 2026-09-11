# Charger — Study & Productivity OS

A 100% offline study & productivity PWA: dashboard, tasks (MIT + Eisenhower
matrix), spaced-repetition flashcards (SM-2), a Pomodoro timer, habit
tracking, synthesized ambient sound (rain / forest / ocean / white noise —
generated in-browser, no audio files), local reminders, analytics
(heatmap + charts), and JSON backup/restore. All data is stored in
`localStorage` on the device — nothing is sent anywhere.

## Preview it locally
You need a local static server (opening `index.html` directly with
`file://` will block the service worker and manifest).

```bash
cd charger
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

On your phone, open that same URL in Chrome and use **"Add to Home
Screen"** to install it as an app.

## Turning it into an installable Android APK
This is a standard PWA, so you don't need Android Studio. Two easy options:

**Option A — PWABuilder (easiest, no install required)**
1. Host these files somewhere with HTTPS (GitHub Pages, Netlify, Vercel,
   Cloudflare Pages — all have free tiers and take under 5 minutes).
2. Go to https://www.pwabuilder.com, paste your URL, and click "Package
   for Stores" → Android.
3. Download the generated `.apk` (or `.aab` for the Play Store).

**Option B — Bubblewrap (command line)**
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest=https://yourdomain.com/manifest.json
bubblewrap build
```
This produces a signed APK using Google's Trusted Web Activity wrapper.

Either way, the app inside the APK is exactly these files — edit
`index.html` / `style.css` / `app.js` and re-deploy to update it.

## Honest limitation on reminders/alarms
Reminders and the daily digest fire while the app is open and running
(they check the time every 20 seconds). Like any installed PWA, they
won't wake up and fire while the app is fully closed and the phone is
idle — that requires either a push-notification server or a fully
native app. If you need guaranteed background alarms, the device's
built-in Clock app or a native alarm app is more reliable for that one
job; Charger's reminders are best for nudges while you're actively
using your phone/studying.

## File structure
```
index.html    — app shell + all views (Home, Tasks, Study, Pomodoro, Analytics, More)
style.css     — design system (dark + light themes)
app.js        — all logic: state, rendering, SM-2, timer, audio synthesis
manifest.json — PWA install metadata
sw.js         — offline cache (service worker)
icons/        — app icons (192, 512, maskable, apple-touch)
```
