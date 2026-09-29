package dev.osmp.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground media notification + lock-screen/Bluetooth transport controls.
 * The WebView reports state through OsmpBridge.notifyMedia(); transport
 * actions are pushed back into the page via window.__osmpMedia(action).
 */
public class MediaService extends Service {

    private static final String CHANNEL = "osmp_playback";
    private static final int NOTIF_ID = 8790;

    private static MediaService instance;
    private static MainActivity host;          // set by update()
    private static JSONObject lastState;
    private static String lastTitle = "", lastArtist = "", lastCover = "";

    private MediaSession session;
    private final ExecutorService artPool = Executors.newSingleThreadExecutor();

    public static void update(Context ctx, JSONObject state) {
        if (ctx instanceof MainActivity) host = (MainActivity) ctx;
        lastState = mergeState(state);
        Intent i = new Intent(ctx, MediaService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    /** Fill missing fields from the last known state — a payload carrying
     * only `playing` must never wipe the title/artist off the notification. */
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
        session = new MediaSession(this, "osmp");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { eval("play"); }
            @Override public void onPause() { eval("pause"); }
            @Override public void onSkipToNext() { eval("next"); }
            @Override public void onSkipToPrevious() { eval("prev"); }
            @Override public void onStop() { eval("stop"); stopSelf(); }
        });
        session.setActive(true);
    }

    private void eval(String action) {
        MainActivity a = host;
        if (a != null) a.evalJs("window.__osmpMedia && __osmpMedia('" + action + "')");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // transport actions from notification buttons (PendingIntent.getService)
        if (intent != null && intent.getAction() != null
                && intent.getAction().startsWith("transport:")) {
            eval(intent.getAction().substring("transport:".length()));
            return START_NOT_STICKY;
        }

        JSONObject st = lastState;
        if (st == null) return START_NOT_STICKY;

        boolean playing = st.optBoolean("playing", false);
        String title = st.optString("title", "OSMP");
        String artist = st.optString("artist", "");
        String cover = st.optString("cover", "");

        // media session metadata
        MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "OSMP");
        session.setMetadata(mb.build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());

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
        if (art != null) {
            b.setLargeIcon(art);
            b.setStyle(new Notification.MediaStyle()
                    .setShowActionsInCompactView(0, 1, 2)
                    .setMediaSession(session.getSessionToken()));
        } else {
            b.setStyle(new Notification.MediaStyle()
                    .setShowActionsInCompactView(0, 1, 2)
                    .setMediaSession(session.getSessionToken()));
        }
        return b.build();
    }

    private PendingIntent piFor(String action) {
        Intent i = new Intent(this, MediaService.class);
        i.setAction("transport:" + action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        instance = null;
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        super.onDestroy();
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
