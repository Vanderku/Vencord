/*
 * AppleMusicControls for Vencord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./appleMusicStyles.css";

import { Flex } from "@components/Flex";
import { CopyIcon, ImageIcon, LinkIcon, OpenExternalIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { classNameFactory } from "@utils/css";
import { copyWithToast, openImageModal } from "@utils/discord";
import { classes } from "@utils/misc";
import { ContextMenuApi, Menu, React, useEffect, useRef, useState } from "@webpack/common";

import { ControlAction, Native, RepeatMode, settings, TrackData } from ".";
import { SeekBar } from "./SeekBar";

const cl = classNameFactory("vc-apple-music-");
const REFRESH_MS = 900;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function formatDuration(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function Svg(path: string, label: string) {
    return () => (
        <svg
            className={cl("button-icon", label)}
            height="24"
            width="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label={label}
            focusable={false}
        >
            <path d={path} />
        </svg>
    );
}

const PlayButton = Svg("M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z", "play");
const PauseButton = Svg("M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z", "pause");
const SkipPrev = Svg("M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82 5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.57.4-.57 1.24 0 1.64z", "previous");
const SkipNext = Svg("M7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z", "next");
const Repeat = Svg("M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1V7zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.31.31.85.09.85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1v3z", "repeat");
const Shuffle = Svg("M10.59 9.17 6.12 4.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.46 4.46 1.42-1.4zm4.76-4.32 1.19 1.19L4.7 17.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L17.96 7.46l1.19 1.19c.31.31.85.09.85-.36V4.5c0-.28-.22-.5-.5-.5h-3.79c-.45 0-.67.54-.36.85zm-.52 8.56-1.41 1.41 3.13 3.13-1.2 1.2c-.31.31-.09.85.36.85h3.79c.28 0 .5-.22.5-.5v-3.79c0-.45-.54-.67-.85-.35l-1.19 1.19-3.13-3.14z", "shuffle");
const MusicNote = Svg("M18.7 3.2c-.3-.2-.7-.2-1.1-.1L8.5 5.2c-.7.2-1.2.8-1.2 1.5v9.1a3.8 3.8 0 0 0-1.8-.4C3.6 15.4 2 16.6 2 18.2S3.6 21 5.5 21 9 19.8 9 18.2V9.5l8-1.8v5.9a3.8 3.8 0 0 0-1.8-.4c-1.9 0-3.5 1.2-3.5 2.8s1.6 2.8 3.5 2.8 3.5-1.2 3.5-2.8V4.1c0-.4-.2-.7-.5-.9Z", "apple-music");

function Heart({ filled }: { filled: boolean; }) {
    return (
        <svg
            className={cl("button-icon", "favorite-icon")}
            height="22"
            width="22"
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-label={filled ? "Favorited" : "Favorite"}
            focusable={false}
        >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
        </svg>
    );
}

interface FavoriteState {
    available: boolean;
    favorite: boolean | null;
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button className={cl("button")} {...props}>
            {props.children}
        </button>
    );
}

function openAppleMusic(url?: string) {
    if (!url) return;
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" && (
            parsed.hostname === "music.apple.com"
            || parsed.hostname.endsWith(".music.apple.com")
            || parsed.hostname === "itunes.apple.com"
            || parsed.hostname.endsWith(".itunes.apple.com")
        )) {
            VencordNative.native.openExternal(parsed.toString());
        }
    } catch { }
}

function PlayerContextMenu({ track, runControl }: { track: TrackData; runControl: (action: ControlAction, value?: number | boolean) => void; }) {
    const hasAdvanced = settings.store.showAdvancedActions && (
        track.canStop || track.canFastForward || track.canRewind || track.canPlaybackRate
    );

    return (
        <Menu.Menu
            navId="vc-apple-music-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Apple Music Player Menu"
        >
            {track.appleMusicLink && (
                <Menu.MenuItem
                    id="vc-apple-music-open"
                    label="Open in Apple Music"
                    action={() => openAppleMusic(track.appleMusicLink)}
                    icon={OpenExternalIcon}
                    leadingAccessory={{ type: "icon", icon: OpenExternalIcon }}
                />
            )}
            {track.appleMusicLink && (
                <Menu.MenuItem
                    id="vc-apple-music-copy-link"
                    label="Copy Apple Music Link"
                    action={() => track.appleMusicLink && copyWithToast(track.appleMusicLink)}
                    icon={LinkIcon}
                    leadingAccessory={{ type: "icon", icon: LinkIcon }}
                />
            )}
            <Menu.MenuItem
                id="vc-apple-music-copy-title"
                label="Copy Song Name"
                action={() => copyWithToast(track.name)}
                icon={CopyIcon}
                leadingAccessory={{ type: "icon", icon: CopyIcon }}
            />
            {track.artist && (
                <Menu.MenuItem
                    id="vc-apple-music-copy-artist"
                    label="Copy Artist Name"
                    action={() => copyWithToast(track.artist)}
                    icon={CopyIcon}
                    leadingAccessory={{ type: "icon", icon: CopyIcon }}
                />
            )}
            {track.artworkDataUrl && (
                <Menu.MenuItem
                    id="vc-apple-music-view-cover"
                    label="View Album Cover"
                    action={() => track.artworkDataUrl && openImageModal({ url: track.artworkDataUrl, width: 600, height: 600 })}
                    icon={ImageIcon}
                    leadingAccessory={{ type: "icon", icon: ImageIcon }}
                />
            )}

            {hasAdvanced && <Menu.MenuSeparator />}
            {settings.store.showAdvancedActions && track.canRewind && (
                <Menu.MenuItem id="vc-apple-music-rewind" label="Rewind" action={() => runControl("rewind")} />
            )}
            {settings.store.showAdvancedActions && track.canFastForward && (
                <Menu.MenuItem id="vc-apple-music-fast-forward" label="Fast Forward" action={() => runControl("fastForward")} />
            )}
            {settings.store.showAdvancedActions && track.canStop && (
                <Menu.MenuItem id="vc-apple-music-stop" label="Stop" action={() => runControl("stop")} />
            )}
            {settings.store.showAdvancedActions && track.canPlaybackRate && (
                <>
                    <Menu.MenuSeparator />
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                        <Menu.MenuItem
                            key={rate}
                            id={`vc-apple-music-rate-${String(rate).replace(".", "-")}`}
                            label={`Playback Speed: ${rate}x${Math.abs(track.playbackRate - rate) < 0.01 ? " ✓" : ""}`}
                            action={() => runControl("rate", rate)}
                        />
                    ))}
                </>
            )}
        </Menu.Menu>
    );
}

function Controls({ track, livePosition, runControl }: {
    track: TrackData;
    livePosition: number;
    runControl: (action: ControlAction, value?: number | boolean) => void;
}) {
    const nextRepeat: RepeatMode = track.repeat === 0 ? 2 : track.repeat === 2 ? 1 : 0;
    const repeatClass = track.repeat === 0 ? "repeat-off" : track.repeat === 1 ? "repeat-track" : "repeat-context";
    const canPlayPause = track.canToggle || (track.playing ? track.canPause : track.canPlay);

    const toggle = () => {
        if (track.canToggle) runControl("toggle");
        else runControl(track.playing ? "pause" : "play");
    };

    const previous = () => {
        if (settings.store.previousButtonRestartsTrack && livePosition > 3 && track.canSeek) runControl("seek", 0);
        else runControl("previous");
    };

    const openRepeatMenu = (event: React.MouseEvent) => {
        if (!track.canRepeat) return;
        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu navId="vc-apple-music-repeat-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Repeat Mode">
                <Menu.MenuItem id="vc-apple-music-repeat-off" label={`Repeat Off${track.repeat === 0 ? " ✓" : ""}`} action={() => runControl("repeat", 0)} />
                <Menu.MenuItem id="vc-apple-music-repeat-all" label={`Repeat All${track.repeat === 2 ? " ✓" : ""}`} action={() => runControl("repeat", 2)} />
                <Menu.MenuItem id="vc-apple-music-repeat-one" label={`Repeat One${track.repeat === 1 ? " ✓" : ""}`} action={() => runControl("repeat", 1)} />
            </Menu.Menu>
        ));
    };

    return (
        <Flex className={cl("button-row")} gap="0">
            <Button
                className={classes(cl("button"), cl("shuffle"), cl(track.shuffle ? "shuffle-on" : "shuffle-off"))}
                onClick={() => runControl("shuffle", !track.shuffle)}
                disabled={!track.canShuffle}
                title={track.shuffle ? "Disable Shuffle" : "Enable Shuffle"}
            >
                <Shuffle />
            </Button>
            <Button onClick={previous} disabled={!track.canPrevious && !track.canSeek} title="Previous">
                <SkipPrev />
            </Button>
            <Button onClick={toggle} disabled={!canPlayPause} title={track.playing ? "Pause" : "Play"}>
                {track.playing ? <PauseButton /> : <PlayButton />}
            </Button>
            <Button onClick={() => runControl("next")} disabled={!track.canNext} title="Next">
                <SkipNext />
            </Button>
            <Button
                className={classes(cl("button"), cl("repeat"), cl(repeatClass))}
                onClick={() => runControl("repeat", nextRepeat)}
                onContextMenu={openRepeatMenu}
                disabled={!track.canRepeat}
                title={track.repeat === 0 ? "Repeat Off - click for Repeat All, right-click for modes" : track.repeat === 2 ? "Repeat All - click for Repeat One, right-click for modes" : "Repeat One - click to disable, right-click for modes"}
                style={{ position: "relative" }}
            >
                {track.repeat === 1 && <span className={cl("repeat-1")}>1</span>}
                <Repeat />
            </Button>
        </Flex>
    );
}

function AppleMusicSeekBar({ track, position, onSeek }: {
    track: TrackData;
    position: number;
    onSeek: (seconds: number) => void;
}) {
    const duration = Math.max(0, track.duration || 0);
    const canSeek = track.canSeek && duration > 0;
    const onChange = (value: number) => {
        if (!canSeek) return;
        onSeek(clamp(value, 0, duration));
    };

    return (
        <div id={cl("progress-wrap")} className={canSeek ? cl("seek-enabled") : cl("seek-disabled")}>
            <div id={cl("progress-bar")}>
                <SeekBar
                    initialValue={position}
                    minValue={0}
                    maxValue={duration || 1}
                    onValueChange={onChange}
                    asValueChanges={onChange}
                    onValueRender={formatDuration}
                    disabled={!canSeek}
                />
            </div>
            <div id={cl("time-row")}>
                <Span size="xs" weight="medium" className={cl("progress-time")} aria-label="Progress">
                    {formatDuration(position)}
                </Span>
                <Span size="xs" weight="medium" className={cl("progress-time")} aria-label="Total Duration">
                    {formatDuration(duration)}
                </Span>
            </div>
        </div>
    );
}

function Info({ track, runControl, favoriteState, favoriteBusy, onToggleFavorite }: {
    track: TrackData;
    runControl: (action: ControlAction, value?: number | boolean) => void;
    favoriteState: FavoriteState | null;
    favoriteBusy: boolean;
    onToggleFavorite: () => void;
}) {
    const [coverExpanded, setCoverExpanded] = useState(false);
    const image = track.artworkDataUrl;

    const onContextMenu = (event: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(event, () => <PlayerContextMenu track={track} runControl={runControl} />);
    };

    const artwork = image
        ? (
            <img
                id={cl("album-image")}
                src={image}
                alt="Album artwork"
                onClick={() => setCoverExpanded(value => !value)}
                onContextMenu={onContextMenu}
                title="Expand album artwork"
            />
        )
        : (
            <span id={cl("album-fallback")} onContextMenu={onContextMenu}>
                <MusicNote />
            </span>
        );

    if (coverExpanded && image) {
        return (
            <div id={cl("album-expanded-wrapper")} onContextMenu={onContextMenu}>
                {artwork}
            </div>
        );
    }

    return (
        <div id={cl("info-wrapper")} onContextMenu={onContextMenu}>
            <div id={cl("album-wrapper")}>{artwork}</div>

            <div id={cl("titles")}>
                <Paragraph
                    weight="semibold"
                    id={cl("song-title")}
                    className={cl("ellipoverflow")}
                    title={track.name}
                    role={track.appleMusicLink ? "link" : undefined}
                    onClick={track.appleMusicLink ? () => openAppleMusic(track.appleMusicLink) : undefined}
                >
                    {track.name}
                </Paragraph>

                {track.artist && (
                    <Paragraph className={classes(cl("ellipoverflow"), cl("secondary-song-info"))} title={track.artist}>
                        {track.artist}
                    </Paragraph>
                )}

                {settings.store.showAlbum && track.album && (
                    <Paragraph className={classes(cl("ellipoverflow"), cl("secondary-song-info"), cl("album-title"))} title={track.album}>
                        {track.album}
                    </Paragraph>
                )}
            </div>

            {settings.store.showFavoriteButton && favoriteState?.available !== false && (
                <button
                    id={cl("favorite-button")}
                    className={classes(
                        cl("button"),
                        favoriteState?.favorite ? cl("favorite-on") : cl("favorite-off"),
                        favoriteBusy ? cl("favorite-busy") : undefined,
                    )}
                    onClick={onToggleFavorite}
                    disabled={favoriteBusy || favoriteState?.available === false}
                    title={
                        favoriteState?.available === false
                            ? "Favorite control is not available on the active Apple Music backend"
                            : favoriteState?.favorite
                                ? "Remove from Favorites"
                                : "Add to Favorites"
                    }
                    aria-label={favoriteState?.favorite ? "Remove from Favorites" : "Add to Favorites"}
                >
                    <Heart filled={favoriteState?.favorite === true} />
                </button>
            )}
        </div>
    );
}

export function Player() {
    const [track, setTrack] = useState<(TrackData & { receivedAt: number; }) | null>(null);
    const [backendError, setBackendError] = useState<string | null>(null);
    const [clock, setClock] = useState(Date.now());
    const [shouldHide, setShouldHide] = useState(false);
    const requestInFlight = useRef(false);
    const seekTimer = useRef<NodeJS.Timeout | undefined>();
    const favoriteRequestInFlight = useRef(false);
    const [favoriteState, setFavoriteState] = useState<FavoriteState | null>(null);
    const [favoriteBusy, setFavoriteBusy] = useState(false);

    const refresh = async () => {
        if (requestInFlight.current) return;
        requestInFlight.current = true;
        try {
            if (!Native?.getTrackData) throw new Error("Native helper is unavailable. Rebuild and fully restart Discord.");
            const next = await Native.getTrackData(settings.store.onlineMetadata);
            setBackendError(null);
            setTrack(next ? { ...next, receivedAt: Date.now() } : null);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[AppleMusicControls] Failed to read Apple Music session", error);
            setBackendError(message || "Unknown backend error");
        } finally {
            requestInFlight.current = false;
        }
    };

    const refreshFavorite = async () => {
        if (!settings.store.showFavoriteButton || favoriteRequestInFlight.current) return;
        favoriteRequestInFlight.current = true;
        try {
            setFavoriteState(await Native.getFavoriteState());
        } catch {
            setFavoriteState({ available: false, favorite: null });
        } finally {
            favoriteRequestInFlight.current = false;
        }
    };

    useEffect(() => {
        refresh();
        const refreshTimer = setInterval(refresh, REFRESH_MS);
        const clockTimer = setInterval(() => setClock(Date.now()), 250);
        return () => {
            clearInterval(refreshTimer);
            clearInterval(clockTimer);
            if (seekTimer.current) clearTimeout(seekTimer.current);
        };
    }, []);

    useEffect(() => {
        if (!settings.store.showFavoriteButton) {
            setFavoriteState(null);
            return;
        }

        setFavoriteState(null);
        refreshFavorite();
        const favoriteTimer = setInterval(refreshFavorite, 5000);
        return () => clearInterval(favoriteTimer);
    }, [track?.name, track?.artist, track?.album, settings.store.showFavoriteButton]);

    useEffect(() => {
        setShouldHide(false);
        if (track && !track.playing) {
            const timer = setTimeout(() => setShouldHide(true), 1000 * 60 * 5);
            return () => clearTimeout(timer);
        }
    }, [track?.name, track?.artist, track?.playing]);

    if (!track || shouldHide) {
        if (!backendError) return null;

        return (
            <div id={cl("player")} className={cl("diagnostic")} aria-label="Apple Music controls error">
                <div className={cl("diagnostic-title")}>AppleMusicControls</div>
                <div className={cl("diagnostic-text")}>Backend unavailable</div>
                <div className={cl("diagnostic-detail")}>{backendError}</div>
            </div>
        );
    }

    const duration = Math.max(0, track.duration || 0);
    const livePosition = clamp(
        track.position + (track.playing ? Math.max(0, clock - track.receivedAt) / 1000 * (track.playbackRate || 1) : 0),
        0,
        duration || Number.MAX_SAFE_INTEGER,
    );

    const runControl = async (action: ControlAction, value?: number | boolean) => {
        try {
            await Native.control(action, value);
            setTimeout(refresh, 100);
            setTimeout(refresh, 450);
        } catch { }
    };

    const onSeek = (seconds: number) => {
        setTrack({ ...track, position: seconds, receivedAt: Date.now() });
        if (seekTimer.current) clearTimeout(seekTimer.current);
        seekTimer.current = setTimeout(() => runControl("seek", seconds), 80);
    };

    const onToggleFavorite = async () => {
        if (favoriteBusy || favoriteState?.available === false) return;
        const previous = favoriteState;
        setFavoriteBusy(true);
        if (previous?.available && previous.favorite !== null) {
            setFavoriteState({ available: true, favorite: !previous.favorite });
        }

        try {
            const result = await Native.toggleFavorite();
            if (result.available) setFavoriteState(result);
            else if (previous) setFavoriteState(previous);
        } catch {
            if (previous) setFavoriteState(previous);
        } finally {
            setFavoriteBusy(false);
            setTimeout(refreshFavorite, 300);
            setTimeout(refreshFavorite, 1200);
        }
    };

    return (
        <div id={cl("player")} aria-label="Apple Music controls">
            <Info
                track={track}
                runControl={runControl}
                favoriteState={favoriteState}
                favoriteBusy={favoriteBusy}
                onToggleFavorite={onToggleFavorite}
            />
            <AppleMusicSeekBar track={track} position={livePosition} onSeek={onSeek} />
            <Controls track={track} livePosition={livePosition} runControl={runControl} />
        </div>
    );
}
