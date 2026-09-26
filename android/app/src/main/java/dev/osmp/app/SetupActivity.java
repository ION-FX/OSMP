package dev.osmp.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** First-run screen: enter the self-hosted server address, ping /api/health. */
public class SetupActivity extends Activity {

    public static final String PREFS = "osmp";
    public static final String KEY_URL = "server_url";

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
        EditText input = findViewById(R.id.url_input);
        Button connect = findViewById(R.id.connect);
        TextView status = findViewById(R.id.status);

        connect.setOnClickListener(v -> {
            String raw = input.getText().toString().trim();
            String url = normalize(raw);
            if (url == null) {
                show(status, getString(R.string.setup_fail));
                return;
            }
            connect.setEnabled(false);
            connect.setText(R.string.setup_testing);
            status.setVisibility(View.GONE);
            final String target = url;
            exec.submit(() -> {
                boolean ok = ping(target);
                runOnUiThread(() -> {
                    if (ok) {
                        prefs.edit().putString(KEY_URL, target).apply();
                        startMain();
                    } else {
                        connect.setEnabled(true);
                        connect.setText(R.string.setup_connect);
                        show(status, getString(R.string.setup_fail));
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
                String body = n > 0 ? new String(buf, 0, n) : "";
                return code == 200 && body.contains("\"ok\"");
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void show(TextView tv, String msg) {
        tv.setText(msg);
        tv.setVisibility(View.VISIBLE);
    }

    private void startMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }
}
