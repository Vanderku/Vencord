# AppleMusicControls for Vencord

AppleMusicControls adds a compact Apple Music player above Discord's account panel. Version 1.2.0 introduces desktop backends for Windows, macOS and Linux while keeping one shared Discord UI.

## Platform support

| Platform | Apple Music source | Playback controls | Seek | Shuffle / Repeat | Favorite |
| --- | --- | --- | --- | --- | --- |
| Windows | Apple Music for Windows via GSMTC | Yes | Yes, when exposed | Yes, when exposed | Best effort via Windows UI Automation |
| macOS | Music.app via AppleScript | Yes | Yes | Yes | Yes, when Music.app exposes the property |
| Linux | MPRIS via `playerctl` or `gdbus` | Yes | Yes, when exposed | Yes, when exposed | Not available through standard MPRIS |
| Vencord Web | Not supported by this plugin | No | No | No | No |

The plugin folder uses the `.desktop` target suffix so Vencord excludes it from web builds. Vencord itself supports Windows, Linux, macOS and browser installations, but this plugin needs native desktop access to the system media player.

## Features

- Compact account-panel player inspired by Vencord's SpotifyControls placement
- Album artwork with local media-session artwork first and Apple artwork fallback
- Song, artist and album metadata
- Full-width draggable seek bar with live elapsed and total time
- Play / pause
- Previous / next
- Shuffle
- Repeat Off, Repeat All and Repeat One
- Right-click Repeat menu for direct mode selection
- Favorite / Unfavorite where the active platform backend can expose it
- Stop, rewind, fast forward and playback rate when the active backend exposes them
- Optional Discord Listening activity
- Optional Apple Music link and high-resolution artwork lookup
- Context menu for opening Apple Music, copying metadata and viewing artwork
- Optional hover-only playback controls
- Hides after five minutes while paused

## Windows backend

Windows uses `GlobalSystemMediaTransportControlsSession` (GSMTC) for media metadata, timeline state and standard controls. Apple Music decides which GSMTC capabilities are available for the active session.

The plugin uses the exact thumbnail exposed by the Apple Music media session before falling back to Apple Search. It retries around track changes because metadata and artwork can become available at slightly different times.

GSMTC does not define an Apple Music Favorite command. The Favorite heart therefore uses local Windows UI Automation as a best-effort bridge to Apple Music's own Favorite control. It does not send global keyboard shortcuts and does not require Apple Account credentials.

## macOS backend

macOS uses the system `Music.app` scripting interface through `osascript` and AppleScript. It reads the current track, player position, shuffle and repeat state, and controls playback directly in Music.app.

Favorite / Unfavorite uses the track's `favorited` scripting property when available. Some streamed tracks or future Music.app versions may not expose a mutable favorite property, in which case the heart is hidden.

On newer macOS releases where Music.app AppleScript metadata can occasionally fail, AppleMusicControls can use `nowplaying-cli` as an optional metadata and transport fallback if it is installed. It is not required. `nowplaying-cli` uses private macOS frameworks, so it should be treated only as a compatibility fallback.

Optional fallback install:

```bash
brew install nowplaying-cli
```

## Linux backend

Apple does not provide a native Apple Music Linux desktop application, so AppleMusicControls uses the Linux MPRIS media-control standard.

The backend supports:

- Cider and other Apple Music clients that expose an Apple Music MPRIS session
- Apple Music Web in browsers when the browser exposes a recognizable Apple Music MPRIS media session
- `playerctl` when installed
- GLib `gdbus` as a fallback when `playerctl` is not installed

For browser sessions the plugin intentionally refuses unrelated browser media. It accepts a browser MPRIS session only when its metadata identifies Apple Music, for example through a `music.apple.com` URL or Apple `mzstatic.com` artwork.

Standard MPRIS has no Apple Music Favorite operation, so Favorite is hidden on Linux. Playback, position, shuffle, repeat and rate controls are capability-aware.

Installing `playerctl` is recommended but not mandatory if `gdbus` is available. Example on Debian / Ubuntu:

```bash
sudo apt install playerctl
```

## Artwork and privacy

Local media-session artwork is preferred. When `onlineMetadata` is enabled, the plugin may send the current title, artist and album to Apple's public iTunes Search endpoint to resolve an Apple Music link and higher-resolution artwork. Disable `onlineMetadata` to disable that lookup.

No Apple Account password is required by this plugin.

## Installation

A Vencord source build is required for custom plugins.

### Windows

1. Extract this release.
2. Run `install.ps1` in PowerShell.
3. The installer preserves an existing development install under `src/plugins` when found. New custom installs use `src/userplugins`.
4. It runs `pnpm build` and `pnpm inject`.
5. Restart Discord completely.
6. Enable `AppleMusicControls` in Vencord Settings -> Plugins.

### macOS / Linux

1. Extract this release.
2. Run:

```bash
chmod +x install.sh
./install.sh
```

The script builds Vencord. Pass `--inject` if you use Discord Desktop and want the script to run Vencord's injector too:

```bash
./install.sh --inject
```

For Vesktop, build the custom Vencord source and configure Vesktop to use that build according to its custom Vencord workflow instead of patching Discord Desktop.

### Manual

Copy the `appleMusicControls.desktop` folder to:

```text
Vencord/src/userplugins/appleMusicControls.desktop
```

Then rebuild Vencord.

## Public release notes

- Plugin name: `AppleMusicControls`
- Author: Vanderku
- Discord user ID: `330445120761495567`
- License: GPL-3.0-or-later
- Desktop target: Windows, macOS, Linux
- Browser target: intentionally excluded

## License

GPL-3.0-or-later. See `NOTICE.md` for attribution notes.
