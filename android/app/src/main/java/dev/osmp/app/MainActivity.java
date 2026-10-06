package dev.osmp.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.os.PowerManager;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;

/** Hosts the OSMP web UI in a WebView and wires the native bridge. */
public class MainActivity extends Activity {

    public static final String OFFLINE_HOST = "offline.osmp.local";

    private WebView web;
    private DownloadStore store;
    private OsmpBridge bridge;
    private PowerManager.WakeLock wakeLock;
    private String serverUrl;
    private volatile boolean showingOfflinePage = false;
    private int sslDecision = 0;  // 0 = ask, 1 = proceed, 2 = cancel (per session)

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(SetupActivity.PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(SetupActivity.KEY_URL, null);
        if (serverUrl == null) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }

        store = new DownloadStore(this);
        bridge = new OsmpBridge(this, store);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " OSMPAndroid/0.1");
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new OsmpClient());
        web.addJavascriptInterface(bridge, "OsmpBridge");
        web.setBackgroundColor(0xFF0A0E14);
        web.loadUrl(serverUrl + "/");

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                   != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
        }

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "osmp:playback");
    }

    public WebView getWeb() { return web; }
    public String getServerUrl() { return serverUrl; }

    private volatile String cookieCache = "";

    /** Session cookie for the server, read on the UI thread. Bridge and
     *  service threads must not touch CookieManager directly (it throws on
     *  some WebView providers when called off the UI thread), so bounce the
     *  read through the main looper and cache the last good value. */
    public String serverCookie() {
        final java.util.concurrent.CountDownLatch latch =
                new java.util.concurrent.CountDownLatch(1);
        final String[] out = {cookieCache};
        Runnable read = () -> {
            try {
                String c = CookieManager.getInstance().getCookie(serverUrl);
                if (c != null && !c.isEmpty()) {
                    cookieCache = c;
                    out[0] = c;
                }
            } catch (Throwable ignored) { }
            latch.countDown();
        };
        if (Looper.myLooper() == Looper.getMainLooper()) read.run();
        else runOnUiThread(read);
        try { latch.await(2, java.util.concurrent.TimeUnit.SECONDS); }
        catch (InterruptedException ignored) { }
        return out[0];
    }

    public void setWakeLock(boolean on) {
        if (wakeLock == null) return;
        if (on && !wakeLock.isHeld()) wakeLock.acquire(4 * 60 * 60 * 1000L);
        else if (!on && wakeLock.isHeld()) wakeLock.release();
    }

    /** Runs JS on the UI thread — used by MediaService transport controls. */
    public void evalJs(String js) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (showingOfflinePage) {
                // back from the offline page re-loads the failed entry, which
                // errors again and appends another offline page — a trap
                finish();
                return true;
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // the WebView dies with this activity, so playback (and the
        // notification controlling it) must die too — except when the
        // service is playing natively for Android Auto, which outlives the UI
        MediaService.clearHost(this);
        if (!MediaService.isNativeActive()) MediaService.stop(this);
        setWakeLock(false);
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ── WebView client: offline interception + sane navigation ───────

    private class OsmpClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (uri != null && OFFLINE_HOST.equals(uri.getHost())) {
                return serveOffline(uri, req);
            }
            return super.shouldInterceptRequest(view, req);
        }

        private WebResourceResponse serveOffline(Uri uri, WebResourceRequest req) {
            String id = uri.getLastPathSegment();
            if (id == null || !store.isDownloaded(id)) return null;

            long len = store.length(id);
            String range = req.getRequestHeaders() != null
                    ? req.getRequestHeaders().get("Range") : null;

            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-store");
            headers.put("Access-Control-Allow-Origin", "*");

            if (range != null && range.startsWith("bytes=")) {
                try {
                    String[] parts = range.substring(6).split("-");
                    long start = parts[0].isEmpty() ? -1 : Long.parseLong(parts[0]);
                    long end = parts.length > 1 && !parts[1].isEmpty()
                            ? Long.parseLong(parts[1]) : len - 1;
                    if (start == -1) { start = len - end; end = len - 1; } // suffix range
                    if (end >= len) end = len - 1;
                    byte[] data = store.readRange(id, start, end);
                    if (data == null) return null;
                    headers.put("Content-Range", "bytes " + start + "-" + end + "/" + len);
                    headers.put("Content-Length", String.valueOf(data.length));
                    return new WebResourceResponse(store.mime(id), null, 206,
                            "Partial Content", headers, new ByteArrayInputStream(data));
                } catch (Exception e) {
                    return null;
                }
            }

            byte[] data = store.readRange(id, 0, -1);
            if (data == null) return null;
            headers.put("Content-Length", String.valueOf(data.length));
            return new WebResourceResponse(store.mime(id), null, 200, "OK",
                    headers, new ByteArrayInputStream(data));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (uri == null) return false;
            if ("osmp-retry".equals(uri.getScheme())) {
                // Retry button on the offline page — location.reload() would
                // only re-load the local data: page, never the server
                showingOfflinePage = false;
                view.loadUrl(serverUrl + "/");
                return true;
            }
            String host = uri.getHost();
            String scheme = uri.getScheme();
            // keep app navigation inside; external links (youtube.com etc.) → browser
            Uri server = Uri.parse(serverUrl);
            boolean internal = host != null && (host.equals(server.getHost())
                    || host.equals(OFFLINE_HOST) || host.equals("localhost")
                    || host.equals("127.0.0.1"));
            if (!internal && ("http".equals(scheme) || "https".equals(scheme))) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) { }
                return true;
            }
            return false;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                       android.net.http.SslError error) {
            // self-signed certs are common on self-hosted LAN servers: ask
            // once per session — the main frame plus every XHR would
            // otherwise stack identical dialogs
            if (sslDecision == 1) { handler.proceed(); return; }
            if (sslDecision == 2) { handler.cancel(); return; }
            new android.app.AlertDialog.Builder(MainActivity.this)
                    .setTitle("Untrusted certificate")
                    .setMessage("This server's TLS certificate isn't trusted. Continue anyway?")
                    .setPositiveButton("Continue", (d, w) -> { sslDecision = 1; handler.proceed(); })
                    .setNegativeButton("Cancel", (d, w) -> { sslDecision = 2; handler.cancel(); })
                    .setCancelable(false)
                    .show();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            showingOfflinePage = url == null || !url.startsWith("http");
            // re-announce playback state to the notification after reloads
            evalJs("window.__osmpMedia && __osmpMedia('noop')");
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description,
                                    String failingUrl) {
            super.onReceivedError(view, errorCode, description, failingUrl);
            showOfflinePage(view);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req,
                                    android.webkit.WebResourceError error) {
            super.onReceivedError(view, req, error);
            // only a dead main frame replaces the page — a failing cover
            // image shouldn't nuke the whole UI
            if (req.isForMainFrame()) showOfflinePage(view);
        }

        private void showOfflinePage(WebView view) {
            showingOfflinePage = true;
            view.loadDataWithBaseURL(null, OFFLINE_PAGE, "text/html", "utf-8", null);
        }
    }

    private static final String OFFLINE_PAGE =
            "<html><body style='background:#0a0e14;color:#e9eef6;font-family:sans-serif;"
          + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
          + "<div style='text-align:center'><h2>Server unreachable</h2>"
          + "<p style='color:#93a1b5'>Check that the machine running OSMP is on and that "
          + "you're on the same network.<br>Downloaded tracks still play from the Library.</p>"
          + "<p><button onclick='location.href=\"osmp-retry://load\"' style='padding:12px 26px;border:0;"
          + "border-radius:24px;background:linear-gradient(115deg,#0dbeb0,#8b5cf6);color:#fff;"
          + "font-size:15px;font-weight:600'>Retry</button></p></div></body></html>";
}
