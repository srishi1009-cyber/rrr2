// ============================================================
// RISHI MUSIC - COMPLETE APP ENGINE (app.js)
// STABLE CONTINUOUS PLAYBACK VERSION
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 3;
const STORE_NAME = "tracks";

let db = null;
let songs = [];
let currentIndex = -1;

let activeArtist = "all";
let searchQuery = "";

let isTransitioning = false;
let playbackGeneration = 0;
let activePlayPromise = null;

let playbackWatchdog = null;
let transitionTimer = null;
let playTimeoutTimer = null;

let lastProgressTime = 0;
let lastProgressValue = 0;

// Unique shuffle/cycle pool
let unplayedQueue = [];

// Persistent Blob URL cache
const blobUrlCache = new WeakMap();


// ============================================================
// AUDIO ENGINE
// ============================================================

const audio = document.getElementById("audioEngine") || new Audio();

audio.id = "audioEngine";
audio.preload = "auto";
audio.setAttribute("playsinline", "true");

if (!document.getElementById("audioEngine")) {
    document.body.appendChild(audio);
}


// ============================================================
// DAILY NO-REPEAT ENGINE
// ============================================================

function getTodayKey() {
    const now = new Date();

    return `rishi_played_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}`;
}


function getDailyPlayedIds() {
    try {
        const data = localStorage.getItem(getTodayKey());

        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.warn("Could not read daily playback list:", e);
        return [];
    }
}


function markSongPlayedToday(songId) {
    if (songId === undefined || songId === null) {
        return;
    }

    try {
        const key = getTodayKey();

        let played = getDailyPlayedIds();

        if (!played.includes(songId)) {
            played.push(songId);

            localStorage.setItem(
                key,
                JSON.stringify(played)
            );
        }
    } catch (e) {
        console.warn("Could not save daily playback state:", e);
    }
}


// ============================================================
// INDEXED DB
// ============================================================

function openDatabase() {
    return new Promise((resolve, reject) => {

        const request = indexedDB.open(
            DB_NAME,
            DB_VERSION
        );

        request.onupgradeneeded = (event) => {

            const database = event.target.result;

            if (!database.objectStoreNames.contains(STORE_NAME)) {

                database.createObjectStore(
                    STORE_NAME,
                    {
                        keyPath: "id",
                        autoIncrement: true
                    }
                );
            }
        };

        request.onsuccess = () => {

            db = request.result;

            db.onversionchange = () => {
                try {
                    db.close();
                } catch (e) {}
            };

            resolve(db);
        };

        request.onerror = () => {
            reject(request.error);
        };

        request.onblocked = () => {
            console.warn("IndexedDB blocked.");
        };
    });
}


function saveTrackToDB(track) {
    return new Promise((resolve, reject) => {

        if (!db) {
            reject(new Error("Database is not ready"));
            return;
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.add(track);

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}


function loadAllTracksFromDB() {
    return new Promise((resolve, reject) => {

        if (!db) {
            reject(new Error("Database is not ready"));
            return;
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readonly"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.getAll();

        request.onsuccess = () => {

            resolve(
                Array.isArray(request.result)
                    ? request.result
                    : []
            );
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}


function updateTrackInDB(track) {
    return new Promise((resolve, reject) => {

        if (!db) {
            reject(new Error("Database is not ready"));
            return;
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.put(track);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}


function deleteTrackFromDB(id) {
    return new Promise((resolve, reject) => {

        if (!db) {
            reject(new Error("Database is not ready"));
            return;
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.delete(id);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}


// ============================================================
// SONG HELPERS
// ============================================================

function getSongTitle(song) {

    return (
        song?.title ||
        song?.name ||
        "Unknown Song"
    );
}


function getSongArtist(song) {

    return String(
        song?.artist ||
        song?.director ||
        "Unknown Director"
    ).trim().toUpperCase();
}


function getSongSource(song) {

    if (!song) {
        return null;
    }

    if (song.blob) {

        if (!blobUrlCache.has(song.blob)) {

            try {
                blobUrlCache.set(
                    song.blob,
                    URL.createObjectURL(song.blob)
                );
            } catch (e) {
                console.error(
                    "Could not create Blob URL:",
                    e
                );

                return null;
            }
        }

        return blobUrlCache.get(song.blob);
    }

    if (song.url) {
        return song.url;
    }

    return null;
}


// ============================================================
// FILTERING & SMART SELECTION
// ============================================================

function getFilteredSongIndexes() {

    const result = [];

    const query =
        searchQuery.trim().toLowerCase();

    for (let i = 0; i < songs.length; i++) {

        const song = songs[i];

        if (!song) {
            continue;
        }

        if (
            activeArtist !== "all" &&
            getSongArtist(song).toLowerCase() !==
                activeArtist.toLowerCase()
        ) {
            continue;
        }

        if (query) {

            const searchable = [
                getSongTitle(song),
                getSongArtist(song),
                song.name || "",
                song.director || ""
            ]
                .join(" ")
                .toLowerCase();

            if (!searchable.includes(query)) {
                continue;
            }
        }

        result.push(i);
    }

    return result;
}


function getAutomaticSongIndexes() {

    const result = [];

    for (let i = 0; i < songs.length; i++) {

        const song = songs[i];

        if (!song) {
            continue;
        }

        if (
            activeArtist !== "all" &&
            getSongArtist(song).toLowerCase() !==
                activeArtist.toLowerCase()
        ) {
            continue;
        }

        result.push(i);
    }

    return result;
}


function getNextSmartSongIndex() {

    const pool = getAutomaticSongIndexes();

    if (pool.length === 0) {
        return -1;
    }

    if (pool.length === 1) {
        return pool[0];
    }

    const todayPlayed =
        getDailyPlayedIds();

    let candidateIndexes =
        pool.filter(
            idx =>
                !todayPlayed.includes(
                    songs[idx]?.id
                )
        );

    // If every song has already been played today,
    // start a fresh cycle.
    if (candidateIndexes.length === 0) {
        candidateIndexes = pool.slice();
    }

    // Remove invalid queue entries.
    unplayedQueue =
        unplayedQueue.filter(
            idx =>
                candidateIndexes.includes(idx)
        );

    // Build a new shuffled queue.
    if (unplayedQueue.length === 0) {

        unplayedQueue =
            candidateIndexes.filter(
                idx => idx !== currentIndex
            );

        if (unplayedQueue.length === 0) {
            unplayedQueue =
                candidateIndexes.slice();
        }

        for (
            let i = unplayedQueue.length - 1;
            i > 0;
            i--
        ) {

            const j =
                Math.floor(
                    Math.random() * (i + 1)
                );

            [
                unplayedQueue[i],
                unplayedQueue[j]
            ] = [
                unplayedQueue[j],
                unplayedQueue[i]
            ];
        }
    }

    let chosenPointer = 0;

    // Try to vary directors.
    if (
        activeArtist === "all" &&
        unplayedQueue.length > 1
    ) {

        const currentDirector =
            songs[currentIndex]
                ? getSongArtist(
                      songs[currentIndex]
                  )
                : null;

        const diffIndex =
            unplayedQueue.findIndex(
                idx =>
                    getSongArtist(
                        songs[idx]
                    ) !== currentDirector
            );

        if (diffIndex !== -1) {
            chosenPointer = diffIndex;
        }
    }

    return unplayedQueue.splice(
        chosenPointer,
        1
    )[0];
}


function formatTime(seconds) {

    if (
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return "0:00";
    }

    const minutes =
        Math.floor(seconds / 60);

    const remaining =
        Math.floor(seconds % 60);

    return `${minutes}:${String(
        remaining
    ).padStart(2, "0")}`;
}


// ============================================================
// PLAYER UI
// ============================================================

function updatePlayerInformation(song) {

    const title =
        document.getElementById(
            "playerTitle"
        );

    const artist =
        document.getElementById(
            "playerArtist"
        );

    if (!song) {

        if (title) {
            title.textContent =
                "No track playing";
        }

        if (artist) {
            artist.textContent =
                "Select a song from your library";
        }

        return;
    }

    if (title) {
        title.textContent =
            getSongTitle(song);
    }

    if (artist) {
        artist.textContent =
            getSongArtist(song);
    }
}


function updatePlayButton() {

    const button =
        document.getElementById(
            "playBtn"
        );

    if (!button) {
        return;
    }

    button.textContent =
        audio.paused
            ? "▶"
            : "❚❚";
}


// ============================================================
// PLAYBACK TIMER CLEANUP
// ============================================================

function clearPlaybackTimers() {

    if (playbackWatchdog) {
        clearTimeout(
            playbackWatchdog
        );

        playbackWatchdog = null;
    }

    if (transitionTimer) {
        clearTimeout(
            transitionTimer
        );

        transitionTimer = null;
    }

    if (playTimeoutTimer) {
        clearTimeout(
            playTimeoutTimer
        );

        playTimeoutTimer = null;
    }
}


function clearPlaybackWatchdog() {

    if (playbackWatchdog) {

        clearTimeout(
            playbackWatchdog
        );

        playbackWatchdog = null;
    }
}


// ============================================================
// WAIT FOR AUDIO TO BECOME READY
// ============================================================

function waitForAudioReady(
    generation,
    index,
    timeout = 15000
) {

    return new Promise(resolve => {

        if (
            generation !== playbackGeneration ||
            index !== currentIndex
        ) {
            resolve(false);
            return;
        }

        // Already ready.
        if (
            audio.readyState >=
            HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
            resolve(true);
            return;
        }

        let finished = false;

        const cleanup = () => {

            audio.removeEventListener(
                "canplay",
                onReady
            );

            audio.removeEventListener(
                "canplaythrough",
                onReady
            );

            audio.removeEventListener(
                "loadeddata",
                onReady
            );

            audio.removeEventListener(
                "error",
                onError
            );

            if (timer) {
                clearTimeout(timer);
            }
        };

        const finish = value => {

            if (finished) {
                return;
            }

            finished = true;

            cleanup();

            resolve(value);
        };

        const onReady = () => {

            if (
                generation !== playbackGeneration ||
                index !== currentIndex
            ) {
                finish(false);
                return;
            }

            finish(true);
        };

        const onError = () => {
            finish(false);
        };

        audio.addEventListener(
            "canplay",
            onReady
        );

        audio.addEventListener(
            "canplaythrough",
            onReady
        );

        audio.addEventListener(
            "loadeddata",
            onReady
        );

        audio.addEventListener(
            "error",
            onError
        );

        const timer = setTimeout(() => {

            console.warn(
                "Audio readiness timeout."
            );

            finish(
                generation ===
                    playbackGeneration &&
                index === currentIndex
            );

        }, timeout);
    });
}


// ============================================================
// PLAYBACK WATCHDOG
// ============================================================

function armPlaybackWatchdog(
    generation,
    index
) {

    clearPlaybackWatchdog();

    lastProgressTime = Date.now();
    lastProgressValue =
        audio.currentTime || 0;

    const check = () => {

        if (
            generation !==
                playbackGeneration ||
            index !== currentIndex
        ) {
            return;
        }

        if (
            audio.paused ||
            audio.ended
        ) {
            return;
        }

        const now = Date.now();

        const current =
            audio.currentTime || 0;

        const progressed =
            current >
            lastProgressValue + 0.15;

        if (progressed) {

            lastProgressValue =
                current;

            lastProgressTime =
                now;
        }

        /*
         * IMPORTANT:
         *
         * Do not skip after 12 seconds.
         *
         * Mobile Chrome can temporarily stop
         * delivering timeupdate events while
         * decoding a large/local audio Blob.
         *
         * We now allow a much longer recovery
         * period before declaring the track stuck.
         */

        const stalledFor =
            now - lastProgressTime;

        if (
            stalledFor >= 30000 &&
            !audio.seeking
        ) {

            console.warn(
                "Playback appears stuck after 30 seconds. Recovering."
            );

            clearPlaybackWatchdog();

            if (
                generation ===
                playbackGeneration
            ) {

                playbackGeneration++;

                recoverFromStuckTrack(
                    index
                );
            }

            return;
        }

        playbackWatchdog =
            setTimeout(
                check,
                3000
            );
    };

    playbackWatchdog =
        setTimeout(
            check,
            3000
        );
}


// ============================================================
// RECOVER FROM A STUCK TRACK
// ============================================================

async function recoverFromStuckTrack(
    failedIndex
) {

    if (isTransitioning) {
        return;
    }

    console.warn(
        "Recovering playback from:",
        getSongTitle(
            songs[failedIndex]
        )
    );

    try {

        audio.pause();

        audio.removeAttribute(
            "src"
        );

        audio.load();

    } catch (e) {}

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                250
            )
    );

    if (
        failedIndex ===
        currentIndex
    ) {
        await playNextAutomaticSong();
    }
}


// ============================================================
// PLAY A SONG
// ============================================================

async function playSongAtIndex(
    index,
    isAuto = false
) {

    if (
        index < 0 ||
        index >= songs.length
    ) {
        return false;
    }

    const song = songs[index];

    if (!song) {
        return false;
    }

    const source =
        getSongSource(song);

    if (!source) {

        console.warn(
            "Unplayable track source:",
            song
        );

        return false;
    }

    /*
     * Every new playback gets a unique
     * generation number.
     *
     * This prevents old promises/events
     * from controlling a newer song.
     */

    const currentGen =
        ++playbackGeneration;

    clearPlaybackTimers();

    activePlayPromise = null;

    try {

        audio.pause();

    } catch (e) {}

    try {

        audio.removeAttribute(
            "src"
        );

        audio.load();

    } catch (e) {}

    currentIndex = index;

    updatePlayerInformation(song);

    renderSongList();

    /*
     * Set source only after the previous
     * source has been completely detached.
     */

    try {

        audio.src = source;

        audio.preload = "auto";

        audio.load();

    } catch (error) {

        console.error(
            "Could not load audio source:",
            error
        );

        return false;
    }

    markSongPlayedToday(
        song.id
    );

    /*
     * Wait until the browser has decoded
     * enough data before starting playback.
     */

    const ready =
        await waitForAudioReady(
            currentGen,
            index,
            15000
        );

    if (
        currentGen !==
            playbackGeneration ||
        index !== currentIndex
    ) {
        return false;
    }

    /*
     * If readiness timed out, still allow
     * play() to make the final decision.
     * Some local Blob audio files report
     * readyState slowly.
     */

    try {

        const playPromise =
            audio.play();

        activePlayPromise =
            playPromise;

        /*
         * Do not allow a permanently pending
         * play() promise to block automatic
         * playback forever.
         */

        const playResult =
            await Promise.race([

                playPromise.then(
                    () => "played"
                ),

                new Promise(resolve => {

                    playTimeoutTimer =
                        setTimeout(
                            () =>
                                resolve(
                                    "timeout"
                                ),
                            15000
                        );
                })
            ]);

        if (playTimeoutTimer) {

            clearTimeout(
                playTimeoutTimer
            );

            playTimeoutTimer = null;
        }

        if (
            activePlayPromise ===
            playPromise
        ) {
            activePlayPromise =
                null;
        }

        if (
            currentGen !==
                playbackGeneration ||
            index !== currentIndex
        ) {
            return false;
        }

        if (
            playResult ===
            "timeout"
        ) {

            console.warn(
                "play() timed out:",
                getSongTitle(song)
            );

            /*
             * Force a clean source reset.
             * The next automatic song can then
             * take over.
             */

            try {

                audio.pause();

                audio.removeAttribute(
                    "src"
                );

                audio.load();

            } catch (e) {}

            return false;
        }

        updatePlayButton();

        updateMediaSession(
            song
        );

        armPlaybackWatchdog(
            currentGen,
            index
        );

        return true;

    } catch (error) {

        if (
            playTimeoutTimer
        ) {

            clearTimeout(
                playTimeoutTimer
            );

            playTimeoutTimer =
                null;
        }

        if (
            activePlayPromise
            ===
            activePlayPromise
        ) {
            activePlayPromise =
                null;
        }

        /*
         * AbortError is normal when the
         * source is intentionally changed.
         */

        if (
            error?.name !==
            "AbortError"
        ) {

            console.warn(
                "Playback error:",
                error
            );
        }

        clearPlaybackTimers();

        if (
            currentGen !==
            playbackGeneration
        ) {
            return false;
        }

        if (isAuto) {
            return false;
        }

        updatePlayButton();

        return false;
    }
}


// ============================================================
// AUTOMATIC NEXT SONG
// ============================================================

async function playNextAutomaticSong() {

    if (isTransitioning) {
        return;
    }

    isTransitioning = true;

    clearPlaybackTimers();

    try {

        const pool =
            getAutomaticSongIndexes();

        if (pool.length === 0) {
            return;
        }

        /*
         * IMPORTANT:
         *
         * The old code only tried 8 tracks.
         *
         * If a large library had several temporary
         * playback failures, it could stop.
         *
         * Now every available track can be tried
         * once before giving up.
         */

        const maxAttempts =
            Math.max(
                pool.length,
                1
            );

        let attempts = 0;

        const attempted =
            new Set();

        while (
            attempts <
                maxAttempts
        ) {

            attempts++;

            let nextIdx =
                getNextSmartSongIndex();

            /*
             * Never repeatedly try the same
             * index during one transition.
             */

            if (
                nextIdx !== -1 &&
                attempted.has(nextIdx)
            ) {

                const alternative =
                    pool.find(
                        idx =>
                            !attempted.has(
                                idx
                            )
                    );

                if (
                    alternative !==
                    undefined
                ) {
                    nextIdx =
                        alternative;
                }
            }

            if (nextIdx === -1) {
                break;
            }

            attempted.add(
                nextIdx
            );

            const success =
                await playSongAtIndex(
                    nextIdx,
                    true
                );

            if (success) {
                return;
            }

            /*
             * Small pause between failed
             * source transitions. This prevents
             * Chrome from receiving many rapid
             * load/play/load/play commands.
             */

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        150
                    )
            );
        }

        /*
         * Final sequential fallback.
         */

        if (pool.length > 1) {

            let fallbackIndex =
                pool.indexOf(
                    currentIndex
                );

            if (
                fallbackIndex <
                0
            ) {
                fallbackIndex = 0;
            }

            for (
                let i = 1;
                i <= pool.length;
                i++
            ) {

                const candidate =
                    pool[
                        (
                            fallbackIndex +
                            i
                        ) % pool.length
                    ];

                if (
                    candidate ===
                    currentIndex &&
                    pool.length > 1
                ) {
                    continue;
                }

                const success =
                    await playSongAtIndex(
                        candidate,
                        true
                    );

                if (success) {
                    return;
                }
            }
        }

        console.warn(
            "No playable next track was found."
        );

    } finally {

        isTransitioning =
            false;
    }
}


// ============================================================
// PLAY / PAUSE
// ============================================================

async function togglePlay() {

    if (
        currentIndex === -1 ||
        !audio.src
    ) {

        await playNextAutomaticSong();

        return;
    }

    if (audio.paused) {

        try {

            await audio.play();

            updatePlayButton();

            armPlaybackWatchdog(
                playbackGeneration,
                currentIndex
            );

        } catch (e) {

            console.warn(
                "Resume failed:",
                e
            );

            await playNextAutomaticSong();
        }

    } else {

        audio.pause();
    }

    updatePlayButton();
}


// ============================================================
// NEXT
// ============================================================

function nextSong() {

    if (isTransitioning) {
        return;
    }

    playNextAutomaticSong();
}


// ============================================================
// PREVIOUS
// ============================================================

async function prevSong() {

    if (isTransitioning) {
        return;
    }

    const filtered =
        getFilteredSongIndexes();

    if (filtered.length === 0) {
        return;
    }

    const pos =
        filtered.indexOf(
            currentIndex
        );

    const prevIndex =
        pos <= 0
            ? filtered[
                  filtered.length - 1
              ]
            : filtered[pos - 1];

    await playSongAtIndex(
        prevIndex,
        false
    );
}


// ============================================================
// EDIT SONG
// ============================================================

async function editSong(index) {

    const song =
        songs[index];

    if (!song) {
        return;
    }

    const newTitle =
        prompt(
            "Edit song title:",
            getSongTitle(song)
        );

    if (newTitle === null) {
        return;
    }

    const newDirector =
        prompt(
            "Edit music director:",
            getSongArtist(song)
        );

    if (newDirector === null) {
        return;
    }

    song.title =
        newTitle.trim() ||
        song.title;

    song.artist =
        newDirector.trim()
            .toUpperCase() ||
        song.artist;

    song.director =
        song.artist;

    if (
        song.id !== undefined &&
        song.id !== null
    ) {

        await updateTrackInDB(
            song
        );
    }

    updateArtistFilter();

    renderSongList();

    if (
        currentIndex === index
    ) {

        updatePlayerInformation(
            song
        );

        updateMediaSession(
            song
        );
    }
}


// ============================================================
// DELETE SONG
// ============================================================

async function deleteSong(index) {

    const song =
        songs[index];

    if (!song) {
        return;
    }

    const confirmDelete =
        confirm(
            `Are you sure you want to delete "${getSongTitle(song)}"?`
        );

    if (!confirmDelete) {
        return;
    }

    if (
        song.id !== undefined &&
        song.id !== null
    ) {

        await deleteTrackFromDB(
            song.id
        );
    }

    if (
        currentIndex === index
    ) {

        clearPlaybackTimers();

        playbackGeneration++;

        try {

            audio.pause();

            audio.removeAttribute(
                "src"
            );

            audio.load();

        } catch (e) {}

        currentIndex = -1;

        updatePlayerInformation(
            null
        );

        updatePlayButton();

    } else if (
        currentIndex > index
    ) {

        currentIndex--;
    }

    songs.splice(
        index,
        1
    );

    unplayedQueue =
        unplayedQueue
            .filter(
                idx =>
                    idx !== index
            )
            .map(
                idx =>
                    idx > index
                        ? idx - 1
                        : idx
            );

    updateArtistFilter();

    updateSongCount();

    renderSongList();
}


// ============================================================
// MEDIA SESSION
// ============================================================

function updateMediaSession(song) {

    if (
        !("mediaSession" in navigator) ||
        !song
    ) {
        return;
    }

    try {

        navigator.mediaSession.metadata =
            new MediaMetadata({
                title:
                    getSongTitle(song),

                artist:
                    getSongArtist(song),

                album:
                    "Rishi Music"
            });

        updateMediaPosition();

    } catch (e) {}
}


function updateMediaPosition() {

    if (
        !("mediaSession" in navigator)
    ) {
        return;
    }

    if (
        !Number.isFinite(
            audio.duration
        ) ||
        audio.duration <= 0
    ) {
        return;
    }

    try {

        if (
            "setPositionState" in
            navigator.mediaSession
        ) {

            navigator.mediaSession
                .setPositionState({
                    duration:
                        audio.duration,

                    playbackRate:
                        audio.playbackRate ||
                        1,

                    position:
                        Math.min(
                            audio.currentTime,
                            audio.duration
                        )
                });
        }

    } catch (e) {}
}


function setupMediaSession() {

    if (
        !("mediaSession" in navigator)
    ) {
        return;
    }

    try {

        navigator.mediaSession
            .setActionHandler(
                "play",
                () => togglePlay()
            );

        navigator.mediaSession
            .setActionHandler(
                "pause",
                () => {

                    audio.pause();

                    updatePlayButton();
                }
            );

        navigator.mediaSession
            .setActionHandler(
                "nexttrack",
                () => nextSong()
            );

        navigator.mediaSession
            .setActionHandler(
                "previoustrack",
                () => prevSong()
            );

    } catch (e) {}

    try {

        navigator.mediaSession
            .setActionHandler(
                "seekforward",
                details => {

                    const skip =
                        details.seekOffset ||
                        10;

                    audio.currentTime =
                        Math.min(
                            audio.duration ||
                                0,
                            audio.currentTime +
                                skip
                        );

                    updateMediaPosition();
                }
            );

        navigator.mediaSession
            .setActionHandler(
                "seekbackward",
                details => {

                    const skip =
                        details.seekOffset ||
                        10;

                    audio.currentTime =
                        Math.max(
                            0,
                            audio.currentTime -
                                skip
                        );

                    updateMediaPosition();
                }
            );

        navigator.mediaSession
            .setActionHandler(
                "seekto",
                details => {

                    if (
                        details.seekTime !==
                            undefined &&
                        Number.isFinite(
                            details.seekTime
                        )
                    ) {

                        audio.currentTime =
                            details.seekTime;

                        updateMediaPosition();
                    }
                }
            );

    } catch (e) {}
}


// ============================================================
// ARTIST FILTER
// ============================================================

function getArtists() {

    const artists =
        new Set();

    songs.forEach(
        song => {

            const artist =
                getSongArtist(song);

            if (
                artist &&
                artist !==
                    "UNKNOWN ARTIST" &&
                artist !==
                    "UNKNOWN DIRECTOR"
            ) {

                artists.add(
                    artist
                );
            }
        }
    );

    return Array.from(
        artists
    ).sort(
        (a, b) =>
            a.localeCompare(b)
    );
}


function updateArtistFilter() {

    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (!filter) {
        return;
    }

    filter.innerHTML = "";

    const allOption =
        document.createElement(
            "option"
        );

    allOption.value = "all";

    allOption.textContent =
        "ALL DIRECTORS";

    filter.appendChild(
        allOption
    );

    getArtists().forEach(
        artist => {

            const option =
                document.createElement(
                    "option"
                );

            option.value =
                artist;

            option.textContent =
                artist;

            filter.appendChild(
                option
            );
        }
    );

    const exists =
        Array.from(
            filter.options
        ).some(
            opt =>
                opt.value ===
                activeArtist
        );

    filter.value =
        exists
            ? activeArtist
            : "all";

    activeArtist =
        filter.value;
}


function updateSongCount() {

    const count =
        document.getElementById(
            "trackCountBadge"
        );

    if (count) {

        count.textContent =
            `${songs.length} song${
                songs.length === 1
                    ? ""
                    : "s"
            }`;
    }
}


// ============================================================
// RENDER SONG LIST
// ============================================================

function renderSongList() {

    const container =
        document.getElementById(
            "songListContainer"
        ) ||
        document.querySelector(
            ".song-list"
        );

    if (!container) {
        return;
    }

    const filtered =
        getFilteredSongIndexes();

    container.innerHTML = "";

    if (
        filtered.length === 0
    ) {

        const empty =
            document.createElement(
                "div"
            );

        empty.className =
            "empty-library";

        empty.style.padding =
            "24px";

        empty.style.textAlign =
            "center";

        empty.style.color =
            "rgba(255,255,255,0.5)";

        empty.textContent =
            songs.length === 0
                ? "No songs uploaded yet"
                : "No songs found";

        container.appendChild(
            empty
        );

        return;
    }

    const todayPlayed =
        getDailyPlayedIds();

    filtered.forEach(
        index => {

            const song =
                songs[index];

            const isCurrent =
                index ===
                currentIndex;

            const isPlaying =
                isCurrent &&
                !audio.paused;

            const playedToday =
                todayPlayed.includes(
                    song.id
                );

            const card =
                document.createElement(
                    "div"
                );

            card.className =
                "song-card" +
                (
                    isCurrent
                        ? " active"
                        : ""
                );

            card.style.display =
                "flex";

            card.style.alignItems =
                "center";

            card.style.justifyContent =
                "space-between";

            card.style.padding =
                "12px 16px";

            card.style.marginBottom =
                "8px";

            card.style.borderRadius =
                "14px";

            card.style.cursor =
                "pointer";

            card.style.transition =
                "all 0.25s ease";

            card.style.background =
                isCurrent
                    ? "linear-gradient(90deg, rgba(0, 150, 255, 0.22) 0%, rgba(14, 22, 36, 0.95) 100%)"
                    : "rgba(18, 22, 28, 0.85)";

            card.style.border =
                isCurrent
                    ? "1px solid rgba(0, 210, 255, 0.45)"
                    : "1px solid rgba(255, 255, 255, 0.05)";

            card.style.borderLeft =
                isCurrent
                    ? "4.5px solid #00d2ff"
                    : "4.5px solid transparent";

            card.style.boxShadow =
                isCurrent
                    ? "-4px 0 16px rgba(0, 210, 255, 0.4)"
                    : "none";


            // ------------------------------------------------
            // SONG INFORMATION
            // ------------------------------------------------

            const info =
                document.createElement(
                    "div"
                );

            info.className =
                "song-info";

            info.style.display =
                "flex";

            info.style.alignItems =
                "center";

            info.style.gap =
                "12px";

            info.style.overflow =
                "hidden";

            info.style.flex =
                "1";


            const icon =
                document.createElement(
                    "span"
                );

            icon.className =
                "song-icon";

            icon.textContent =
                "♫";

            icon.style.color =
                isCurrent
                    ? "#00d2ff"
                    : "#5a6e85";

            icon.style.fontSize =
                "1.1rem";

            icon.style.textShadow =
                isCurrent
                    ? "0 0 10px rgba(0, 210, 255, 0.8)"
                    : "none";


            const meta =
                document.createElement(
                    "div"
                );

            meta.className =
                "song-meta";

            meta.style.overflow =
                "hidden";


            const title =
                document.createElement(
                    "h4"
                );

            title.textContent =
                getSongTitle(song);

            title.style.margin =
                "0";

            title.style.fontSize =
                "0.95rem";

            title.style.fontWeight =
                "600";

            title.style.color =
                isCurrent
                    ? "#70e1ff"
                    : "#ffffff";

            title.style.whiteSpace =
                "nowrap";

            title.style.overflow =
                "hidden";

            title.style.textOverflow =
                "ellipsis";


            const artist =
                document.createElement(
                    "p"
                );

            artist.textContent =
                getSongArtist(song) +
                (
                    playedToday
                        ? " • PLAYED TODAY"
                        : ""
                );

            artist.style.margin =
                "2px 0 0 0";

            artist.style.fontSize =
                "0.75rem";

            artist.style.color =
                "#72849a";

            artist.style.whiteSpace =
                "nowrap";

            artist.style.overflow =
                "hidden";

            artist.style.textOverflow =
                "ellipsis";


            meta.appendChild(
                title
            );

            meta.appendChild(
                artist
            );

            info.appendChild(
                icon
            );

            info.appendChild(
                meta
            );


            // ------------------------------------------------
            // ACTION BUTTONS
            // ------------------------------------------------

            const actions =
                document.createElement(
                    "div"
                );

            actions.className =
                "song-actions";

            actions.style.display =
                "flex";

            actions.style.alignItems =
                "center";

            actions.style.gap =
                "8px";


            // EDIT BUTTON

            const editBtn =
                document.createElement(
                    "button"
                );

            editBtn.type =
                "button";

            editBtn.className =
                "btn-edit-action";

            editBtn.innerHTML =
                "✎ Edit";

            editBtn.style.padding =
                "6px 12px";

            editBtn.style.fontSize =
                "0.72rem";

            editBtn.style.fontWeight =
                "700";

            editBtn.style.color =
                "#8be3ff";

            editBtn.style.background =
                "linear-gradient(135deg, rgba(0, 180, 255, 0.2), rgba(0, 90, 200, 0.15))";

            editBtn.style.border =
                "1px solid rgba(0, 210, 255, 0.4)";

            editBtn.style.borderRadius =
                "20px";

            editBtn.style.cursor =
                "pointer";

            editBtn.style.backdropFilter =
                "blur(6px)";

            editBtn.style.boxShadow =
                "inset 0 1px 1px rgba(255,255,255,0.25)";

            editBtn.onclick =
                e => {

                    e.stopPropagation();

                    editSong(index);
                };


            // DELETE BUTTON

            const deleteBtn =
                document.createElement(
                    "button"
                );

            deleteBtn.type =
                "button";

            deleteBtn.className =
                "btn-delete-action";

            deleteBtn.innerHTML =
                "🗑";

            deleteBtn.title =
                "Delete track";

            deleteBtn.style.width =
                "32px";

            deleteBtn.style.height =
                "32px";

            deleteBtn.style.borderRadius =
                "50%";

            deleteBtn.style.display =
                "flex";

            deleteBtn.style.alignItems =
                "center";

            deleteBtn.style.justifyContent =
                "center";

            deleteBtn.style.fontSize =
                "0.85rem";

            deleteBtn.style.color =
                "#ff7b88";

            deleteBtn.style.background =
                "linear-gradient(135deg, rgba(255, 60, 80, 0.2), rgba(180, 20, 40, 0.12))";

            deleteBtn.style.border =
                "1px solid rgba(255, 80, 100, 0.35)";

            deleteBtn.style.cursor =
                "pointer";

            deleteBtn.style.boxShadow =
                "inset 0 1px 1px rgba(255,255,255,0.15)";

            deleteBtn.onclick =
                e => {

                    e.stopPropagation();

                    deleteSong(index);
                };


            // PLAY BUTTON

            const playButton =
                document.createElement(
                    "button"
                );

            playButton.type =
                "button";

            playButton.className =
                "play-mini";

            playButton.style.width =
                "36px";

            playButton.style.height =
                "36px";

            playButton.style.borderRadius =
                "50%";

            playButton.style.display =
                "flex";

            playButton.style.alignItems =
                "center";

            playButton.style.justifyContent =
                "center";

            playButton.style.border =
                "1px solid rgba(255, 255, 255, 0.4)";

            playButton.style.borderTop =
                "1px solid #ffffff";

            playButton.style.background =
                isPlaying
                    ? "linear-gradient(145deg, #00f0ff, #0072ce)"
                    : "linear-gradient(145deg, #2da0ff, #0056cc)";

            playButton.style.boxShadow =
                "inset 0 1px 2px rgba(255,255,255,0.6), 0 4px 12px rgba(0, 130, 255, 0.45)";

            playButton.style.color =
                "#fff";

            playButton.style.cursor =
                "pointer";

            playButton.textContent =
                isPlaying
                    ? "❚❚"
                    : "▶";

            playButton.onclick =
                e => {

                    e.stopPropagation();

                    if (isCurrent) {

                        togglePlay();

                    } else {

                        playSongAtIndex(
                            index,
                            false
                        );
                    }
                };


            actions.appendChild(
                editBtn
            );

            actions.appendChild(
                deleteBtn
            );

            actions.appendChild(
                playButton
            );

            card.appendChild(
                info
            );

            card.appendChild(
                actions
            );

            card.onclick =
                () =>
                    playSongAtIndex(
                        index,
                        false
                    );

            container.appendChild(
                card
            );
        }
    );
}


// ============================================================
// IMPORT SONGS
// ============================================================

async function importSongs(files) {

    if (
        !files ||
        files.length === 0
    ) {
        return;
    }

    if (!db) {

        alert(
            "Music library is still loading. Please try again."
        );

        return;
    }

    for (
        const file of files
    ) {

        if (
            !file.type.startsWith(
                "audio/"
            )
        ) {
            continue;
        }

        const defaultName =
            file.name
                .replace(
                    /\.[^/.]+$/,
                    ""
                )
                .trim();

        let songName =
            prompt(
                `Enter song name for "${file.name}":`,
                defaultName
            );

        if (
            songName === null
        ) {
            continue;
        }

        songName =
            songName.trim() ||
            defaultName;

        let musicDirector =
            prompt(
                `Enter music director for "${songName}":`,
                "Unknown Director"
            );

        if (
            musicDirector ===
            null
        ) {
            musicDirector =
                "Unknown Director";
        }

        musicDirector =
            musicDirector
                .trim()
                .toUpperCase() ||
            "UNKNOWN DIRECTOR";

        const track = {

            title:
                songName,

            name:
                file.name,

            artist:
                musicDirector,

            director:
                musicDirector,

            blob:
                file,

            type:
                file.type,

            size:
                file.size,

            createdAt:
                Date.now()
        };

        try {

            const id =
                await saveTrackToDB(
                    track
                );

            track.id =
                id;

            songs.push(
                track
            );

        } catch (e) {

            console.error(
                "Save error:",
                file.name,
                e
            );
        }
    }

    songs.sort(
        (a, b) =>
            (a.id || 0) -
            (b.id || 0)
    );

    unplayedQueue = [];

    updateArtistFilter();

    updateSongCount();

    renderSongList();

    const input =
        document.getElementById(
            "audioFileInput"
        );

    if (input) {
        input.value = "";
    }
}


// ============================================================
// AUDIO EVENTS
// ============================================================

audio.addEventListener(
    "play",
    () => {

        updatePlayButton();

        renderSongList();

        if (
            "mediaSession" in
            navigator
        ) {

            try {

                navigator.mediaSession
                    .playbackState =
                    "playing";

            } catch (e) {}
        }

        if (
            currentIndex >= 0
        ) {

            armPlaybackWatchdog(
                playbackGeneration,
                currentIndex
            );
        }
    }
);


audio.addEventListener(
    "pause",
    () => {

        /*
         * A normal user pause must NOT
         * automatically start another song.
         */

        clearPlaybackWatchdog();

        updatePlayButton();

        renderSongList();

        if (
            "mediaSession" in
            navigator
        ) {

            try {

                navigator.mediaSession
                    .playbackState =
                    "paused";

            } catch (e) {}
        }
    }
);


// ------------------------------------------------------------
// END OF SONG
// ------------------------------------------------------------

audio.addEventListener(
    "ended",
    () => {

        clearPlaybackTimers();

        /*
         * Only the current playback generation
         * is allowed to trigger next song.
         */

        if (
            isTransitioning
        ) {
            return;
        }

        playNextAutomaticSong();
    }
);


// ------------------------------------------------------------
// AUDIO ERROR
// ------------------------------------------------------------

audio.addEventListener(
    "error",
    event => {

        const mediaError =
            audio.error;

        console.error(
            "Audio error:",
            mediaError || event
        );

        clearPlaybackTimers();

        /*
         * Do not react to stale errors from an
         * old source that has already been replaced.
         */

        if (
            isTransitioning
        ) {
            return;
        }

        /*
         * Give the current track a chance to
         * recover before skipping it.
         */

        if (
            currentIndex >= 0 &&
            !audio.paused
        ) {

            const failedIndex =
                currentIndex;

            playbackGeneration++;

            recoverFromStuckTrack(
                failedIndex
            );

        } else {

            playNextAutomaticSong();
        }
    }
);


// ------------------------------------------------------------
// STALLED
// ------------------------------------------------------------

audio.addEventListener(
    "stalled",
    () => {

        console.warn(
            "Audio stalled. Waiting for recovery."
        );

        /*
         * Do NOT immediately skip.
         *
         * Local Blob audio can temporarily
         * stall while Chrome is decoding.
         */

        if (
            !audio.paused &&
            currentIndex >= 0
        ) {

            armPlaybackWatchdog(
                playbackGeneration,
                currentIndex
            );
        }
    }
);


// ------------------------------------------------------------
// WAITING
// ------------------------------------------------------------

audio.addEventListener(
    "waiting",
    () => {

        console.warn(
            "Audio waiting for data."
        );

        /*
         * Do not call nextSong here.
         * The watchdog handles genuine stalls.
         */
    }
);


// ------------------------------------------------------------
// CAN PLAY
// ------------------------------------------------------------

audio.addEventListener(
    "canplay",
    () => {

        if (
            !audio.paused &&
            currentIndex >= 0
        ) {

            armPlaybackWatchdog(
                playbackGeneration,
                currentIndex
            );
        }
    }
);


// ------------------------------------------------------------
// LOADED METADATA
// ------------------------------------------------------------

audio.addEventListener(
    "loadedmetadata",
    () => {

        const totalTime =
            document.getElementById(
                "totalTime"
            );

        if (totalTime) {

            totalTime.textContent =
                formatTime(
                    audio.duration
                );
        }

        updateMediaPosition();
    }
);


// ------------------------------------------------------------
// TIME UPDATE
// ------------------------------------------------------------

audio.addEventListener(
    "timeupdate",
    () => {

        const currentTime =
            document.getElementById(
                "currentTime"
            );

        const progressBar =
            document.getElementById(
                "progressBar"
            );

        if (currentTime) {

            currentTime.textContent =
                formatTime(
                    audio.currentTime
                );
        }

        if (
            progressBar &&
            Number.isFinite(
                audio.duration
            ) &&
            audio.duration > 0
        ) {

            progressBar.value =
                (
                    audio.currentTime /
                    audio.duration
                ) * 100;
        }

        lastProgressValue =
            audio.currentTime || 0;

        lastProgressTime =
            Date.now();

        updateMediaPosition();
    }
);


// ------------------------------------------------------------
// PROGRESS / DURATION CHANGED
// ------------------------------------------------------------

audio.addEventListener(
    "durationchange",
    () => {

        updateMediaPosition();
    }
);


// ============================================================
// CONTROL SETUP
// ============================================================

function setupControls() {

    const importInput =
        document.getElementById(
            "audioFileInput"
        );

    if (importInput) {

        importInput.addEventListener(
            "change",
            e => {

                importSongs(
                    Array.from(
                        e.target.files
                    )
                );
            }
        );
    }


    document
        .getElementById(
            "playBtn"
        )
        ?.addEventListener(
            "click",
            togglePlay
        );


    document
        .getElementById(
            "nextBtn"
        )
        ?.addEventListener(
            "click",
            nextSong
        );


    document
        .getElementById(
            "prevBtn"
        )
        ?.addEventListener(
            "click",
            prevSong
        );


    const searchInput =
        document.getElementById(
            "searchInput"
        );

    if (searchInput) {

        searchInput.addEventListener(
            "input",
            () => {

                searchQuery =
                    searchInput.value;

                renderSongList();
            }
        );
    }


    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (filter) {

        filter.addEventListener(
            "change",
            () => {

                activeArtist =
                    filter.value;

                unplayedQueue =
                    [];

                renderSongList();
            }
        );
    }


    const progressBar =
        document.getElementById(
            "progressBar"
        );

    if (progressBar) {

        progressBar.addEventListener(
            "input",
            () => {

                if (
                    Number.isFinite(
                        audio.duration
                    ) &&
                    audio.duration > 0
                ) {

                    audio.currentTime =
                        (
                            Number(
                                progressBar.value
                            ) / 100
                        ) *
                        audio.duration;
                }
            }
        );
    }


    const muteBtn =
        document.getElementById(
            "muteBtn"
        );

    if (muteBtn) {

        muteBtn.addEventListener(
            "click",
            () => {

                audio.muted =
                    !audio.muted;

                muteBtn.textContent =
                    audio.muted
                        ? "🔇"
                        : "🔊";
            }
        );
    }


    const volumeBar =
        document.getElementById(
            "volumeBar"
        );

    if (volumeBar) {

        audio.volume =
            Number(
                volumeBar.value
            );

        volumeBar.addEventListener(
            "input",
            () => {

                audio.volume =
                    Number(
                        volumeBar.value
                    );

                audio.muted =
                    audio.volume === 0;
            }
        );
    }
}


// ============================================================
// INITIALIZE APP
// ============================================================

async function initializeApp() {

    try {

        /*
         * Ask the browser for persistent
         * storage.
         */

        if (
            navigator.storage &&
            navigator.storage.persist
        ) {

            try {

                await navigator.storage.persist();

            } catch (e) {

                console.warn(
                    "Persistent storage request failed:",
                    e
                );
            }
        }


        await openDatabase();


        songs =
            await loadAllTracksFromDB();


        songs.sort(
            (a, b) =>
                (a.id || 0) -
                (b.id || 0)
        );


        updateArtistFilter();

        updateSongCount();

        renderSongList();

        updatePlayerInformation(
            null
        );

        updatePlayButton();

        setupMediaSession();

    } catch (error) {

        console.error(
            "Initialization failed:",
            error
        );

        alert(
            "Rishi Music could not load the music library."
        );
    }
}


// ============================================================
// DOM READY
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        setupControls();

        await initializeApp();
    }
);


// ============================================================
// SERVICE WORKER
// ============================================================

if (
    "serviceWorker" in navigator
) {

    window.addEventListener(
        "load",
        () => {

            navigator.serviceWorker
                .register(
                    "./sw.js?v=7"
                )
                .catch(
                    error => {

                        console.warn(
                            "Service worker registration failed:",
                            error
                        );
                    }
                );
        }
    );
}


// ============================================================
// CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {

        clearPlaybackTimers();

        try {
            audio.pause();
        } catch (e) {}

        playbackGeneration++;

        activePlayPromise =
            null;
    }
);
