package dev.osmp.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.service.media.MediaBrowserService;

import android.media.MediaDescription;
import android.media.browse.MediaBrowser;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground media notification + lock-screen/Bluetooth transport controls
 * + Android Auto media browsing.
 *
 * Two playback paths share one MediaSession:
 *  • WebView mode — the page reports state through OsmpBridge.notifyMedia()
 *    and transport actions go back via window.__osmpMedia(action).
 *  • Native mode — used by Android Auto / AVRCP browsing when the Activity
 *    is not alive. The service streams from the server (session-cookie
 *    authed) with a MediaPlayer and owns its own queue.
 */
public class MediaService extends MediaBrowserService {

    private static final String CHANNEL = "osmp_playback";
    private static final int NOTIF_ID = 8790;

    private static final String ROOT = "root";
    private static final String ID_RECENT = "recent";
    private static final String ID_PLAYLISTS = "pl";
    private static final String ID_ARTISTS = "artists";
    private static final String ID_UPLOADS = "uploads";

    private static final long ACTIONS = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SKIP_TO_QUEUE_ITEM
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_PLAY_FROM_MEDIA_ID
            | PlaybackState.ACTION_PLAY_FROM_SEARCH;

    private static MediaService instance;
    private static MainActivity host;          // set by update()
    private static JSONObject lastState;
    private static String lastTitle = "", lastArtist = "", lastCover = "";

    private MediaSession session;
    private final ExecutorService artPool = Executors.newSingleThreadExecutor();
    private final ExecutorService browsePool = Executors.newSingleThreadExecutor();

    // ── native playback state ────────────────────────────────────────
    private MediaPlayer player;
    private boolean nativeActive = false;
    private boolean nativePrepared = false;
    private final List<JSONObject> nativeQueue = new ArrayList<>();
    private int nativePos = -1;
    private String nativeTitle = "", nativeArtist = "", nativeCover = "";
    private long nativeDurationMs = -1;
    private PowerManager.WakeLock nativeWake;
    private AudioManager audioMgr;
    private AudioFocusRequest focusRequest;
    private boolean resumeOnFocusGain = false;
    private boolean noisyRegistered = false;
    private final Handler tick = new Handler(Looper.getMainLooper());

    /** Browse results per parent, with the mediaId→parent link needed to
     *  rebuild the queue for whatever the user taps in the car. */
    private static class Node {
        final List<MediaBrowser.MediaItem> items;
        final List<JSONObject> tracks;
        final long at;
        Node(List<MediaBrowser.MediaItem> items, List<JSONObject> tracks) {
            this.items = items; this.tracks = tracks; this.at = System.currentTimeMillis();
        }
    }
    private static final long CACHE_TTL = 30_000L;
    private final Map<String, Node> childCache = new LinkedHashMap<>();
    private final Map<String, JSONObject> mediaIndex = new HashMap<>();
    private final Map<String, String> parentOf = new HashMap<>();

    // ── webview-mode plumbing (unchanged contract) ───────────────────

    public static void update(Context ctx, JSONObject state) {
        boolean playing = state != null && state.optBoolean("playing", false);
        if (instance != null && instance.nativeActive) {
            if (!playing) return;  // idle/pause report from a dormant page must not kill the car session
            // notifyMedia() runs on a WebView bridge thread — the player
            // lives on the main thread
            final MediaService s = instance;
            s.tick.post(s::stopNative);  // the page just started playing — it takes over
        }
        if (ctx instanceof MainActivity) {
            host = (MainActivity) ctx;
            // the wakelock tracks playback here — the web UI only ever asks
            // for it, so a pause must release it on this side
            host.setWakeLock(playing);
        }
        lastState = mergeState(state);
        Intent i = new Intent(ctx, MediaService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    /** Called from MainActivity.onDestroy() — the WebView is gone, so the
     *  notification's transport buttons would do nothing. Native (Auto)
     *  playback survives an app swipe by design. */
    public static void clearHost(MainActivity a) {
        if (host == a) host = null;
    }

    public static boolean isNativeActive() {
        MediaService s = instance;
        return s != null && s.nativeActive;
    }

    /** Fill missing fields from the last known state — a payload carrying
     *  only `playing` must never wipe the title/artist off the notification. */
    private static JSONObject mergeState(JSONObject st) {
        try {
            String t = st.optString("title", "");
            String ar = st.optString("artist", "");
            String c = st.optString("cover", "");
            if (!t.isEmpty()) lastTitle = t;
            if (!ar.isEmpty()) lastArtist = ar;
            if (!c.isEmpty()) lastCover = c;
            if (t.isEmpty()) st.put("title", lastTitle.isEmpty() ? "OSMP" : lastTitle);
            if (ar.isEmpty()) st.put("artist", lastArtist);
            if (c.isEmpty()) st.put("cover", lastCover);
        } catch (Exception ignored) { }
        return st;
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, MediaService.class));
    }

    // ── lifecycle ────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL, getString(R.string.notif_channel),
                    NotificationManager.IMPORTANCE_LOW));
        }
        audioMgr = (AudioManager) getSystemService(AUDIO_SERVICE);

        session = new MediaSession(this, "osmp");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { if (nativeActive) resumeNative(); else eval("play"); }
            @Override public void onPause() { if (nativeActive) pauseNative(); else eval("pause"); }
            @Override public void onSkipToNext() { if (nativeActive) nativeNext(1); else eval("next"); }
            @Override public void onSkipToPrevious() { if (nativeActive) nativeNext(-1); else eval("prev"); }
            @Override public void onStop() {
                if (nativeActive) { stopNative(); }
                else eval("stop");
                stopSelf();
            }
            @Override public void onSeekTo(long pos) {
                if (nativeActive) {
                    try { if (nativePrepared) player.seekTo((int) pos); } catch (Exception ignored) { }
                } else eval("seek:" + (pos / 1000));
            }
            @Override public void onSkipToQueueItem(long id) {
                if (!nativeActive) return;
                int i = (int) id;
                if (i >= 0 && i < nativeQueue.size()) { nativePos = i; playCurrent(); }
            }
            @Override public void onPlayFromMediaId(String mediaId, Bundle extras) {
                JSONObject t = mediaIndex.get(mediaId);
                if (t == null) {
                    t = new JSONObject();
                    try { t.put("id", mediaId); } catch (Exception ignored) { }
                }
                // queue = the browse list the item was served from, if we still have it
                String parent = parentOf.get(mediaId);
                Node n = parent == null ? null : childCache.get(parent);
                if (n != null) {
                    nativeQueue.clear();
                    nativeQueue.addAll(n.tracks);
                    nativePos = Math.max(0, n.tracks.indexOf(t));
                } else {
                    nativeQueue.clear();
                    nativeQueue.add(t);
                    nativePos = 0;
                }
                startCurrent();
            }
            @Override public void onPlayFromSearch(String query, Bundle extras) {
                final String q = query == null ? "" : query.trim();
                if (q.isEmpty()) { onPlay(); return; }
                browsePool.submit(() -> {
                    JSONObject r = fetchJson("/api/search?limit=25&q=" + enc(q));
                    JSONArray arr = r == null ? null : r.optJSONArray("results");
                    if (arr == null || arr.length() == 0) return;
                    final List<JSONObject> found = new ArrayList<>();
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject t = arr.optJSONObject(i);
                        if (t != null && !t.optBoolean("live", false)) found.add(t);
                    }
                    if (found.isEmpty()) return;
                    tick.post(() -> {
                        nativeQueue.clear();
                        nativeQueue.addAll(found);
                        nativePos = 0;
                        startCurrent();
                    });
                });
            }
        });
        session.setActive(true);
        // the framework token is what Auto / AVRCP clients bind to
        setSessionToken(session.getSessionToken());

        IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        registerReceiver(noisyReceiver, f);
        noisyRegistered = true;
    }

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            // headphones unplugged / BT disconnected — pause like every other player
            if (nativeActive) pauseNative();
            else eval("pause");
        }
    };

    private void eval(String action) {
        MainActivity a = host;
        if (a != null) a.evalJs("window.__osmpMedia && __osmpMedia('" + action + "')");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // transport actions from notification buttons (PendingIntent.getService)
        if (intent != null && intent.getAction() != null
                && intent.getAction().startsWith("transport:")) {
            String a = intent.getAction().substring("transport:".length());
            switch (a) {
                case "play": if (nativeActive) resumeNative(); else eval("play"); break;
                case "pause": if (nativeActive) pauseNative(); else eval("pause"); break;
                case "next": if (nativeActive) nativeNext(1); else eval("next"); break;
                case "prev": if (nativeActive) nativeNext(-1); else eval("prev"); break;
                default: eval(a); break;
            }
            return START_NOT_STICKY;
        }

        // A sticky restart after process death arrives with a null intent and
        // empty statics — startForeground() must still run within the system's
        // timeout or the service is killed with ForegroundServiceDidNotStart.
        if (nativeActive) {
            startForeground(NOTIF_ID, buildNotification(nativeTitle, nativeArtist,
                    isNativePlaying(), null));
            publishNativeState();
            return START_STICKY;
        }

        startForeground(NOTIF_ID, buildNotification(
                lastTitle.isEmpty() ? "OSMP" : lastTitle, lastArtist, false, null));

        JSONObject st = lastState;
        if (st == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean playing = st.optBoolean("playing", false);
        String title = st.optString("title", "OSMP");
        String artist = st.optString("artist", "");
        String cover = st.optString("cover", "");

        // media session metadata
        MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "OSMP");
        long dur = (long) (st.optDouble("dur", 0) * 1000);
        if (dur > 0) mb.putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
        session.setMetadata(mb.build());
        PlaybackState.Builder pb = new PlaybackState.Builder()
                .setActions(ACTIONS)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        (long) (st.optDouble("pos", 0) * 1000), playing ? 1f : 0f);
        session.setPlaybackState(pb.build());

        Notification n = buildNotification(title, artist, playing, null);
        startForeground(NOTIF_ID, n);

        // fetch cover art async and refresh
        if (!cover.isEmpty()) {
            final String url = cover;
            artPool.submit(() -> {
                Bitmap bmp = fetch(url);
                if (bmp == null) return;
                android.os.Handler h = new android.os.Handler(getMainLooper());
                h.post(() -> {
                    // the track changed while we were fetching — this art is
                    // stale and would repaint the notification with old text
                    if (instance == null || st != lastState) return;
                    try {
                        session.setMetadata(new MediaMetadata.Builder()
                                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                                .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp)
                                .build());
                        NotificationManager nm =
                                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                        nm.notify(NOTIF_ID, buildNotification(title, artist, playing, bmp));
                    } catch (Exception ignored) { }
                });
            });
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        // MediaBrowserService dispatches the browse binder; null for anything else
        return super.onBind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        artPool.shutdownNow();  // its single idle thread would leak per start/stop cycle
        browsePool.shutdownNow();
        tick.removeCallbacks(tickRunnable);
        if (noisyRegistered) {
            try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) { }
            noisyRegistered = false;
        }
        abandonFocus();
        if (player != null) {
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
        releaseNativeWake();
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        super.onDestroy();
    }

    // ── Android Auto / AVRCP browse tree ─────────────────────────────

    @Override
    public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        if (!trustedClient(clientPackageName)) return null;  // no tree for strangers
        return new BrowserRoot(ROOT, null);
    }

    /** Self, Android Auto, and anything platform-signed (Bluetooth/AVRCP,
     *  Automotive, system UI). Everyone else gets no root at all. */
    private boolean trustedClient(String pkg) {
        if (pkg == null) return false;
        if (pkg.equals(getPackageName())) return true;
        if ("com.google.android.projection.gearhead".equals(pkg)) return true;  // Android Auto
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(pkg, 0);
            return (ai.flags & (ApplicationInfo.FLAG_SYSTEM
                    | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @Override
    public void onLoadChildren(final String parentId, final Result<List<MediaBrowser.MediaItem>> result) {
        result.detach();  // answered async from browsePool
        browsePool.submit(() -> result.sendResult(loadChildren(parentId)));
    }

    @Override
    public void onLoadChildren(String parentId, Result<List<MediaBrowser.MediaItem>> result,
                               Bundle options) {
        onLoadChildren(parentId, result);
    }

    private List<MediaBrowser.MediaItem> loadChildren(String parentId) {
        if (ROOT.equals(parentId)) return rootItems();
        Node cached = childCache.get(parentId);
        if (cached != null && System.currentTimeMillis() - cached.at < CACHE_TTL) return cached.items;

        List<MediaBrowser.MediaItem> items = new ArrayList<>();
        List<JSONObject> tracks = new ArrayList<>();
        if (ID_RECENT.equals(parentId)) {
            JSONObject r = fetchJson("/api/history/log?limit=100");
            collectTracks(r == null ? null : r.optJSONArray("plays"), items, tracks, parentId);
        } else if (ID_PLAYLISTS.equals(parentId)) {
            JSONObject r = fetchJson("/api/playlists");
            JSONArray arr = r == null ? null : r.optJSONArray("playlists");
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject pl = arr.optJSONObject(i);
                if (pl == null) continue;
                String id = ID_PLAYLISTS + "/" + pl.optLong("id", -1);
                items.add(folder(id, pl.optString("name", "Playlist"),
                        pl.optInt("track_count", 0) + " tracks"));
                childCache.remove(id);  // playlist content may have changed
            }
        } else if (parentId.startsWith(ID_PLAYLISTS + "/")) {
            JSONObject r = fetchJson("/api/" + parentId);
            collectTracks(r == null ? null : r.optJSONArray("tracks"), items, tracks, parentId);
        } else if (ID_ARTISTS.equals(parentId)) {
            JSONObject r = fetchJson("/api/artists?limit=200");
            JSONArray arr = r == null ? null : r.optJSONArray("artists");
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject a = arr.optJSONObject(i);
                if (a == null) continue;
                String name = a.optString("artist", "");
                if (name.isEmpty()) continue;
                String id = ID_ARTISTS + "/" + enc(name);
                items.add(folder(id, name, a.optInt("tracks", 0) + " tracks"));
            }
        } else if (parentId.startsWith(ID_ARTISTS + "/")) {
            String name = dec(parentId.substring(ID_ARTISTS.length() + 1));
            JSONObject r = fetchJson("/api/artist?name=" + enc(name));
            collectTracks(r == null ? null : r.optJSONArray("tracks"), items, tracks, parentId);
        } else if (ID_UPLOADS.equals(parentId)) {
            JSONObject r = fetchJson("/api/library?limit=500");
            collectTracks(r == null ? null : r.optJSONArray("tracks"), items, tracks, parentId);
        } else {
            return null;  // unknown parent → error shown client-side
        }

        if (items.isEmpty()) return items;  // don't cache failures (expired cookie etc.)
        cacheChildren(parentId, new Node(items, tracks));
        return items;
    }

    private List<MediaBrowser.MediaItem> rootItems() {
        List<MediaBrowser.MediaItem> out = new ArrayList<>();
        out.add(folder(ID_RECENT, "Recently played", ""));
        out.add(folder(ID_PLAYLISTS, "Playlists", ""));
        out.add(folder(ID_ARTISTS, "Artists", ""));
        out.add(folder(ID_UPLOADS, "Uploads", ""));
        return out;
    }

    private void collectTracks(JSONArray arr, List<MediaBrowser.MediaItem> items,
                               List<JSONObject> tracks, String parentId) {
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject t = arr.optJSONObject(i);
            if (t == null || t.optString("id", "").isEmpty()) continue;
            if (t.optBoolean("live", false)) continue;  // live streams don't belong in the car
            items.add(playable(t, parentId));
            tracks.add(t);
        }
    }

    private MediaBrowser.MediaItem folder(String id, String title, String subtitle) {
        MediaDescription.Builder d = new MediaDescription.Builder()
                .setMediaId(id)
                .setTitle(title)
                .setIconBitmap(folderIcon());
        if (subtitle != null && !subtitle.isEmpty()) d.setSubtitle(subtitle);
        return new MediaBrowser.MediaItem(d.build(), MediaBrowser.MediaItem.FLAG_BROWSABLE);
    }

    private Bitmap folderIcon() {
        // one tiny shared bitmap for category rows — cars need *an* icon or
        // some OEM renderers draw a broken-image box
        if (folderBmp == null) {
            folderBmp = Bitmap.createBitmap(new int[]{0xFF141A24}, 1, 1, Bitmap.Config.ARGB_8888);
        }
        return folderBmp;
    }
    private Bitmap folderBmp;

    private MediaBrowser.MediaItem playable(JSONObject t, String parentId) {
        String id = t.optString("id");
        mediaIndex.put(id, t);
        parentOf.put(id, parentId);
        MediaDescription.Builder d = new MediaDescription.Builder()
                .setMediaId(id)
                .setTitle(t.optString("title", id))
                .setIconUri(Uri.parse(t.optString("thumbnail", "")));
        String artist = t.optString("artist", "");
        if (!artist.isEmpty()) d.setSubtitle(artist);
        long dur = (long) (t.optDouble("duration", 0) * 1000);
        if (dur > 0) {
            Bundle ex = new Bundle();
            ex.putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
            d.setExtras(ex);
        }
        return new MediaBrowser.MediaItem(d.build(), MediaBrowser.MediaItem.FLAG_PLAYABLE);
    }

    private void cacheChildren(String parentId, Node n) {
        // keep the index/maps bounded — a long browsing session would
        // otherwise accumulate every track ever listed
        if (mediaIndex.size() > 3000) { mediaIndex.clear(); parentOf.clear(); }
        if (childCache.size() > 16) {
            String oldest = childCache.keySet().iterator().next();
            childCache.remove(oldest);
        }
        childCache.put(parentId, n);
    }

    // ── native playback (Auto / AVRCP without the WebView) ───────────

    /** Promote to a started service + foreground, take focus, play nativePos. */
    private void startCurrent() {
        boolean promoted = false;
        try {
            startService(new Intent(this, MediaService.class));
            promoted = true;
        } catch (Exception ignored) {
            // bound by a background client — keep playing without foreground
        }
        nativeActive = true;
        nativePrepared = false;
        nativeDurationMs = -1;
        if (promoted) startForeground(NOTIF_ID,
                buildNotification(currentTitle(), currentArtist(), false, null));
        requestFocus();
        acquireNativeWake();
        playCurrent();
    }

    private void playCurrent() {
        if (nativePos < 0 || nativePos >= nativeQueue.size()) return;
        JSONObject t = nativeQueue.get(nativePos);
        nativeTitle = t.optString("title", t.optString("id", "OSMP"));
        nativeArtist = t.optString("artist", "");
        nativeCover = t.optString("thumbnail", "");
        nativeDurationMs = (long) (t.optDouble("duration", 0) * 1000);

        releasePlayerOnly();
        nativePrepared = false;
        setNativeState(PlaybackState.STATE_BUFFERING, 0);

        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            // every /api path sits behind the auth gate — ride the WebView's
            // session cookie, same as the browser does
            Map<String, String> headers = new HashMap<>();
            String cookie = sessionCookie();
            if (cookie != null && !cookie.isEmpty()) headers.put("Cookie", cookie);
            player.setDataSource(this, Uri.parse(streamUrlFor(t)), headers);
            player.setOnPreparedListener(mp -> {
                nativePrepared = true;
                long dur = 0;
                try { dur = mp.getDuration(); } catch (Exception ignored) { }
                if (dur > 0) nativeDurationMs = dur;
                mp.start();
                publishNativeState();
                refreshNativeNotif();
                tick.removeCallbacks(tickRunnable);
                tick.post(tickRunnable);
            });
            player.setOnCompletionListener(mp -> nativeNext(1));
            player.setOnErrorListener((mp, what, extra) -> {
                android.util.Log.w("osmp.auto", "player error " + what + "/" + extra
                        + " on " + currentTitle());
                nativeNext(1);  // dead stream → try the next track
                return true;
            });
            player.prepareAsync();
            publishNativeState();
            refreshNativeNotif();
            publishQueue();
        } catch (Exception e) {
            android.util.Log.w("osmp.auto", "native playback failed", e);
            nativeNext(1);
        }
    }

    private String streamUrlFor(JSONObject t) {
        String base = serverUrl();
        String id = enc(t.optString("id", ""));
        // m4a/aac plays on every head unit — MediaPlayer also decodes the
        // opus/webm fallback when YouTube has no m4a audio
        if (t.optBoolean("offline", false)) return base + "/api/library/stream/" + id;
        return base + "/api/stream/" + id + "?fmt=m4a";
    }

    private void nativeNext(int dir) {
        if (nativeQueue.isEmpty()) { stopNative(); return; }
        int n = nativePos + dir;
        if (n >= nativeQueue.size()) { stopNative(); return; }  // end of queue
        if (n < 0) n = 0;
        nativePos = n;
        playCurrent();
    }

    private void resumeNative() {
        if (player != null && nativePrepared && !player.isPlaying()) {
            requestFocus();
            acquireNativeWake();
            try { player.start(); } catch (Exception ignored) { }
        }
        publishNativeState();
        refreshNativeNotif();
    }

    private void pauseNative() {
        if (player != null && player.isPlaying()) {
            try { player.pause(); } catch (Exception ignored) { }
        }
        releaseNativeWake();
        publishNativeState();
        refreshNativeNotif();
    }

    private boolean isNativePlaying() {
        try { return player != null && player.isPlaying(); }
        catch (Exception e) { return false; }
    }

    private void stopNative() {
        tick.removeCallbacks(tickRunnable);
        abandonFocus();
        releasePlayerOnly();
        releaseNativeWake();
        nativeActive = false;
        nativePrepared = false;
        nativeQueue.clear();
        nativePos = -1;
        nativeDurationMs = -1;
    }

    private void releasePlayerOnly() {
        if (player != null) {
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
    }

    private String currentTitle() { return nativeTitle.isEmpty() ? "OSMP" : nativeTitle; }
    private String currentArtist() { return nativeArtist; }

    private void publishQueue() {
        List<MediaSession.QueueItem> q = new ArrayList<>();
        for (int i = 0; i < nativeQueue.size() && i < 100; i++) {
            JSONObject t = nativeQueue.get(i);
            MediaDescription.Builder d = new MediaDescription.Builder()
                    .setMediaId(t.optString("id", String.valueOf(i)))
                    .setTitle(t.optString("title", ""));
            String artist = t.optString("artist", "");
            if (!artist.isEmpty()) d.setSubtitle(artist);
            q.add(new MediaSession.QueueItem(d.build(), i));
        }
        session.setQueue(q);
    }

    private final Runnable tickRunnable = new Runnable() {
        @Override public void run() {
            if (!nativeActive) return;
            publishNativeState();
            if (isNativePlaying()) tick.postDelayed(this, 1000);
        }
    };

    private void setNativeState(int state, int pos) {
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(ACTIONS)
                .setState(state, pos, state == PlaybackState.STATE_PLAYING ? 1f : 0f)
                .build());
    }

    private void publishNativeState() {
        if (session == null) return;
        if (!nativeActive) {
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(ACTIONS)
                    .setState(PlaybackState.STATE_STOPPED, 0, 0f)
                    .build());
            return;
        }
        int pos = 0;
        if (player != null && nativePrepared) {
            try { pos = player.getCurrentPosition(); } catch (Exception ignored) { }
        }
        int state = isNativePlaying() ? PlaybackState.STATE_PLAYING
                : (nativePrepared ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_BUFFERING);

        MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle())
                .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist())
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "OSMP");
        if (nativeDurationMs > 0) mb.putLong(MediaMetadata.METADATA_KEY_DURATION, nativeDurationMs);
        session.setMetadata(mb.build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(ACTIONS)
                .setState(state, pos, state == PlaybackState.STATE_PLAYING ? 1f : 0f)
                .build());
    }

    private void refreshNativeNotif() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, buildNotification(currentTitle(), currentArtist(),
                isNativePlaying(), null));
        final String cover = nativeCover;
        if (cover != null && !cover.isEmpty() && !cover.equals(lastCoverFetched)) {
            lastCoverFetched = cover;
            artPool.submit(() -> {
                Bitmap bmp = fetch(cover);
                if (bmp == null || !nativeActive) return;
                tick.post(() -> {
                    if (!nativeActive) return;
                    NotificationManager n2 =
                            (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    n2.notify(NOTIF_ID, buildNotification(currentTitle(), currentArtist(),
                            isNativePlaying(), bmp));
                });
            });
        }
    }
    private String lastCoverFetched = "";

    // ── audio focus + wake lock ──────────────────────────────────────

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            focus -> {
                switch (focus) {
                    case AudioManager.AUDIOFOCUS_LOSS:
                        resumeOnFocusGain = false;
                        abandonFocus();
                        pauseNative();
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                        resumeOnFocusGain = isNativePlaying();
                        pauseNative();
                        break;
                    case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                        if (player != null) try { player.setVolume(0.2f, 0.2f); }
                        catch (Exception ignored) { }
                        break;
                    case AudioManager.AUDIOFOCUS_GAIN:
                        if (player != null) try { player.setVolume(1f, 1f); }
                        catch (Exception ignored) { }
                        if (resumeOnFocusGain) { resumeOnFocusGain = false; resumeNative(); }
                        break;
                }
            };

    private void requestFocus() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                if (focusRequest == null) {
                    focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setOnAudioFocusChangeListener(focusListener)
                            .build();
                }
                audioMgr.requestAudioFocus(focusRequest);
            } else {
                audioMgr.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN);
            }
        } catch (Exception ignored) { }
    }

    private void abandonFocus() {
        try {
            if (Build.VERSION.SDK_INT >= 26 && focusRequest != null)
                audioMgr.abandonAudioFocusRequest(focusRequest);
            else
                audioMgr.abandonAudioFocus(focusListener);
        } catch (Exception ignored) { }
        focusRequest = null;
    }

    private void acquireNativeWake() {
        if (nativeWake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            nativeWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "osmp:auto");
        }
        if (!nativeWake.isHeld()) nativeWake.acquire(4 * 60 * 60 * 1000L);
    }

    private void releaseNativeWake() {
        if (nativeWake != null && nativeWake.isHeld()) nativeWake.release();
    }

    // ── server access ────────────────────────────────────────────────

    private String serverUrl() {
        SharedPreferences prefs = getSharedPreferences(SetupActivity.PREFS, MODE_PRIVATE);
        String u = prefs.getString(SetupActivity.KEY_URL, null);
        if (u != null && u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private String sessionCookie() {
        try {
            String base = serverUrl();
            if (base == null) return null;
            return android.webkit.CookieManager.getInstance().getCookie(base);
        } catch (Throwable t) {
            // no WebView provider in this process — auth-gated nodes just come back empty
            return null;
        }
    }

    /** GET path+query → parsed JSON, or null (any failure). */
    private JSONObject fetchJson(String pathAndQuery) {
        HttpURLConnection c = null;
        try {
            String base = serverUrl();
            if (base == null) return null;
            c = (HttpURLConnection) new URL(base + pathAndQuery).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Accept", "application/json");
            String cookie = sessionCookie();
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream();
                 Scanner sc = new Scanner(in).useDelimiter("\\A")) {
                return sc.hasNext() ? new JSONObject(sc.next()) : null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    private static String dec(String s) {
        try {
            return java.net.URLDecoder.decode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    // ── notification ─────────────────────────────────────────────────

    private Notification buildNotification(String title, String artist,
                                           boolean playing, Bitmap art) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(title)
                .setContentText(artist)
                .setContentIntent(pi)
                .setOngoing(playing)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(android.R.drawable.ic_media_previous, "Previous",
                        piFor("prev"))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", piFor(playing ? "pause" : "play"))
                .addAction(android.R.drawable.ic_media_next, "Next", piFor("next"));
        if (art != null) b.setLargeIcon(art);
        b.setStyle(new Notification.MediaStyle()
                .setShowActionsInCompactView(0, 1, 2)
                .setMediaSession(session.getSessionToken()));
        return b.build();
    }

    private PendingIntent piFor(String action) {
        Intent i = new Intent(this, MediaService.class);
        i.setAction("transport:" + action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Bitmap fetch(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(10000);
            try (InputStream in = c.getInputStream()) {
                return BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            return null;
        }
    }
}
