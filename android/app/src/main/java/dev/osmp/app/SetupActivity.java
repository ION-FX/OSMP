package dev.osmp.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONObject;

/** First-run screen: server address + OSMP account, signs in and seeds the session. */
public class SetupActivity extends Activity {

    public static final String PREFS = "osmp";
    public static final String KEY_URL = "server_url";
    public static final String KEY_USER = "username";
    public static final String KEY_TOKEN = "token";

    private final ExecutorService exec = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_URL, null);
        if (saved != null && !saved.isEmpty()) {
            startMain();
            return;
        }

        setContentView(R.layout.activity_setup);
        EditText urlInput = findViewById(R.id.url_input);
        EditText userInput = findViewById(R.id.user_input);
        EditText passInput = findViewById(R.id.pass_input);
        Button connect = findViewById(R.id.connect);
        TextView status = findViewById(R.id.status);

        connect.setOnClickListener(v -> {
            String rawUrl = urlInput.getText().toString().trim();
            final String url = normalize(rawUrl);
            final String user = userInput.getText().toString().trim();
            final String pass = passInput.getText().toString();
            if (url == null || user.isEmpty() || pass.isEmpty()) {
                show(status, getString(R.string.setup_fail));
                return;
            }
            InputMethodManager imm = getSystemService(InputMethodManager.class);
            if (imm != null) imm.hideSoftInputFromWindow(connect.getWindowToken(), 0);
            connect.setEnabled(false);
            connect.setText(R.string.setup_testing);
            status.setVisibility(View.GONE);
            exec.submit(() -> {
                final String result;
                if (!ping(url)) {
                    result = getString(R.string.setup_fail);
                } else {
                    String setupErr = probeSetupNeeded(url);
                    if (setupErr != null) {
                        result = setupErr;
                    } else {
                        String token = login(url, user, pass);
                        if (token == null) {
                            result = getString(R.string.setup_auth_fail);
                        } else {
                            prefs.edit()
                                    .putString(KEY_URL, url)
                                    .putString(KEY_USER, user)
                                    .putString(KEY_TOKEN, token)
                                    .apply();
                            // seed the WebView session so MainActivity boots logged-in
                            CookieManager cm = CookieManager.getInstance();
                            cm.setCookie(url + "/", "osmp_session=" + token + "; Path=/");
                            cm.setCookie(url, "osmp_session=" + token + "; Path=/");
                            cm.flush();
                            result = null;
                        }
                    }
                }
                runOnUiThread(() -> {
                    if (result == null) {
                        startMain();
                    } else {
                        connect.setEnabled(true);
                        connect.setText(R.string.setup_connect);
                        show(status, result);
                    }
                });
            });
        });
    }

    static String normalize(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        String s = raw.trim();
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        try {
            new URL(s);
        } catch (Exception e) {
            return null;
        }
        return s;
    }

    static boolean ping(String baseUrl) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(baseUrl + "/api/health")
                    .openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[256];
                int n = in.read(buf);
                String body = n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
                return code == 200 && body.contains("\"ok\"");
            }
        } catch (Exception e) {
            return false;
        }
    }

    /** Returns a message if the server still needs its admin created, else null. */
    static String probeSetupNeeded(String baseUrl) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(baseUrl + "/api/config")
                    .openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            int code = c.getResponseCode();
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                JSONObject cfg = new JSONObject(out.toString("UTF-8"));
                if (cfg.optBoolean("setup_required", false)) {
                    return "SETUP"; // caller substitutes the friendly string
                }
            }
            return code == 200 ? null : "ERR";
        } catch (Exception e) {
            return "ERR";
        }
    }

    static String login(String baseUrl, String username, String password) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(baseUrl + "/api/auth/login").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            JSONObject body = new JSONObject();
            body.put("username", username);
            body.put("password", password);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            if (code != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                JSONObject resp = new JSONObject(out.toString("UTF-8"));
                return resp.optString("token", null);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void show(TextView tv, String msg) {
        if ("SETUP".equals(msg)) msg = getString(R.string.setup_needs_setup);
        else if ("ERR".equals(msg)) msg = getString(R.string.setup_fail);
        tv.setText(msg);
        tv.setVisibility(View.VISIBLE);
    }

    private void startMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }
}
