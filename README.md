# Q-CUBIC Remote

Control your home PC from your phone, from any network. Free.

Copyright (c) 2026 Pruthvi. All rights reserved.

## Download

Go to **Releases** (right side of this page) and download:

- **QCubicRemote-windows.zip** - for your PC. Unzip, then run `Q-CUBIC Remote.exe`.
- **q-cubic-remote-android.apk** - for your phone.

Or use the phone app in Chrome: https://saipruthvi356.github.io/q-cubic-remote/

## How it works

- The PC shows a permanent 9-digit PC ID and a one-time 6-digit pairing code.
- The phone pairs once, then connects with one tap from Wi-Fi or mobile data.
- The screen goes directly from the PC to the phone (WebRTC, encrypted).
- The two find each other through a free public message relay; every message is sealed with AES-256-GCM first.

## Folders

- `app/` - Windows PC app (Electron)
- `phone/` - phone app (web app, also packaged as the Android APK)
- `.github/workflows/build.yml` - builds the Windows zip, the APK and the phone web app on every change
