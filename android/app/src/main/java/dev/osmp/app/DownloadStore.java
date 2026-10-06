package dev.osmp.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * On-device track downloads. Files live in app-private storage; the WebView
 * serves them through https://offline.osmp.local/{id} interception, so the
 * web UI plays them with zero network access.
 */
public class DownloadStore {

    private static final String TAG = "osmp.downloads";

    public static class State {
        public String status = "idle";   // queued|downloading|done|error
        public float progress = 0f;
        public String error = null;
        public volatile boolean canceled = false;
    }

    private final Context ctx;
    private final File dir;
    private final Map<String, State> states = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> index = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    public DownloadStore(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.dir = new File(this.ctx.getFilesDir(), "downloads");
        if (!dir.exists()) dir.mkdirs();
        loadIndex();
    }

    // ── index persistence ────────────────────────────────────────────

    private File indexFile() { return new File(dir, "index.json"); }

    private synchronized void loadIndex() {
        File f = indexFile();
        if (!f.exists()) return;
        try {
            String raw = new String(java.nio.file.Files.readAllBytes(f.toPath()));
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                File media = fileFor(o.getString("id"));
                if (media.exists()) index.put(o.getString("id"), o);
            }
        } catch (Exception e) {
            Log.w(TAG, "index load failed", e);
        }
    }

    private synchronized void saveIndex() {
        try {
            JSONArray arr = new JSONArray();
            for (JSONObject o : index.values()) arr.put(o);
            java.nio.file.Files.write(indexFile().toPath(), arr.toString().getBytes());
        } catch (Exception e) {
            Log.w(TAG, "index save failed", e);
        }
    }

    private File fileFor(String id) {
        JSONObject meta = index.get(id);
        String ext = meta != null ? meta.optString("ext", "m4a") : "m4a";
        return new File(dir, id + "." + ext);
    }

    // ── public API (called from the JS bridge) ───────────────────────

    public boolean isDownloaded(String id) {
        return index.containsKey(id) && fileFor(id).exists();
    }

    public File file(String id) {
        File f = fileFor(id);
        return f.exists() ? f : null;
    }

    public String stateJson(String id) {
        State s = states.get(id);
        JSONObject o = new JSONObject();
        try {
            if (s == null) {
                o.put("status", isDownloaded(id) ? "done" : "idle");
                o.put("progress", isDownloaded(id) ? 1.0 : 0.0);
            } else {
                o.put("status", s.status);
                o.put("progress", s.progress);
                if (s.error != null) o.put("error", s.error);
            }
        } catch (Exception ignored) { }
        return o.toString();
    }

    public String listJson() {
        JSONArray arr = new JSONArray();
        for (JSONObject o : index.values()) {
            File f = fileFor(o.optString("id", ""));
            if (!f.exists()) continue;
            try {
                JSONObject copy = new JSONObject(o.toString());
                copy.put("size", f.length());
                arr.put(copy);
            } catch (Exception ignored) { }
        }
        return arr.toString();
    }

    public long storageUsed() {
        long total = 0;
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) total += f.length();
        return total;
    }

    public void delete(String id) {
        // flag any in-flight worker so it can't resurrect the deleted file
        State s = states.get(id);
        if (s != null) s.canceled = true;
        File f = fileFor(id);
        if (f.exists()) f.delete();
        new File(dir, id + "." + guessExtFromStates(id) + ".part").delete();
        index.remove(id);
        states.remove(id);
        saveIndex();
    }

    private String guessExtFromStates(String id) {
        // best effort — .part cleanup for an unknown in-flight extension
        for (String ext : new String[]{"m4a", "webm", "opus", "mp3"}) {
            if (new File(dir, id + "." + ext + ".part").exists()) return ext;
        }
        return "m4a";
    }

    public void download(String id, String url, String title, String artist, String cookie) {
        if (isDownloaded(id)) return;
        State cur = states.get(id);
        if (cur != null && !cur.canceled
                && ("queued".equals(cur.status) || "downloading".equals(cur.status))) {
            return;  // already in flight — a second task would corrupt the .part file
        }
        State s = new State();
        s.status = "queued";
        states.put(id, s);
        pool.submit(() -> run(id, url, title, artist, cookie));
    }

    // ── worker ───────────────────────────────────────────────────────

    private void run(String id, String url, String title, String artist, String cookie) {
        State s = states.get(id);
        if (s == null) return;  // deleted between submit and start
        s.status = "downloading";
        String ext = guessExt(url);
        File tmp = new File(dir, id + "." + ext + ".part");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "OSMP-Android/0.1");
            // every /api path sits behind the auth gate — without the
            // WebView's session cookie the server answers 401
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            int code = c.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            long total = c.getContentLengthLong();
            try (InputStream in = c.getInputStream();
                 OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024];
                long done = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (s.canceled) { tmp.delete(); return; }
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) s.progress = Math.min(1f, (float) done / total);
                }
            }
            if (s.canceled) { tmp.delete(); return; }
            File dest = new File(dir, id + "." + ext);
            if (dest.exists()) dest.delete();
            if (!tmp.renameTo(dest)) throw new IllegalStateException("rename failed");

            JSONObject meta = new JSONObject();
            meta.put("id", id);
            meta.put("ext", ext);
            meta.put("title", title != null ? title : id);
            meta.put("artist", artist != null ? artist : "");
            meta.put("size", dest.length());
            index.put(id, meta);
            saveIndex();

            s.status = "done";
            s.progress = 1f;
        } catch (Exception e) {
            Log.w(TAG, "download " + id + " failed", e);
            tmp.delete();
            s.status = "error";
            s.error = String.valueOf(e.getMessage());
        }
    }

    private static String guessExt(String url) {
        // the stream endpoint's format parameter decides the container —
        // the path itself has no extension
        if (url.contains("fmt=opus")) return "webm";
        String lower = url.toLowerCase();
        int q = lower.indexOf('?');
        if (q > 0) lower = lower.substring(0, q);
        if (lower.endsWith(".webm")) return "webm";
        if (lower.endsWith(".opus")) return "opus";
        if (lower.endsWith(".mp3")) return "mp3";
        return "m4a";
    }

    // ── Range-aware local serving for the WebView interceptor ────────

    /** Reads [start, end] (inclusive) of a downloaded file, or the whole file. */
    public byte[] readRange(String id, long start, long end) {
        File f = file(id);
        if (f == null) return null;
        long len = f.length();
        if (start < 0) start = 0;
        if (end < 0 || end >= len) end = len - 1;
        int size = (int) (end - start + 1);
        byte[] out = new byte[size];
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(start);
            raf.readFully(out);
        } catch (Exception e) {
            return null;
        }
        return out;
    }

    public long length(String id) {
        File f = file(id);
        return f != null ? f.length() : -1;
    }

    public String mime(String id) {
        File f = file(id);
        if (f == null) return "audio/mp4";
        String n = f.getName().toLowerCase();
        if (n.endsWith(".webm") || n.endsWith(".opus")) return "audio/webm";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        return "audio/mp4";
    }
}
