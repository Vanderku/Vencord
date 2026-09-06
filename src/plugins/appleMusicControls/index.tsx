/*
 * AppleMusicControls for Vencord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Activity, ActivityAssets, ActivityButton } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

import hoverOnlyStyle from "./hoverOnly.css?managed";
import { Player } from "./PlayerComponent";

export const Native = VencordNative.pluginHelpers.AppleMusicControls as PluginNative<typeof import("./native")>;

const APPLICATION_ID = "1239490006054207550";
const ACTIVITY_SOCKET_ID = "AppleMusicControls";
const PRESENCE_REFRESH_MS = 4000;

export type RepeatMode = 0 | 1 | 2;
export type AppleMusicPlatform = "windows" | "macos" | "linux";

export const IS_SUPPORTED_DESKTOP = IS_WINDOWS || IS_MAC || IS_LINUX;

export interface TrackData {
    name: string;
    artist: string;
    album: string;
    playing: boolean;
    position: number;
    duration: number;
    shuffle: boolean;
    repeat: RepeatMode;
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
    artworkUrl?: string;
    artworkDataUrl?: string;
    appleMusicLink?: string;
    platform?: AppleMusicPlatform;
    source?: string;
}

export type ControlAction =
    | "toggle"
    | "play"
    | "pause"
    | "next"
    | "previous"
    | "seek"
    | "shuffle"
    | "repeat"
    | "stop"
    | "fastForward"
    | "rewind"
    | "rate";

export const settings = definePluginSettings({
    hoverControls: {
        type: OptionType.BOOLEAN,
        description: "Show playback controls only while hovering the Apple Music player",
        default: false,
        onChange: value => toggleHoverControls(value),
    },
    previousButtonRestartsTrack: {
        type: OptionType.BOOLEAN,
        description: "Restart the current song when Previous is pressed after 3 seconds",
        default: true,
    },
    showAlbum: {
        type: OptionType.BOOLEAN,
        description: "Show the album name below the artist",
        default: true,
    },
    showFavoriteButton: {
        type: OptionType.BOOLEAN,
        description: "Show Favorite when the active backend can control Apple Music favorites. Windows uses UI Automation, macOS uses Music.app scripting, Linux depends on the player backend",
        default: true,
    },
    showPresence: {
        type: OptionType.BOOLEAN,
        description: "Show the current Apple Music song as a Discord Listening activity",
        default: true,
    },
    showPausedPresence: {
        type: OptionType.BOOLEAN,
        description: "Keep the Apple Music activity visible while playback is paused",
        default: false,
    },
    onlineMetadata: {
        type: OptionType.BOOLEAN,
        description: "Use Apple Search to resolve Apple Music links and high resolution artwork. Disable this to keep track metadata local",
        default: true,
    },
    showAdvancedActions: {
        type: OptionType.BOOLEAN,
        description: "Show extra media actions in the player context menu when the active platform backend exposes them",
        default: true,
    },
});

let presenceInterval: NodeJS.Timeout | undefined;
let lastPresenceKey = "";
const assetCache = new Map<string, string>();

function toggleHoverControls(value: boolean) {
    (value ? enableStyle : disableStyle)(hoverOnlyStyle);
}

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: ACTIVITY_SOCKET_ID,
    });
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function getActivityAsset(url?: string) {
    if (!url) return undefined;

    const cached = assetCache.get(url);
    if (cached) return cached;

    try {
        const [asset] = await ApplicationAssetUtils.fetchAssetIds(APPLICATION_ID, [url]);
        if (asset) {
            assetCache.set(url, asset);
            if (assetCache.size > 50) assetCache.delete(assetCache.keys().next().value!);
        }
        return asset;
    } catch {
        return undefined;
    }
}

async function buildActivity(track: TrackData | null): Promise<Activity | null> {
    if (!settings.store.showPresence || !track) return null;
    if (!track.playing && !settings.store.showPausedPresence) return null;

    const assets: ActivityAssets = {};
    const largeImage = await getActivityAsset(track.artworkUrl);
    if (largeImage) {
        assets.large_image = largeImage;
        assets.large_text = track.album || track.name;
        if (track.appleMusicLink) assets.large_url = track.appleMusicLink;
    }

    const buttons: ActivityButton[] = [];
    if (track.appleMusicLink) {
        buttons.push({ label: "Open in Apple Music", url: track.appleMusicLink });
    }

    const duration = Math.max(0, Number(track.duration) || 0);
    const position = clamp(Number(track.position) || 0, 0, duration || Number.MAX_SAFE_INTEGER);
    const now = Date.now();
    const timestamps = track.playing && duration > 0
        ? {
            start: now - position * 1000,
            end: now - position * 1000 + duration * 1000,
        }
        : undefined;

    return {
        application_id: APPLICATION_ID,
        name: "Apple Music",
        details: track.name || "Unknown track",
        state: track.artist || "Unknown artist",
        details_url: track.appleMusicLink,
        assets,
        buttons: buttons.length ? buttons.map(button => button.label) : undefined,
        metadata: buttons.length ? { button_urls: buttons.map(button => button.url) } : undefined,
        timestamps,
        type: ActivityType.LISTENING,
        status_display_type: ActivityStatusDisplayType.STATE,
        flags: ActivityFlags.INSTANCE,
    };
}

async function updatePresence(force = false) {
    if (!IS_SUPPORTED_DESKTOP) return;

    try {
        const track = await Native.getTrackData(settings.store.onlineMetadata);
        const key = track
            ? `${track.name}\u0000${track.artist}\u0000${track.album}\u0000${track.playing}\u0000${track.artworkUrl || ""}\u0000${settings.store.showPresence}\u0000${settings.store.showPausedPresence}`
            : "none";

        if (!force && key === lastPresenceKey) return;
        lastPresenceKey = key;
        setActivity(await buildActivity(track));
    } catch {
        if (lastPresenceKey !== "error") {
            lastPresenceKey = "error";
            setActivity(null);
        }
    }
}

export default definePlugin({
    name: "AppleMusicControls",
    description: "Adds Apple Music controls above the account panel on Windows, macOS and Linux",
    tags: ["Media", "Activity"],
    searchTerms: ["Apple Music", "AppleMusic", "music controls"],
    authors: [{ name: "Vanderku", id: 330445120761495567n }],
    hidden: !IS_SUPPORTED_DESKTOP,
    settings,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/,
                replace: "$self.PanelWrapper,{VencordOriginal:$1,",
            },
        },
    ],

    start() {
        if (!IS_SUPPORTED_DESKTOP) return;
        toggleHoverControls(settings.store.hoverControls);
        lastPresenceKey = "";
        updatePresence(true);
        presenceInterval = setInterval(() => updatePresence(), PRESENCE_REFRESH_MS);
    },

    stop() {
        disableStyle(hoverOnlyStyle);
        if (presenceInterval) clearInterval(presenceInterval);
        presenceInterval = undefined;
        lastPresenceKey = "";
        setActivity(null);
        Native.stopWatcher().catch(() => { });
    },

    PanelWrapper({ VencordOriginal, ...props }: any) {
        return (
            <>
                {IS_SUPPORTED_DESKTOP && (
                    <ErrorBoundary fallback={() => null}>
                        <Player />
                    </ErrorBoundary>
                )}
                <VencordOriginal {...props} />
            </>
        );
    },
});
