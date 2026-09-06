/*
 * AppleMusicControls for Vencord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { readFile } from "fs/promises";
import { extname } from "path";
import { fileURLToPath } from "url";
import type { IpcMainInvokeEvent } from "electron";

import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";

import type { ControlAction, RepeatMode, TrackData } from ".";

interface RawTrackData {
    name: string;
    artist: string;
    album: string;
    playing: boolean;
    position: number;
    duration: number;
    startTime: number;
    shuffle: boolean;
    repeat: number;
    playbackRate: number;
    canPlay: boolean;
    canPause: boolean;
    canToggle: boolean;
    canNext: boolean;
    canPrevious: boolean;
    canSeek: boolean;
    canShuffle: boolean;
    canRepeat: boolean;
    canStop: boolean;
    canFastForward: boolean;
    canRewind: boolean;
    canPlaybackRate: boolean;
    platform?: "windows" | "macos" | "linux";
    source?: string;
    localArtworkUrl?: string;
    localArtworkDataUrl?: string;
    favorite?: boolean | null;
}

interface ItunesResult {
    trackName?: string;
    artistName?: string;
    collectionName?: string;
    artworkUrl100?: string;
    trackViewUrl?: string;
}

interface RemoteData {
    artworkUrl?: string;
    artworkDataUrl?: string;
    appleMusicLink?: string;
}

interface RemoteCacheEntry {
    data: RemoteData;
    expiresAt: number;
}

const WATCH_INTERVAL_MS = 900;
const STALE_WATCHER_MS = 6000;
const FETCH_TIMEOUT_MS = 4500;
const SUCCESS_CACHE_MS = 12 * 60 * 60 * 1000;
const FAILURE_CACHE_MS = 2500;
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

let watcher: ChildProcess | null = null;
let watcherBuffer = "";
let latestRaw: RawTrackData | null = null;
let latestUpdate = 0;
const firstValueWaiters = new Set<() => void>();

const remoteCache = new Map<string, RemoteCacheEntry>();
const remoteInFlight = new Map<string, Promise<void>>();
const albumArtworkCache = new Map<string, RemoteData>();

const AWAIT_HELPER = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
`;

const GET_SESSION = String.raw`
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Get-AppleMusicSession($Manager) {
    foreach ($session in $Manager.GetSessions()) {
        $id = [string]$session.SourceAppUserModelId
        if (
            $id -eq 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App' -or
            $id -like 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!*' -or
            $id -like 'AppleInc.AppleMusicWin*!*' -or
            $id -match '(?i)AppleMusic'
        ) {
            return $session
        }
    }
    return $null
}
`;

const WATCHER_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${AWAIT_HELPER}
${GET_SESSION}
while ($true) {
    try {
        $session = Get-AppleMusicSession $manager
        if ($null -eq $session) {
            Write-Output 'null'
            Start-Sleep -Milliseconds ${WATCH_INTERVAL_MS}
            continue
        }

        $playback = $session.GetPlaybackInfo()
        $status = [int]$playback.PlaybackStatus
        if ($status -lt 3) {
            Write-Output 'null'
            Start-Sleep -Milliseconds ${WATCH_INTERVAL_MS}
            continue
        }

        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $timeline = $session.GetTimelineProperties()
        $controls = $playback.Controls

        $shuffle = $false
        try { $shuffle = [bool]$playback.IsShuffleActive } catch { }

        $repeat = 0
        try { $repeat = [int]$playback.AutoRepeatMode } catch { }

        $rate = 1.0
        try {
            if ($null -ne $playback.PlaybackRate -and [double]$playback.PlaybackRate -gt 0) {
                $rate = [double]$playback.PlaybackRate
            }
        } catch { }

        $start = [Math]::Max(0, $timeline.StartTime.TotalSeconds)
        $end = [Math]::Max($start, $timeline.EndTime.TotalSeconds)
        $position = [Math]::Max($start, $timeline.Position.TotalSeconds)

        [PSCustomObject]@{
            name = [string]$props.Title
            artist = [string]$props.Artist
            album = [string]$props.AlbumTitle
            playing = ($status -eq 4)
            position = [Math]::Max(0, $position - $start)
            duration = [Math]::Max(0, $end - $start)
            startTime = $start
            shuffle = $shuffle
            repeat = $repeat
            playbackRate = $rate
            canPlay = [bool]$controls.IsPlayEnabled
            canPause = [bool]$controls.IsPauseEnabled
            canToggle = [bool]$controls.IsPlayPauseToggleEnabled
            canNext = [bool]$controls.IsNextEnabled
            canPrevious = [bool]$controls.IsPreviousEnabled
            canSeek = [bool]$controls.IsPlaybackPositionEnabled
            canShuffle = [bool]$controls.IsShuffleEnabled
            canRepeat = [bool]$controls.IsRepeatEnabled
            canStop = [bool]$controls.IsStopEnabled
            canFastForward = [bool]$controls.IsFastForwardEnabled
            canRewind = [bool]$controls.IsRewindEnabled
            canPlaybackRate = [bool]$controls.IsPlaybackRateEnabled
        } | ConvertTo-Json -Compress
    } catch {
        Write-Output 'null'
    }
    Start-Sleep -Milliseconds ${WATCH_INTERVAL_MS}
}
`;

function encodePowerShell(script: string) {
    return Buffer.from(script, "utf16le").toString("base64");
}


const WINDOWS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${AWAIT_HELPER}
${GET_SESSION}
try {
    $session = Get-AppleMusicSession $manager
    if ($null -eq $session) { Write-Output 'null'; exit 0 }

    $playback = $session.GetPlaybackInfo()
    $status = [int]$playback.PlaybackStatus
    if ($status -lt 3) { Write-Output 'null'; exit 0 }

    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($null -eq $props -or [string]::IsNullOrWhiteSpace([string]$props.Title)) { Write-Output 'null'; exit 0 }

    $timeline = $session.GetTimelineProperties()
    $controls = $playback.Controls

    $shuffle = $false
    try { $shuffle = [bool]$playback.IsShuffleActive } catch { }

    $repeat = 0
    try { $repeat = [int]$playback.AutoRepeatMode } catch { }

    $rate = 1.0
    try {
        if ($null -ne $playback.PlaybackRate -and [double]$playback.PlaybackRate -gt 0) {
            $rate = [double]$playback.PlaybackRate
        }
    } catch { }

    $start = [Math]::Max(0, $timeline.StartTime.TotalSeconds)
    $end = [Math]::Max($start, $timeline.EndTime.TotalSeconds)
    $position = [Math]::Max($start, $timeline.Position.TotalSeconds)

    [PSCustomObject]@{
        name = [string]$props.Title
        artist = [string]$props.Artist
        album = [string]$props.AlbumTitle
        playing = ($status -eq 4)
        position = [Math]::Max(0, $position - $start)
        duration = [Math]::Max(0, $end - $start)
        startTime = $start
        shuffle = $shuffle
        repeat = $repeat
        playbackRate = $rate
        canPlay = [bool]$controls.IsPlayEnabled
        canPause = [bool]$controls.IsPauseEnabled
        canToggle = [bool]$controls.IsPlayPauseToggleEnabled
        canNext = [bool]$controls.IsNextEnabled
        canPrevious = [bool]$controls.IsPreviousEnabled
        canSeek = [bool]$controls.IsPlaybackPositionEnabled
        canShuffle = [bool]$controls.IsShuffleEnabled
        canRepeat = [bool]$controls.IsRepeatEnabled
        canStop = [bool]$controls.IsStopEnabled
        canFastForward = [bool]$controls.IsFastForwardEnabled
        canRewind = [bool]$controls.IsRewindEnabled
        canPlaybackRate = [bool]$controls.IsPlaybackRateEnabled
    } | ConvertTo-Json -Compress
} catch {
    Write-Output 'null'
}
`;

function normalizeAppleMetadata(raw: RawTrackData): RawTrackData {
    let artist = (raw.artist || "").trim();
    let album = (raw.album || "").trim();

    if (!album) {
        const split = artist.split(/\s+[\u2014\u2013-]\s+/);
        if (split.length >= 2) {
            artist = split.shift()!.trim();
            album = split.join(" - ").trim();
        }
    }

    const repeat = [0, 1, 2].includes(Number(raw.repeat)) ? Number(raw.repeat) : 0;
    const playbackRate = Number.isFinite(Number(raw.playbackRate)) && Number(raw.playbackRate) > 0
        ? Number(raw.playbackRate)
        : 1;

    return {
        ...raw,
        name: (raw.name || "").trim(),
        artist,
        album,
        position: Number.isFinite(Number(raw.position)) ? Math.max(0, Number(raw.position)) : 0,
        duration: Number.isFinite(Number(raw.duration)) ? Math.max(0, Number(raw.duration)) : 0,
        startTime: Number.isFinite(Number(raw.startTime)) ? Math.max(0, Number(raw.startTime)) : 0,
        repeat,
        playbackRate,
    };
}

function handleWatcherLine(line: string) {
    const clean = line.replace(/^\uFEFF/, "").trim();
    if (!clean) return;

    latestUpdate = Date.now();
    if (clean === "null") latestRaw = null;
    else {
        try {
            latestRaw = normalizeAppleMetadata(JSON.parse(clean) as RawTrackData);
        } catch {
            return;
        }
    }

    for (const waiter of firstValueWaiters) waiter();
    firstValueWaiters.clear();
}

function startWatcher() {
    if (watcher && !watcher.killed) return;

    watcherBuffer = "";
    latestUpdate = 0;
    watcher = spawn("powershell.exe", [...POWERSHELL_ARGS, "-EncodedCommand", encodePowerShell(WATCHER_SCRIPT)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
    });

    watcher.stdout?.setEncoding("utf8");
    watcher.stdout?.on("data", chunk => {
        watcherBuffer += String(chunk);
        let newlineIndex: number;
        while ((newlineIndex = watcherBuffer.indexOf("\n")) !== -1) {
            const line = watcherBuffer.slice(0, newlineIndex);
            watcherBuffer = watcherBuffer.slice(newlineIndex + 1);
            handleWatcherLine(line);
        }
    });

    watcher.once("exit", () => {
        watcher = null;
        watcherBuffer = "";
        latestRaw = null;
        latestUpdate = 0;
        for (const waiter of firstValueWaiters) waiter();
        firstValueWaiters.clear();
    });
}

function stopWatcherInternal() {
    if (watcher) watcher.kill();
    watcher = null;
    watcherBuffer = "";
    latestRaw = null;
    latestUpdate = 0;
    for (const waiter of firstValueWaiters) waiter();
    firstValueWaiters.clear();
}

async function waitForFirstWatcherValue(timeoutMs = 1800) {
    if (latestUpdate) return;

    await new Promise<void>(resolve => {
        const finish = () => {
            clearTimeout(timeout);
            firstValueWaiters.delete(finish);
            resolve();
        };
        const timeout = setTimeout(finish, timeoutMs);
        firstValueWaiters.add(finish);
    });
}

function normalizeForMatch(value: string | undefined) {
    return (value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/\b(feat|ft)\.?\b.*$/i, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function scoreResult(track: RawTrackData, result: ItunesResult) {
    const wantedTitle = normalizeForMatch(track.name);
    const wantedArtist = normalizeForMatch(track.artist);
    const wantedAlbum = normalizeForMatch(track.album);
    const gotTitle = normalizeForMatch(result.trackName);
    const gotArtist = normalizeForMatch(result.artistName);
    const gotAlbum = normalizeForMatch(result.collectionName);

    let score = 0;
    if (wantedTitle && gotTitle === wantedTitle) score += 8;
    else if (wantedTitle && (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle))) score += 4;

    if (wantedArtist && gotArtist === wantedArtist) score += 6;
    else if (wantedArtist && (gotArtist.includes(wantedArtist) || wantedArtist.includes(gotArtist))) score += 3;

    if (wantedAlbum && gotAlbum === wantedAlbum) score += 3;
    else if (wantedAlbum && gotAlbum && (gotAlbum.includes(wantedAlbum) || wantedAlbum.includes(gotAlbum))) score += 1;

    return score;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function normalizeArtworkUrl(url: string) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:") parsed.protocol = "https:";
        return parsed.toString();
    } catch {
        return url;
    }
}

function isAllowedArtworkUrl(url: string) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === "https:" && (
            host === "mzstatic.com"
            || host.endsWith(".mzstatic.com")
            || host === "itunes.apple.com"
            || host.endsWith(".itunes.apple.com")
        );
    } catch {
        return false;
    }
}

async function fetchAllowedArtworkResponse(url: string): Promise<Response | undefined> {
    let currentUrl = normalizeArtworkUrl(url);

    for (let redirect = 0; redirect <= 3; redirect++) {
        if (!isAllowedArtworkUrl(currentUrl)) return undefined;

        const response = await fetchWithTimeout(currentUrl, {
            redirect: "manual",
            headers: {
                "User-Agent": VENCORD_USER_AGENT,
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
        });

        if (![301, 302, 303, 307, 308].includes(response.status)) return response;

        const location = response.headers.get("location");
        if (!location) return undefined;

        try {
            currentUrl = new URL(location, currentUrl).toString();
        } catch {
            return undefined;
        }
    }

    return undefined;
}

async function fetchArtworkDataUrl(url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    const normalizedUrl = normalizeArtworkUrl(url);
    if (!isAllowedArtworkUrl(normalizedUrl)) return undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetchAllowedArtworkResponse(normalizedUrl);
            if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 0}`);

            const contentLength = Number(response.headers.get("content-length") || 0);
            if (Number.isFinite(contentLength) && contentLength > 6_000_000) throw new Error("Artwork too large");

            const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
            if (!contentType.startsWith("image/")) throw new Error("Not an image");

            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length || buffer.length > 6_000_000) throw new Error("Invalid artwork size");
            return `data:${contentType};base64,${buffer.toString("base64")}`;
        } catch {
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }

    return undefined;
}

async function fetchFirstArtworkDataUrl(urls: Array<string | undefined>) {
    for (const url of Array.from(new Set(urls.filter((value): value is string => Boolean(value))))) {
        const dataUrl = await fetchArtworkDataUrl(url);
        if (dataUrl) return dataUrl;
    }
    return undefined;
}

function toLargeArtwork(url?: string, size = 600) {
    if (!url) return undefined;

    try {
        const parsed = new URL(normalizeArtworkUrl(url));
        parsed.pathname = parsed.pathname
            .replace(/\d+x\d+(?:bb)?(?:-\d+)?\.(jpg|jpeg|png|webp)$/i, `${size}x${size}bb.$1`)
            .replace(/\/\d+x\d+(?:bb)?(?:-\d+)?\//i, `/${size}x${size}bb/`);
        return parsed.toString();
    } catch {
        return normalizeArtworkUrl(url)
            .replace(/\d+x\d+(?:bb)?(?:-\d+)?\.(jpg|jpeg|png|webp)$/i, `${size}x${size}bb.$1`)
            .replace(/\/\d+x\d+(?:bb)?(?:-\d+)?\//i, `/${size}x${size}bb/`);
    }
}

function albumCacheKey(track: RawTrackData) {
    const artist = normalizeForMatch(track.artist);
    const album = normalizeForMatch(track.album);
    return artist && album ? `${artist}\u0000${album}` : "";
}

function getLikelyStorefronts() {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    let region: string | undefined;

    try {
        region = new Intl.Locale(locale).region?.toUpperCase();
    } catch {
        region = locale.split("-").reverse().find(part => /^[A-Za-z]{2}$/.test(part))?.toUpperCase();
    }

    return Array.from(new Set([region, "US", "GB"].filter((value): value is string => Boolean(value))));
}

async function searchItunes(track: RawTrackData, term: string, country: string): Promise<ItunesResult | undefined> {
    try {
        const query = new URLSearchParams({
            term,
            country,
            media: "music",
            entity: "song",
            limit: "25",
        });
        const response = await fetchWithTimeout(`https://itunes.apple.com/search?${query}`, {
            headers: { "User-Agent": VENCORD_USER_AGENT },
        });
        if (!response.ok) return undefined;

        const json = await response.json() as { results?: ItunesResult[]; };
        const best = (json.results || [])
            .map(result => ({ result, score: scoreResult(track, result) }))
            .sort((a, b) => b.score - a.score)[0];

        return best && best.score >= 5 ? best.result : undefined;
    } catch {
        return undefined;
    }
}

interface ItunesRemoteData extends RemoteData {
    fallbackArtworkUrl?: string;
}

async function findItunesData(track: RawTrackData): Promise<ItunesRemoteData> {
    const terms = [
        [track.name, track.artist].filter(Boolean).join(" "),
        [track.name, track.artist, track.album].filter(Boolean).join(" "),
        track.name,
    ].filter((value, index, array) => value && array.indexOf(value) === index);

    for (const country of getLikelyStorefronts()) {
        for (const term of terms) {
            const result = await searchItunes(track, term, country);
            if (!result) continue;

            const fallbackArtworkUrl = result.artworkUrl100 ? normalizeArtworkUrl(result.artworkUrl100) : undefined;
            const artworkUrl = toLargeArtwork(fallbackArtworkUrl, 600);
            return {
                artworkUrl: artworkUrl || fallbackArtworkUrl,
                fallbackArtworkUrl,
                appleMusicLink: result.trackViewUrl,
            };
        }
    }

    return {};
}

const THUMBNAIL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${AWAIT_HELPER}
${GET_SESSION}
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
        $session = Get-AppleMusicSession $manager
        if ($null -ne $session) {
            $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $dataUrl = ''

            if ($null -ne $props.Thumbnail) {
                $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                if ($null -ne $stream -and $stream.Size -gt 0 -and $stream.Size -le 6000000) {
                    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
                    $loaded = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
                    if ($loaded -gt 0) {
                        $bytes = New-Object byte[] ([int]$loaded)
                        $reader.ReadBytes($bytes)
                        $mime = [string]$stream.ContentType
                        if ([string]::IsNullOrWhiteSpace($mime) -or -not $mime.StartsWith('image/')) { $mime = 'image/jpeg' }
                        $dataUrl = 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes)
                    }
                    try { $reader.Dispose() } catch { }
                    try { $stream.Dispose() } catch { }
                }
            }

            if (-not [string]::IsNullOrWhiteSpace($dataUrl)) {
                [PSCustomObject]@{
                    name = [string]$props.Title
                    artist = [string]$props.Artist
                    album = [string]$props.AlbumTitle
                    artworkDataUrl = $dataUrl
                } | ConvertTo-Json -Compress
                exit 0
            }
        }
    } catch { }

    Start-Sleep -Milliseconds (250 + ($attempt * 200))
}

Write-Output '{}'
`;

async function execPowerShell(script: string, timeout = 4000): Promise<string> {
    return await new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            [...POWERSHELL_ARGS, "-EncodedCommand", encodePowerShell(script)],
            { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()),
        );
    });
}

async function execFileText(command: string, args: string[], timeout = 4000, maxBuffer = 8 * 1024 * 1024): Promise<string> {
    return await new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            { windowsHide: true, timeout, encoding: "utf8", maxBuffer },
            (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()),
        );
    });
}

function dataUrlMimeFromPath(path: string) {
    switch (extname(path).toLowerCase()) {
        case ".png": return "image/png";
        case ".webp": return "image/webp";
        case ".gif": return "image/gif";
        case ".avif": return "image/avif";
        default: return "image/jpeg";
    }
}

async function readLocalArtworkFile(url: string): Promise<string | undefined> {
    try {
        const filePath = fileURLToPath(url);
        const buffer = await readFile(filePath);
        if (!buffer.length || buffer.length > 6_000_000) return undefined;
        return `data:${dataUrlMimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
    } catch {
        return undefined;
    }
}

interface SessionArtworkResult {
    name?: string;
    artist?: string;
    album?: string;
    artworkDataUrl?: string;
}

function sessionArtworkMatches(track: RawTrackData, result: SessionArtworkResult) {
    const wantedTitle = normalizeForMatch(track.name);
    const gotTitle = normalizeForMatch(result.name);
    if (!wantedTitle || !gotTitle || wantedTitle !== gotTitle) return false;

    const wantedAlbum = normalizeForMatch(track.album);
    const gotAlbum = normalizeForMatch(result.album);
    if (wantedAlbum && gotAlbum && wantedAlbum !== gotAlbum) return false;

    return true;
}

async function fetchSessionThumbnailDataUrl(track: RawTrackData): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const value = await execPowerShell(THUMBNAIL_SCRIPT, 7500);
            const result = JSON.parse(value || "{}") as SessionArtworkResult;
            if (result.artworkDataUrl?.startsWith("data:image/") && sessionArtworkMatches(track, result)) {
                return result.artworkDataUrl;
            }
        } catch { }

        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350));
    }

    return undefined;
}

async function fetchLocalArtworkDataUrl(track: RawTrackData): Promise<string | undefined> {
    if (track.localArtworkDataUrl?.startsWith("data:image/")) return track.localArtworkDataUrl;

    if (process.platform === "win32") {
        const windowsArtwork = await fetchSessionThumbnailDataUrl(track);
        if (windowsArtwork) return windowsArtwork;
    }

    const artworkUrl = track.localArtworkUrl?.trim();
    if (!artworkUrl) return undefined;
    if (artworkUrl.startsWith("data:image/")) return artworkUrl;
    if (artworkUrl.startsWith("file://")) return readLocalArtworkFile(artworkUrl);
    if (isAllowedArtworkUrl(artworkUrl)) return fetchArtworkDataUrl(artworkUrl);

    return undefined;
}

function mergeRemoteData(base: RemoteData | undefined, patch: RemoteData): RemoteData {
    const next: RemoteData = { ...(base || {}) };
    if (patch.artworkUrl) next.artworkUrl = patch.artworkUrl;
    if (patch.artworkDataUrl) next.artworkDataUrl = patch.artworkDataUrl;
    if (patch.appleMusicLink) next.appleMusicLink = patch.appleMusicLink;
    return next;
}

function setRemoteCache(key: string, patch: RemoteData, ttl = SUCCESS_CACHE_MS) {
    const current = remoteCache.get(key)?.data;
    const data = mergeRemoteData(current, patch);
    remoteCache.set(key, { data, expiresAt: Date.now() + ttl });
    if (remoteCache.size > 100) remoteCache.delete(remoteCache.keys().next().value!);
    return data;
}

function setAlbumArtworkCache(albumKey: string, patch: RemoteData) {
    if (!albumKey || (!patch.artworkDataUrl && !patch.artworkUrl)) return;
    const current = albumArtworkCache.get(albumKey);
    const data = mergeRemoteData(current, patch);
    albumArtworkCache.set(albumKey, data);
    if (albumArtworkCache.size > 80) albumArtworkCache.delete(albumArtworkCache.keys().next().value!);
}

async function resolveRemoteDataProgressively(key: string, track: RawTrackData, onlineMetadata: boolean): Promise<void> {
    const albumKey = albumCacheKey(track);
    const cachedAlbum = albumKey ? albumArtworkCache.get(albumKey) : undefined;
    if (cachedAlbum) setRemoteCache(key, cachedAlbum);

    const localArtworkTask = (async () => {
        const artworkDataUrl = await fetchLocalArtworkDataUrl(track);
        if (!artworkDataUrl) return;

        const patch = { artworkDataUrl };
        setRemoteCache(key, patch);
        setAlbumArtworkCache(albumKey, patch);
    })();

    const onlineTask = onlineMetadata ? (async () => {
        const itunes = await findItunesData(track);
        const metadataPatch: RemoteData = {
            artworkUrl: itunes.artworkUrl,
            appleMusicLink: itunes.appleMusicLink,
        };

        if (metadataPatch.artworkUrl || metadataPatch.appleMusicLink) {
            setRemoteCache(key, metadataPatch, remoteCache.get(key)?.data.artworkDataUrl ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS);
            setAlbumArtworkCache(albumKey, metadataPatch);
        }

        if (!remoteCache.get(key)?.data.artworkDataUrl) {
            const artworkDataUrl = await fetchFirstArtworkDataUrl([itunes.artworkUrl, itunes.fallbackArtworkUrl]);
            if (artworkDataUrl && !remoteCache.get(key)?.data.artworkDataUrl) {
                const patch = { artworkDataUrl };
                setRemoteCache(key, patch);
                setAlbumArtworkCache(albumKey, patch);
            }
        }
    })() : Promise.resolve();

    await Promise.allSettled([localArtworkTask, onlineTask]);

    if (!remoteCache.has(key)) {
        remoteCache.set(key, { data: {}, expiresAt: Date.now() + FAILURE_CACHE_MS });
    }
}

function remoteKey(track: RawTrackData, onlineMetadata: boolean) {
    return `${track.name}\u0000${track.artist}\u0000${track.album}\u0000${onlineMetadata}`;
}

function getRemoteDataNonBlocking(track: RawTrackData, onlineMetadata: boolean): RemoteData {
    const key = remoteKey(track, onlineMetadata);
    const now = Date.now();
    const cached = remoteCache.get(key);
    const staleData = cached?.data || {};

    if (cached && cached.expiresAt > now) return cached.data;
    if (cached) remoteCache.delete(key);

    const albumKey = albumCacheKey(track);
    const cachedAlbum = albumKey ? albumArtworkCache.get(albumKey) : undefined;
    if (cachedAlbum) setRemoteCache(key, cachedAlbum, FAILURE_CACHE_MS);

    if (!remoteInFlight.has(key)) {
        const promise = resolveRemoteDataProgressively(key, track, onlineMetadata)
            .catch(() => {
                if (!remoteCache.has(key)) {
                    remoteCache.set(key, { data: {}, expiresAt: Date.now() + FAILURE_CACHE_MS });
                }
            })
            .finally(() => remoteInFlight.delete(key));

        remoteInFlight.set(key, promise);
    }

    return remoteCache.get(key)?.data || staleData;
}

function controlScript(action: ControlAction, value?: number | boolean) {
    const numericValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const booleanValue = value === true ? "$true" : "$false";

    let operation = "$ok = $false";
    switch (action) {
        case "toggle":
            operation = "$ok = Await ($session.TryTogglePlayPauseAsync()) ([bool])";
            break;
        case "play":
            operation = "$ok = Await ($session.TryPlayAsync()) ([bool])";
            break;
        case "pause":
            operation = "$ok = Await ($session.TryPauseAsync()) ([bool])";
            break;
        case "next":
            operation = "$ok = Await ($session.TrySkipNextAsync()) ([bool])";
            break;
        case "previous":
            operation = "$ok = Await ($session.TrySkipPreviousAsync()) ([bool])";
            break;
        case "seek": {
            const relativeTicks = Math.max(0, Math.round(numericValue * 10_000_000));
            operation = String.raw`
$timeline = $session.GetTimelineProperties()
$startTicks = [Int64]$timeline.StartTime.Ticks
$ok = Await ($session.TryChangePlaybackPositionAsync([Int64]($startTicks + ${relativeTicks}))) ([bool])`;
            break;
        }
        case "shuffle":
            operation = `$ok = Await ($session.TryChangeShuffleActiveAsync(${booleanValue})) ([bool])`;
            break;
        case "repeat": {
            const repeat = Math.max(0, Math.min(2, Math.round(numericValue)));
            operation = String.raw`
[Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime] | Out-Null
$mode = [Windows.Media.MediaPlaybackAutoRepeatMode]${repeat}
$ok = Await ($session.TryChangeAutoRepeatModeAsync($mode)) ([bool])`;
            break;
        }
        case "stop":
            operation = "$ok = Await ($session.TryStopAsync()) ([bool])";
            break;
        case "fastForward":
            operation = "$ok = Await ($session.TryFastForwardAsync()) ([bool])";
            break;
        case "rewind":
            operation = "$ok = Await ($session.TryRewindAsync()) ([bool])";
            break;
        case "rate": {
            const rate = Math.max(0.1, Math.min(4, numericValue));
            operation = `$ok = Await ($session.TryChangePlaybackRateAsync([double]${rate})) ([bool])`;
            break;
        }
    }

    return String.raw`
$ErrorActionPreference = 'Stop'
${AWAIT_HELPER}
${GET_SESSION}
$session = Get-AppleMusicSession $manager
if ($null -eq $session) { Write-Output 'false'; exit 0 }
${operation}
if ($ok) { Write-Output 'true' } else { Write-Output 'false' }
`;
}

// Platform backends ---------------------------------------------------------
// Windows uses GSMTC, macOS uses Music.app AppleScript, Linux uses MPRIS.

const MAC_SEPARATOR = String.fromCharCode(30);
let linuxPlayerName: string | null = null;
let linuxMprisService: string | null = null;
let linuxLastPosition = 0;
let unixRawCache: { platform: "macos" | "linux"; data: RawTrackData | null; expiresAt: number; } | null = null;
let unixRawInFlight: Promise<RawTrackData | null> | null = null;

async function getWindowsRawTrackData(): Promise<RawTrackData | null> {
    if (latestUpdate && Date.now() - latestUpdate > STALE_WATCHER_MS) stopWatcherInternal();
    startWatcher();
    if (!latestUpdate) await waitForFirstWatcherValue();

    if (latestRaw?.name) {
        return normalizeAppleMetadata({ ...latestRaw, platform: "windows", source: "Apple Music for Windows (GSMTC watcher)" });
    }

    // Fallback: query GSMTC directly. This covers cases where the long-lived watcher
    // started before Apple Music registered its media session or PowerShell exited early.
    try {
        const output = (await execPowerShell(WINDOWS_QUERY_SCRIPT, 5000)).trim();
        if (output && output !== "null") {
            const direct = normalizeAppleMetadata(JSON.parse(output) as RawTrackData);
            if (direct.name) {
                latestRaw = direct;
                latestUpdate = Date.now();
                return normalizeAppleMetadata({ ...direct, platform: "windows", source: "Apple Music for Windows (GSMTC direct fallback)" });
            }
        }
    } catch (error) {
        console.error("[AppleMusicControls] Direct Windows GSMTC query failed", error);
    }

    return null;
}

function parseAppleScriptBoolean(value: string | undefined) {
    return String(value || "").trim().toLowerCase() === "true";
}

function parseMacRepeat(value: string | undefined): RepeatMode {
    const mode = String(value || "").trim().toLowerCase();
    if (mode.includes("one")) return 1;
    if (mode.includes("all")) return 2;
    return 0;
}

const MAC_TRACK_SCRIPT = String.raw`
tell application "Music"
    if player state is stopped then return ""
    set sep to ASCII character 30
    set t to current track
    set shuffleText to "false"
    try
        set shuffleText to (shuffle enabled) as text
    end try
    set repeatText to "off"
    try
        set repeatText to (song repeat) as text
    end try
    set stateText to (player state) as text
    return ((name of t) as text) & sep & ((artist of t) as text) & sep & ((album of t) as text) & sep & stateText & sep & ((player position) as text) & sep & ((duration of t) as text) & sep & shuffleText & sep & repeatText
end tell
`;

async function isMacMusicRunning() {
    try {
        await execFileText("/usr/bin/pgrep", ["-x", "Music"], 1200);
        return true;
    } catch {
        return false;
    }
}

async function execAppleScript(script: string, timeout = 3500) {
    return execFileText("/usr/bin/osascript", ["-e", script], timeout);
}

async function getMacTrackFromAppleScript(): Promise<RawTrackData | null> {
    if (!await isMacMusicRunning()) return null;

    try {
        const output = await execAppleScript(MAC_TRACK_SCRIPT, 3500);
        if (!output) return null;
        const parts = output.split(MAC_SEPARATOR);
        if (parts.length < 8 || !parts[0]?.trim()) return null;

        const state = (parts[3] || "").trim().toLowerCase();
        const duration = Math.max(0, Number(parts[5]) || 0);
        return normalizeAppleMetadata({
            name: parts[0] || "",
            artist: parts[1] || "",
            album: parts[2] || "",
            playing: state.includes("playing") || state.includes("fast forwarding") || state.includes("rewinding"),
            position: Math.max(0, Number(parts[4]) || 0),
            duration,
            startTime: 0,
            shuffle: parseAppleScriptBoolean(parts[6]),
            repeat: parseMacRepeat(parts[7]),
            playbackRate: 1,
            canPlay: true,
            canPause: true,
            canToggle: true,
            canNext: true,
            canPrevious: true,
            canSeek: duration > 0,
            canShuffle: true,
            canRepeat: true,
            canStop: true,
            canFastForward: duration > 0,
            canRewind: duration > 0,
            canPlaybackRate: false,
            platform: "macos",
            source: "Music.app (AppleScript)",
            favorite: null,
        });
    } catch {
        return null;
    }
}

function parseNowPlayingBool(value: string) {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseNowPlayingRepeat(value: string): RepeatMode {
    const normalized = value.trim().toLowerCase();
    // MediaRemote commonly reports 0=None, 1=One, 2=All.
    if (normalized === "1" || normalized.includes("one") || normalized.includes("track")) return 1;
    if (normalized === "2" || normalized.includes("all") || normalized.includes("playlist")) return 2;
    return 0;
}

async function getMacTrackFromNowPlayingCli(): Promise<RawTrackData | null> {
    try {
        const output = await execFileText("nowplaying-cli", [
            "get",
            "title",
            "artist",
            "album",
            "duration",
            "elapsedTime",
            "playbackRate",
            "repeatMode",
            "shuffleMode",
            "isMusicApp",
        ], 2200, 2 * 1024 * 1024);
        const lines = output.split(/\r?\n/);
        if (lines.length < 9) return null;

        const [name, artist, album, durationText, elapsedText, playbackRateText, repeatText, shuffleText, isMusicApp] = lines;
        if (!parseNowPlayingBool(isMusicApp) || !name?.trim() || name.trim() === "null") return null;

        const playbackRate = Number(playbackRateText);
        const duration = Math.max(0, Number(durationText) || 0);
        return normalizeAppleMetadata({
            name: name === "null" ? "" : name,
            artist: artist === "null" ? "" : artist,
            album: album === "null" ? "" : album,
            playing: Number.isFinite(playbackRate) ? playbackRate > 0 : true,
            position: Math.max(0, Number(elapsedText) || 0),
            duration,
            startTime: 0,
            shuffle: parseNowPlayingBool(shuffleText) || shuffleText.trim() === "1",
            repeat: parseNowPlayingRepeat(repeatText),
            playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
            canPlay: true,
            canPause: true,
            canToggle: true,
            canNext: true,
            canPrevious: true,
            canSeek: duration > 0,
            canShuffle: true,
            canRepeat: true,
            canStop: true,
            canFastForward: duration > 0,
            canRewind: duration > 0,
            canPlaybackRate: false,
            platform: "macos",
            source: "Music.app (nowplaying-cli fallback)",
            favorite: null,
        });
    } catch {
        return null;
    }
}

async function getMacRawTrackData(): Promise<RawTrackData | null> {
    return await getMacTrackFromAppleScript() || await getMacTrackFromNowPlayingCli();
}

function macControlScript(action: ControlAction, value?: number | boolean) {
    const numberValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const boolValue = value === true ? "true" : "false";

    let operation = "return false";
    switch (action) {
        case "toggle": operation = "playpause\nreturn true"; break;
        case "play": operation = "play\nreturn true"; break;
        case "pause": operation = "pause\nreturn true"; break;
        case "next": operation = "next track\nreturn true"; break;
        case "previous": operation = "previous track\nreturn true"; break;
        case "seek": operation = `set player position to ${Math.max(0, numberValue)}\nreturn true`; break;
        case "shuffle": operation = `set shuffle enabled to ${boolValue}\nreturn true`; break;
        case "repeat": {
            const repeat = Math.max(0, Math.min(2, Math.round(numberValue)));
            const mode = repeat === 1 ? "one" : repeat === 2 ? "all" : "off";
            operation = `set song repeat to ${mode}\nreturn true`;
            break;
        }
        case "stop": operation = "stop\nreturn true"; break;
        case "fastForward": operation = "set player position to (player position + 15)\nreturn true"; break;
        case "rewind": operation = "set newPosition to (player position - 15)\nif newPosition < 0 then set newPosition to 0\nset player position to newPosition\nreturn true"; break;
        case "rate": operation = "return false"; break;
    }

    return String.raw`
tell application "Music"
    if player state is stopped then return false
    ${operation}
end tell
`;
}

async function controlMac(action: ControlAction, value?: number | boolean) {
    if (!await isMacMusicRunning()) return false;
    try {
        const result = await execAppleScript(macControlScript(action, value), 3000);
        return result.trim().toLowerCase().endsWith("true");
    } catch {
        // Transport controls still have an optional MediaRemote fallback on newer macOS.
        const command = action === "toggle" ? "togglePlayPause" : action;
        if (["togglePlayPause", "play", "pause", "next", "previous"].includes(command)) {
            try {
                await execFileText("nowplaying-cli", [command], 1800);
                return true;
            } catch { }
        }
        if (action === "seek" && typeof value === "number") {
            try {
                await execFileText("nowplaying-cli", ["seek", String(Math.max(0, value))], 1800);
                return true;
            } catch { }
        }
        return false;
    }
}

function macFavoriteScript(toggle: boolean) {
    const toggleBlock = toggle ? String.raw`
    if favState is not missing value then
        try
            set favorited of t to (not favState)
            delay 0.1
            set favState to favorited of t
        on error
            try
                set loved of t to (not favState)
                delay 0.1
                set favState to loved of t
            end try
        end try
    end if
` : "";

    return String.raw`
tell application "Music"
    if player state is stopped then return "unavailable"
    set t to current track
    set favState to missing value
    try
        set favState to favorited of t
    on error
        try
            set favState to loved of t
        end try
    end try
    ${toggleBlock}
    if favState is missing value then return "unavailable"
    return favState as text
end tell
`;
}

async function getMacFavoriteState(toggle: boolean): Promise<FavoriteStateResult> {
    if (!await isMacMusicRunning()) return { available: false, favorite: null };
    try {
        const output = (await execAppleScript(macFavoriteScript(toggle), 3500)).trim().toLowerCase();
        if (output === "true") return { available: true, favorite: true };
        if (output === "false") return { available: true, favorite: false };
    } catch { }
    return { available: false, favorite: null };
}

function playerNameLooksLikeApple(player: string) {
    const value = player.toLowerCase();
    return value.includes("cider") || value.includes("sidra") || value.includes("applemusic") || value.includes("apple-music") || value === "music";
}

function browserPlayerName(player: string) {
    const value = player.toLowerCase();
    return value.includes("chromium") || value.includes("chrome") || value.includes("firefox") || value.includes("brave") || value.includes("vivaldi") || value.includes("opera") || value.includes("edge");
}

function applePlayerScore(player: string, url: string, identity = "", artUrl = "") {
    const p = player.toLowerCase();
    const u = url.toLowerCase();
    const i = identity.toLowerCase();
    const a = artUrl.toLowerCase();
    let score = 0;
    const applePage = u.includes("music.apple.com");
    const appleArtwork = a.includes("mzstatic.com") || a.includes("itunes.apple.com");
    if (applePage) score += 120;
    if (appleArtwork) score += 100;
    if (playerNameLooksLikeApple(p)) score += 90;
    if (i.includes("cider") || i.includes("sidra") || i.includes("apple music")) score += 80;
    if (browserPlayerName(p) && !applePage && !appleArtwork) return -1;
    return score;
}

function parseMprisRepeat(value: string): RepeatMode {
    const normalized = value.trim().toLowerCase();
    if (normalized === "track") return 1;
    if (normalized === "playlist") return 2;
    return 0;
}

function parseMprisShuffle(value: string) {
    const normalized = value.trim().toLowerCase();
    return normalized === "on" || normalized === "true" || normalized === "1";
}

interface LinuxCandidate {
    raw: RawTrackData;
    score: number;
    player?: string;
    service?: string;
}

async function playerctlQuery(player: string, args: string[], timeout = 1800) {
    return execFileText("playerctl", ["-p", player, ...args], timeout, 2 * 1024 * 1024);
}

async function getLinuxViaPlayerctl(): Promise<LinuxCandidate | null> {
    let players: string[];
    try {
        players = (await execFileText("playerctl", ["-l"], 1800, 1024 * 1024))
            .split(/\r?\n/)
            .map(value => value.trim())
            .filter(Boolean);
    } catch {
        return null;
    }

    let best: LinuxCandidate | null = null;
    for (const player of players) {
        try {
            const format = "{{title}}" + MAC_SEPARATOR + "{{artist}}" + MAC_SEPARATOR + "{{album}}" + MAC_SEPARATOR + "{{mpris:length}}" + MAC_SEPARATOR + "{{xesam:url}}" + MAC_SEPARATOR + "{{mpris:artUrl}}";
            const metadata = await playerctlQuery(player, ["metadata", "--format", format]);
            const [name = "", artist = "", album = "", lengthText = "", url = "", artUrl = ""] = metadata.split(MAC_SEPARATOR);
            const score = applePlayerScore(player, url, "", artUrl);
            if (score < 0 || !name.trim()) continue;

            const [status, positionText] = await Promise.all([
                playerctlQuery(player, ["status"]).catch(() => "Stopped"),
                playerctlQuery(player, ["position"]).catch(() => "0"),
            ]);
            if (status.trim().toLowerCase() === "stopped") continue;

            const [shuffleResult, loopResult, rateResult] = await Promise.allSettled([
                playerctlQuery(player, ["shuffle"]),
                playerctlQuery(player, ["loop"]),
                playerctlQuery(player, ["rate"]),
            ]);
            const shuffleText = shuffleResult.status === "fulfilled" ? shuffleResult.value : "Off";
            const loopText = loopResult.status === "fulfilled" ? loopResult.value : "None";
            const rateText = rateResult.status === "fulfilled" ? rateResult.value : "1";
            const duration = Math.max(0, (Number(lengthText) || 0) / 1_000_000);
            const position = Math.max(0, Number(positionText) || 0);
            const rate = Number(rateText);

            const raw = normalizeAppleMetadata({
                name,
                artist,
                album,
                playing: status.trim().toLowerCase() === "playing",
                position,
                duration,
                startTime: 0,
                shuffle: parseMprisShuffle(shuffleText),
                repeat: parseMprisRepeat(loopText),
                playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
                canPlay: true,
                canPause: true,
                canToggle: true,
                canNext: true,
                canPrevious: true,
                canSeek: duration > 0,
                canShuffle: shuffleResult.status === "fulfilled",
                canRepeat: loopResult.status === "fulfilled",
                canStop: true,
                canFastForward: duration > 0,
                canRewind: duration > 0,
                canPlaybackRate: rateResult.status === "fulfilled",
                platform: "linux",
                source: `MPRIS via playerctl (${player})`,
                localArtworkUrl: artUrl || undefined,
                favorite: null,
            });
            const candidate = { raw, score, player };
            if (!best || candidate.score > best.score) best = candidate;
        } catch { }
    }

    if (best?.player) {
        linuxPlayerName = best.player;
        linuxMprisService = null;
        linuxLastPosition = best.raw.position;
    }
    return best;
}

function gdbusUnescape(value: string) {
    return value.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function gdbusString(output: string, key: string) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`'${escaped}'\\s*:\\s*<\\s*'((?:\\\\.|[^'])*)'\\s*>`));
    return match ? gdbusUnescape(match[1]) : "";
}

function gdbusStringArrayFirst(output: string, key: string) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`'${escaped}'\\s*:\\s*<\\s*\\[\\s*'((?:\\\\.|[^'])*)'`));
    return match ? gdbusUnescape(match[1]) : gdbusString(output, key);
}

function gdbusNumber(output: string, key: string) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`'${escaped}'\\s*:\\s*<\\s*(?:int64|uint64|double|int32|uint32)?\\s*([-+]?\\d+(?:\\.\\d+)?)`));
    return match ? Number(match[1]) : NaN;
}

function gdbusBool(output: string, key: string) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`'${escaped}'\\s*:\\s*<\\s*(true|false)\\s*>`, "i"));
    return match ? match[1].toLowerCase() === "true" : false;
}

async function gdbusCall(service: string, method: string, args: string[] = [], timeout = 2200) {
    return execFileText("gdbus", [
        "call", "--session", "--dest", service, "--object-path", "/org/mpris/MediaPlayer2", "--method", method, ...args,
    ], timeout, 4 * 1024 * 1024);
}

async function getLinuxViaGdbus(): Promise<LinuxCandidate | null> {
    let listOutput: string;
    try {
        listOutput = await execFileText("gdbus", [
            "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames",
        ], 2200, 2 * 1024 * 1024);
    } catch {
        return null;
    }

    const services = Array.from(listOutput.matchAll(/'([^']+)'/g), match => match[1])
        .filter(name => name.startsWith("org.mpris.MediaPlayer2."));

    let best: LinuxCandidate | null = null;
    for (const service of services) {
        try {
            const playerProps = await gdbusCall(service, "org.freedesktop.DBus.Properties.GetAll", ["org.mpris.MediaPlayer2.Player"]);
            const baseProps = await gdbusCall(service, "org.freedesktop.DBus.Properties.GetAll", ["org.mpris.MediaPlayer2"]).catch(() => "");
            const name = gdbusString(playerProps, "xesam:title");
            const artist = gdbusStringArrayFirst(playerProps, "xesam:artist");
            const album = gdbusString(playerProps, "xesam:album");
            const url = gdbusString(playerProps, "xesam:url");
            const artUrl = gdbusString(playerProps, "mpris:artUrl");
            const identity = gdbusString(baseProps, "Identity");
            const playerId = service.slice("org.mpris.MediaPlayer2.".length);
            const score = applePlayerScore(playerId, url, identity, artUrl);
            if (score < 0 || !name) continue;

            const playbackStatus = gdbusString(playerProps, "PlaybackStatus");
            if (playbackStatus.toLowerCase() === "stopped") continue;
            const duration = Math.max(0, (gdbusNumber(playerProps, "mpris:length") || 0) / 1_000_000);
            const position = Math.max(0, (gdbusNumber(playerProps, "Position") || 0) / 1_000_000);
            const loop = gdbusString(playerProps, "LoopStatus");
            const rate = gdbusNumber(playerProps, "Rate");

            const raw = normalizeAppleMetadata({
                name,
                artist,
                album,
                playing: playbackStatus.toLowerCase() === "playing",
                position,
                duration,
                startTime: 0,
                shuffle: gdbusBool(playerProps, "Shuffle"),
                repeat: parseMprisRepeat(loop),
                playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
                canPlay: gdbusBool(playerProps, "CanPlay"),
                canPause: gdbusBool(playerProps, "CanPause"),
                canToggle: gdbusBool(playerProps, "CanPlay") || gdbusBool(playerProps, "CanPause"),
                canNext: gdbusBool(playerProps, "CanGoNext"),
                canPrevious: gdbusBool(playerProps, "CanGoPrevious"),
                canSeek: gdbusBool(playerProps, "CanSeek"),
                canShuffle: playerProps.includes("'Shuffle'"),
                canRepeat: playerProps.includes("'LoopStatus'"),
                canStop: gdbusBool(playerProps, "CanControl"),
                canFastForward: gdbusBool(playerProps, "CanSeek"),
                canRewind: gdbusBool(playerProps, "CanSeek"),
                canPlaybackRate: playerProps.includes("'Rate'") && gdbusBool(playerProps, "CanControl"),
                platform: "linux",
                source: `MPRIS via gdbus (${identity || playerId})`,
                localArtworkUrl: artUrl || undefined,
                favorite: null,
            });
            const candidate = { raw, score, service };
            if (!best || candidate.score > best.score) best = candidate;
        } catch { }
    }

    if (best?.service) {
        linuxMprisService = best.service;
        linuxPlayerName = null;
        linuxLastPosition = best.raw.position;
    }
    return best;
}

async function getLinuxRawTrackDataUncached(): Promise<RawTrackData | null> {
    const playerctl = await getLinuxViaPlayerctl();
    if (playerctl) return playerctl.raw;
    const gdbus = await getLinuxViaGdbus();
    return gdbus?.raw || null;
}

async function getUnixRawCached(platform: "macos" | "linux") {
    const now = Date.now();
    if (unixRawCache?.platform === platform && unixRawCache.expiresAt > now) return unixRawCache.data;
    if (unixRawInFlight) return unixRawInFlight;

    unixRawInFlight = (platform === "macos" ? getMacRawTrackData() : getLinuxRawTrackDataUncached())
        .then(data => {
            unixRawCache = { platform, data, expiresAt: Date.now() + 550 };
            return data;
        })
        .finally(() => { unixRawInFlight = null; });
    return unixRawInFlight;
}

async function ensureLinuxTarget() {
    if (linuxPlayerName || linuxMprisService) return true;
    return Boolean(await getLinuxRawTrackDataUncached());
}

async function controlLinuxPlayerctl(action: ControlAction, value?: number | boolean) {
    if (!linuxPlayerName && !await ensureLinuxTarget()) return false;
    if (!linuxPlayerName) return false;

    let args: string[] = [];
    switch (action) {
        case "toggle": args = ["play-pause"]; break;
        case "play": args = ["play"]; break;
        case "pause": args = ["pause"]; break;
        case "next": args = ["next"]; break;
        case "previous": args = ["previous"]; break;
        case "seek": args = ["position", String(Math.max(0, Number(value) || 0))]; break;
        case "shuffle": args = ["shuffle", value === true ? "On" : "Off"]; break;
        case "repeat": args = ["loop", Number(value) === 1 ? "Track" : Number(value) === 2 ? "Playlist" : "None"]; break;
        case "stop": args = ["stop"]; break;
        case "fastForward": args = ["position", "15+"]; break;
        case "rewind": args = ["position", "15-"]; break;
        case "rate": args = ["rate", String(Math.max(0.1, Math.min(4, Number(value) || 1)))]; break;
    }
    try {
        await playerctlQuery(linuxPlayerName, args, 2200);
        unixRawCache = null;
        return true;
    } catch {
        return false;
    }
}

async function getGdbusCurrentPosition(service: string) {
    try {
        const output = await gdbusCall(service, "org.freedesktop.DBus.Properties.Get", ["org.mpris.MediaPlayer2.Player", "Position"]);
        const match = output.match(/int64\s+(-?\d+)/);
        if (match) return Math.max(0, Number(match[1]) / 1_000_000);
    } catch { }
    return linuxLastPosition;
}

async function setGdbusProperty(service: string, property: string, variant: string) {
    await gdbusCall(service, "org.freedesktop.DBus.Properties.Set", ["org.mpris.MediaPlayer2.Player", property, variant]);
}

async function controlLinuxGdbus(action: ControlAction, value?: number | boolean) {
    if (!linuxMprisService && !await ensureLinuxTarget()) return false;
    const service = linuxMprisService;
    if (!service) return false;

    try {
        switch (action) {
            case "toggle": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.PlayPause"); break;
            case "play": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Play"); break;
            case "pause": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Pause"); break;
            case "next": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Next"); break;
            case "previous": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Previous"); break;
            case "stop": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Stop"); break;
            case "seek": {
                const current = await getGdbusCurrentPosition(service);
                const target = Math.max(0, Number(value) || 0);
                const delta = Math.round((target - current) * 1_000_000);
                if (delta !== 0) await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Seek", [String(delta)]);
                linuxLastPosition = target;
                break;
            }
            case "fastForward": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Seek", [String(15_000_000)]); break;
            case "rewind": await gdbusCall(service, "org.mpris.MediaPlayer2.Player.Seek", [String(-15_000_000)]); break;
            case "shuffle": await setGdbusProperty(service, "Shuffle", `<${value === true ? "true" : "false"}>`); break;
            case "repeat": {
                const mode = Number(value) === 1 ? "Track" : Number(value) === 2 ? "Playlist" : "None";
                await setGdbusProperty(service, "LoopStatus", `<"${mode}">`);
                break;
            }
            case "rate": await setGdbusProperty(service, "Rate", `<${Math.max(0.1, Math.min(4, Number(value) || 1))}>`); break;
        }
        unixRawCache = null;
        return true;
    } catch {
        return false;
    }
}

async function controlLinux(action: ControlAction, value?: number | boolean) {
    // Prefer playerctl when present, fall back to GLib's gdbus so there is no hard extra dependency.
    if (linuxPlayerName) return controlLinuxPlayerctl(action, value);
    if (linuxMprisService) return controlLinuxGdbus(action, value);
    await ensureLinuxTarget();
    if (linuxPlayerName) return controlLinuxPlayerctl(action, value);
    if (linuxMprisService) return controlLinuxGdbus(action, value);
    return false;
}

async function getRawTrackDataForPlatform(): Promise<RawTrackData | null> {
    switch (process.platform) {
        case "win32": return getWindowsRawTrackData();
        case "darwin": return getUnixRawCached("macos");
        case "linux": return getUnixRawCached("linux");
        default: return null;
    }
}

function windowsUiFallbackScript(action: ControlAction, value?: number | boolean) {
    const numericValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const booleanValue = value === true ? "$true" : "$false";
    const actionValue = JSON.stringify(action);

    return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
${AWAIT_HELPER}
${GET_SESSION}

function Get-AppleMusicRoot {
    $processes = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($process in $processes) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            if ($null -ne $root) { return $root }
        } catch { }
    }
    return $null
}

function Get-BestButton($root, [string]$kind) {
    if ($null -eq $root) { return $null }
    $windowRect = $root.Current.BoundingRectangle
    $topBand = $windowRect.Top + [Math]::Min(320, [Math]::Max(170, $windowRect.Height * 0.30))
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
    )
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $best = $null
    $bestScore = -100000

    foreach ($button in $buttons) {
        try {
            $name = [string]$button.Current.Name
            $help = [string]$button.Current.HelpText
            $automationId = [string]$button.Current.AutomationId
            $combined = ($name + ' ' + $help + ' ' + $automationId).ToLowerInvariant()

            $matches = $false
            if ($kind -eq 'shuffle') {
                $matches = $combined -match '(shuffle|miesz|losow|zufall|al[eé]atoire|aleatori|casual|willekeurig|bland|tilfeld|sekoit|karıştır)'
            } elseif ($kind -eq 'repeat') {
                $matches = $combined -match '(repeat|powtarz|wiederhol|r[eé]p[eé]t|repet|ripeti|herhaal|upprepa|gjenta|toista|tekrar)'
            }
            if (-not $matches) { continue }

            $rect = $button.Current.BoundingRectangle
            if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
            $score = 0
            if ($rect.Top -le $topBand) { $score += 120 } else { $score -= 120 }
            if ($automationId.ToLowerInvariant() -match $kind) { $score += 35 }
            if ($rect.Width -le 80 -and $rect.Height -le 80) { $score += 20 }

            $windowCenterX = $windowRect.Left + ($windowRect.Width / 2)
            $buttonCenterX = $rect.Left + ($rect.Width / 2)
            $score -= [Math]::Min(35, [Math]::Abs($buttonCenterX - $windowCenterX) / 55)

            if ($score -gt $bestScore) { $bestScore = $score; $best = $button }
        } catch { }
    }
    if ($bestScore -gt 0) { return $best }
    return $null
}

function Invoke-Button($button) {
    if ($null -eq $button) { return $false }
    try {
        $toggle = [System.Windows.Automation.TogglePattern]$button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $toggle) { $toggle.Toggle(); return $true }
    } catch { }
    try {
        $invoke = [System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -ne $invoke) { $invoke.Invoke(); return $true }
    } catch { }
    return $false
}

function Set-PlaybackSlider($root, [double]$targetSeconds) {
    if ($null -eq $root) { return $false }
    $session = Get-AppleMusicSession $manager
    if ($null -eq $session) { return $false }
    $timeline = $session.GetTimelineProperties()
    $duration = [Math]::Max(0.0, ($timeline.EndTime - $timeline.StartTime).TotalSeconds)
    $current = [Math]::Max(0.0, ($timeline.Position - $timeline.StartTime).TotalSeconds)
    if ($duration -le 0) { return $false }

    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Slider
    )
    $sliders = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $windowRect = $root.Current.BoundingRectangle
    $topBand = $windowRect.Top + [Math]::Min(360, [Math]::Max(190, $windowRect.Height * 0.34))
    $currentRatio = [Math]::Min(1.0, [Math]::Max(0.0, $current / $duration))
    $targetRatio = [Math]::Min(1.0, [Math]::Max(0.0, $targetSeconds / $duration))
    $bestPattern = $null
    $bestScore = -100000

    foreach ($slider in $sliders) {
        try {
            $range = [System.Windows.Automation.RangeValuePattern]$slider.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
            if ($null -eq $range -or $range.Current.IsReadOnly) { continue }
            $min = [double]$range.Current.Minimum
            $max = [double]$range.Current.Maximum
            if ($max -le $min) { continue }

            $name = [string]$slider.Current.Name
            $help = [string]$slider.Current.HelpText
            $automationId = [string]$slider.Current.AutomationId
            $combined = ($name + ' ' + $help + ' ' + $automationId).ToLowerInvariant()
            if ($combined -match '(volume|głoś|glos|lautst|audio volume|airplay)') { continue }

            $valueRatio = ([double]$range.Current.Value - $min) / ($max - $min)
            $distance = [Math]::Abs($valueRatio - $currentRatio)
            $score = 100 - [Math]::Min(100, $distance * 240)
            if ($combined -match '(playback|position|timeline|scrub|seek|progress|time|post[eę]p|pozyc|odtwarz|utw[oó]r)') { $score += 130 }

            $rect = $slider.Current.BoundingRectangle
            if ($rect.Width -gt 0 -and $rect.Height -gt 0 -and $rect.Top -le $topBand) { $score += 70 }
            if ($rect.Width -gt 180) { $score += 25 }

            if ($score -gt $bestScore) { $bestScore = $score; $bestPattern = $range }
        } catch { }
    }

    if ($null -eq $bestPattern -or $bestScore -lt 25) { return $false }
    $min = [double]$bestPattern.Current.Minimum
    $max = [double]$bestPattern.Current.Maximum
    $desired = $min + (($max - $min) * $targetRatio)
    $bestPattern.SetValue($desired)
    return $true
}

$action = ${actionValue}
$root = Get-AppleMusicRoot
if ($null -eq $root) { Write-Output 'false'; exit 0 }

if ($action -eq 'seek') {
    if (Set-PlaybackSlider $root ${numericValue}) { Write-Output 'true' } else { Write-Output 'false' }
    exit 0
}

$session = Get-AppleMusicSession $manager
if ($null -eq $session) { Write-Output 'false'; exit 0 }
$playback = $session.GetPlaybackInfo()

if ($action -eq 'shuffle') {
    $desired = ${booleanValue}
    $current = $false
    try { $current = [bool]$playback.IsShuffleActive } catch { }
    if ($current -eq $desired) { Write-Output 'true'; exit 0 }
    $button = Get-BestButton $root 'shuffle'
    if (Invoke-Button $button) { Write-Output 'true' } else { Write-Output 'false' }
    exit 0
}

if ($action -eq 'repeat') {
    $target = [int]${numericValue}
    if ($target -lt 0 -or $target -gt 2) { Write-Output 'false'; exit 0 }
    $current = 0
    try { $current = [int]$playback.AutoRepeatMode } catch { }
    if ($current -eq $target) { Write-Output 'true'; exit 0 }
    $button = Get-BestButton $root 'repeat'
    if ($null -eq $button) { Write-Output 'false'; exit 0 }

    $clicks = 0
    while ($current -ne $target -and $clicks -lt 3) {
        if (-not (Invoke-Button $button)) { Write-Output 'false'; exit 0 }
        Start-Sleep -Milliseconds 140
        if ($current -eq 0) { $current = 2 }
        elseif ($current -eq 2) { $current = 1 }
        else { $current = 0 }
        $clicks++
    }
    if ($current -eq $target) { Write-Output 'true' } else { Write-Output 'false' }
    exit 0
}

Write-Output 'false'
`;
}

async function controlWindows(action: ControlAction, value?: number | boolean) {
    try {
        const result = await execPowerShell(controlScript(action, value));
        if (result.toLowerCase().split(/\s+/).at(-1) === "true") return true;
    } catch { }

    if (action !== "seek" && action !== "shuffle" && action !== "repeat") return false;
    try {
        const fallback = await execPowerShell(windowsUiFallbackScript(action, value), 6000);
        return fallback.toLowerCase().split(/\s+/).at(-1) === "true";
    } catch {
        return false;
    }
}

async function controlForPlatform(action: ControlAction, value?: number | boolean) {
    switch (process.platform) {
        case "win32": return controlWindows(action, value);
        case "darwin": return controlMac(action, value);
        case "linux": return controlLinux(action, value);
        default: return false;
    }
}


export async function getTrackData(_: IpcMainInvokeEvent, onlineMetadata = true): Promise<TrackData | null> {
    const allowOnlineMetadata = onlineMetadata === true;
    const raw = await getRawTrackDataForPlatform();
    if (!raw?.name) return null;

    const remote = getRemoteDataNonBlocking(raw, allowOnlineMetadata);
    const windowsFallbacks = raw.platform === "windows"
        ? {
            canSeek: raw.duration > 0,
            canShuffle: true,
            canRepeat: true,
        }
        : {};

    return {
        ...raw,
        ...windowsFallbacks,
        repeat: raw.repeat as RepeatMode,
        ...remote,
    };
}

export async function control(_: IpcMainInvokeEvent, action: ControlAction, value?: number | boolean): Promise<boolean> {
    const allowed: ControlAction[] = [
        "toggle", "play", "pause", "next", "previous", "seek", "shuffle", "repeat",
        "stop", "fastForward", "rewind", "rate",
    ];
    if (!allowed.includes(action)) return false;
    if (action === "shuffle" && typeof value !== "boolean") return false;
    if ((action === "seek" || action === "repeat" || action === "rate") && (typeof value !== "number" || !Number.isFinite(value))) return false;
    return controlForPlatform(action, value);
}

interface FavoriteStateResult {
    available: boolean;
    favorite: boolean | null;
}

function favoriteUiAutomationScript(toggle: boolean) {
    const shouldToggle = toggle ? "$true" : "$false";

    return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

function Get-FavoriteButton {
    $processes = @(Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($process in $processes) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            if ($null -eq $root) { continue }

            $windowRect = $root.Current.BoundingRectangle
            $topBand = $windowRect.Top + [Math]::Min(300, [Math]::Max(170, $windowRect.Height * 0.28))
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Button
            )
            $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            $best = $null
            $bestScore = -100000

            foreach ($button in $buttons) {
                try {
                    $name = [string]$button.Current.Name
                    $help = [string]$button.Current.HelpText
                    $automationId = [string]$button.Current.AutomationId
                    $combined = ($name + ' ' + $help + ' ' + $automationId).ToLowerInvariant()

                    # Apple Music localizes accessibility names. Keep this intentionally broad,
                    # then strongly prefer controls in the top playback chrome.
                    if ($combined -notmatch '(favorite|favourite|ulubion|favorit|favori|favorito|favorita|preferit|favoriet|favoritt|favoritt|obl[ií]ben|obľúben|kedvenc|suosik|favoris)') { continue }

                    $rect = $button.Current.BoundingRectangle
                    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }

                    $score = 0
                    if ($rect.Top -le $topBand) { $score += 100 }
                    else { $score -= 100 }

                    if ($combined -match '(unfavorite|unfavourite|remove.{0,12}fav|usuń.{0,16}ulubion|usun.{0,16}ulubion|entfern.{0,16}favorit|retirer.{0,16}favor|quitar.{0,16}favor|rimuov.{0,16}preferit|verwijder.{0,16}favor|fjern.{0,16}favor|ta bort.{0,16}favor)') { $score += 35 }
                    if ($combined -match '(add.{0,12}fav|dodaj.{0,16}ulubion|zu.{0,16}favorit|ajouter.{0,16}favor|añad.{0,16}favor|agreg.{0,16}favor|aggiung.{0,16}preferit|toevoeg.{0,16}favor|legg.{0,16}favor|lägg.{0,16}favor)') { $score += 30 }
                    if ($automationId.ToLowerInvariant() -match '(favorite|favourite|favorit)') { $score += 20 }

                    $windowCenterX = $windowRect.Left + ($windowRect.Width / 2)
                    $buttonCenterX = $rect.Left + ($rect.Width / 2)
                    $distance = [Math]::Abs($buttonCenterX - $windowCenterX)
                    $score -= [Math]::Min(30, $distance / 40)

                    if ($score -gt $bestScore) {
                        $bestScore = $score
                        $best = $button
                    }
                } catch { }
            }

            if ($null -ne $best -and $bestScore -gt 0) { return $best }
        } catch { }
    }

    return $null
}

function Get-FavoriteState($button) {
    if ($null -eq $button) { return $null }

    try {
        $pattern = [System.Windows.Automation.TogglePattern]$button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $pattern) {
            return ($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
        }
    } catch { }

    try {
        $combined = (([string]$button.Current.Name) + ' ' + ([string]$button.Current.HelpText)).ToLowerInvariant()
        if ($combined -match '(unfavorite|unfavourite|remove.{0,12}fav|usuń.{0,16}ulubion|usun.{0,16}ulubion|entfern.{0,16}favorit|retirer.{0,16}favor|quitar.{0,16}favor|rimuov.{0,16}preferit|verwijder.{0,16}favor|fjern.{0,16}favor|ta bort.{0,16}favor)') { return $true }
        if ($combined -match '(add.{0,12}fav|dodaj.{0,16}ulubion|zu.{0,16}favorit|ajouter.{0,16}favor|añad.{0,16}favor|agreg.{0,16}favor|aggiung.{0,16}preferit|toevoeg.{0,16}favor|legg.{0,16}favor|lägg.{0,16}favor)') { return $false }
        if ($combined -match '^(favorite|favourite|favorit|ulubione|ulubiony|favorito|favorita|preferito|preferita)$') { return $false }
    } catch { }

    return $null
}

$button = Get-FavoriteButton
if ($null -eq $button) {
    [PSCustomObject]@{ available = $false; favorite = $null } | ConvertTo-Json -Compress
    exit 0
}

$stateBefore = Get-FavoriteState $button
if (${shouldToggle}) {
    $invoked = $false
    try {
        $togglePattern = [System.Windows.Automation.TogglePattern]$button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $togglePattern) {
            $togglePattern.Toggle()
            $invoked = $true
        }
    } catch { }

    if (-not $invoked) {
        try {
            $invokePattern = [System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $invokePattern) {
                $invokePattern.Invoke()
                $invoked = $true
            }
        } catch { }
    }

    if ($invoked) {
        Start-Sleep -Milliseconds 180
        $buttonAfter = Get-FavoriteButton
        $stateAfter = Get-FavoriteState $buttonAfter
        if ($null -eq $stateAfter -and $null -ne $stateBefore) { $stateAfter = -not $stateBefore }
        [PSCustomObject]@{ available = $true; favorite = $stateAfter } | ConvertTo-Json -Compress
        exit 0
    }
}

[PSCustomObject]@{ available = $true; favorite = $stateBefore } | ConvertTo-Json -Compress
`;
}

async function runFavoriteUiAutomation(toggle: boolean): Promise<FavoriteStateResult> {
    try {
        const output = await execPowerShell(favoriteUiAutomationScript(toggle), 5500);
        const parsed = JSON.parse(output || "{}") as Partial<FavoriteStateResult>;
        return {
            available: parsed.available === true,
            favorite: typeof parsed.favorite === "boolean" ? parsed.favorite : null,
        };
    } catch {
        return { available: false, favorite: null };
    }
}

export async function getFavoriteState(_: IpcMainInvokeEvent): Promise<FavoriteStateResult> {
    switch (process.platform) {
        case "win32": return runFavoriteUiAutomation(false);
        case "darwin": return getMacFavoriteState(false);
        default: return { available: false, favorite: null };
    }
}

export async function toggleFavorite(_: IpcMainInvokeEvent): Promise<FavoriteStateResult> {
    switch (process.platform) {
        case "win32": return runFavoriteUiAutomation(true);
        case "darwin": return getMacFavoriteState(true);
        default: return { available: false, favorite: null };
    }
}

export async function stopWatcher(_: IpcMainInvokeEvent): Promise<void> {
    if (process.platform === "win32") stopWatcherInternal();
    unixRawCache = null;
    unixRawInFlight = null;
    linuxPlayerName = null;
    linuxMprisService = null;
}
