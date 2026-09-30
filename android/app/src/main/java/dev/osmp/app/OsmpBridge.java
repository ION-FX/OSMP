package dev.osmp.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * JS ↔ native bridge exposed as window.OsmpBridge.
 * The web UI detects it and switches downloads to on-device storage and
 * playback URLs to https://offline.osmp.local/{id} (intercepted natively).
 */
public class OsmpBridge {

    private final MainActivity activity;
    private final DownloadStore store;

    public OsmpBridge(MainActivity activity, DownloadStore store) {
        this.activity = activity;
        this.store = store;
    }

    @JavascriptInterface
    public boolean isDownloaded(String id) {
        return store.isDownloaded(id);
    }

    @JavascriptInterface
    public String getDownloadState(String id) {
        return store.stateJson(id);
    }

    @JavascriptInterface
    public void downloadTrack(String id, String url, String title, String artist) {
        // older cached UIs may hand us a server-relative path — resolve it,
        // java.net.URL rejects anything without a protocol
        if (url != null && !url.contains("://")) {
            String base = activity.getServerUrl();
            if (base != null) url = base + (url.startsWith("/") ? url : "/" + url);
        }
        store.download(id, url, title, artist);
    }

    @JavascriptInterface
    public void deleteDownload(String id) {
        store.delete(id);
    }

    @JavascriptInterface
    public String listDownloads() {
        return store.listJson();
    }

    @JavascriptInterface
    public long storageUsed() {
        return store.storageUsed();
    }

    @JavascriptInterface
    public String getServerUrl() {
        return activity.getServerUrl();
    }

    @JavascriptInterface
    public void setWakeLock(boolean on) {
        activity.setWakeLock(on);
    }

    /** Web UI reports playback changes → notification + lock-screen controls. */
    @JavascriptInterface
    public void notifyMedia(String json) {
        try {
            JSONObject o = new JSONObject(json);
            MediaService.update(activity, o);
        } catch (Exception ignored) { }
    }

    /** Open the setup screen again (change server). */
    @JavascriptInterface
    public void openSetup() {
        activity.runOnUiThread(() -> {
            activity.getSharedPreferences(SetupActivity.PREFS, Context.MODE_PRIVATE)
                    .edit().remove(SetupActivity.KEY_URL).apply();
            activity.startActivity(new android.content.Intent(activity, SetupActivity.class));
            activity.finish();
        });
    }
}
