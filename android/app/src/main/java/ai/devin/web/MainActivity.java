package ai.devin.web;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.DownloadListener;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Thin WebView shell around a running devin-web server.
 * First launch asks for the server URL (persisted); a load failure returns to
 * that screen. Bridges the few browser APIs WebView lacks: file chooser,
 * blob downloads, element fullscreen, web notifications.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "devinweb";
    private static final int REQ_FILE = 41;
    private static final int REQ_NOTIF = 42;

    private FrameLayout root;
    private WebView web;
    private View setupView;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCb;
    private ValueCallback<Uri[]> fileCb;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        setContentView(root);
        createNotifChannel();
        applySysBars(SETUP_BG);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
        String url = prefs.getString("server_url", null);
        if (url == null) showSetup(null); else loadWeb(url);
    }

    // ---------- setup screen (server URL entry) ----------

    private void showSetup(String error) {
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        if (setupView != null) root.removeView(setupView);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        int pad = dp(24);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(SETUP_BG);

        TextView title = new TextView(this);
        title.setText("Devin Web");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        col.addView(title);

        TextView sub = new TextView(this);
        sub.setText("服务器地址 (devin-web server)");
        sub.setTextColor(Color.LTGRAY);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        sub.setPadding(0, dp(24), 0, dp(8));
        col.addView(sub);

        EditText input = new EditText(this);
        input.setSingleLine();
        input.setHint("http://192.168.1.10:8787");
        input.setText(prefs.getString("server_url", ""));
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.GRAY);
        col.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        if (error != null) {
            TextView err = new TextView(this);
            err.setText(error);
            err.setTextColor(Color.rgb(255, 120, 120));
            err.setPadding(0, dp(8), 0, 0);
            col.addView(err);
        }

        Button go = new Button(this);
        go.setText("连接");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        col.addView(go, lp);

        go.setOnClickListener(v -> {
            String u = input.getText().toString().trim();
            if (u.isEmpty()) return;
            if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
            prefs.edit().putString("server_url", u).apply();
            loadWeb(u);
        });

        ScrollView sv = new ScrollView(this);
        sv.addView(col);
        setupView = sv;
        root.addView(sv);
    }

    // ---------- webview ----------

    @SuppressWarnings("SetJavaScriptEnabled")
    private void loadWeb(String url) {
        if (setupView != null) { root.removeView(setupView); setupView = null; }
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "DevinNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String u) {
                v.evaluateJavascript(NOTIF_SHIM, null);
                v.evaluateJavascript(BARS_SHIM, null);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame())
                    showSetup("连接失败: " + err.getDescription());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = params.createIntent();
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                fullscreenView = view;
                fullscreenCb = cb;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                web.setVisibility(View.VISIBLE);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                if (fullscreenCb != null) fullscreenCb.onCustomViewHidden();
                fullscreenCb = null;
            }
        });
        web.setDownloadListener((dlUrl, ua, disposition, mime, len) -> {
            if (dlUrl.startsWith("blob:")) {
                String name = guessName(disposition);
                String js = "(async()=>{try{const r=await fetch('" + dlUrl + "');"
                        + "const b=await r.blob();const buf=new Uint8Array(await b.arrayBuffer());"
                        + "let s='';for(let i=0;i<buf.length;i+=0x8000)"
                        + "s+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));"
                        + "DevinNative.saveBlob(btoa(s),'" + jsStr(name) + "','" + jsStr(mime) + "');"
                        + "}catch(e){DevinNative.saveBlob('','" + jsStr(name) + "','')}})()";
                web.evaluateJavascript(js, null);
            } else {
                Toast.makeText(this, "外部下载不支持", Toast.LENGTH_SHORT).show();
            }
        });
        web.setBackgroundColor(SETUP_BG);
        root.addView(web, 0);
        web.loadUrl(url);
    }

    // ---------- system bars (immersive tint) ----------

    private static final int SETUP_BG = Color.rgb(15, 15, 17);

    // Samples the header's effective composited color (header bg over body bg,
    // resolved on a 1px canvas so color-mix()/rgba blur tints collapse to the
    // same srgb the user sees) and tints the system bars to match. Re-fires on
    // theme attribute flips and on a slow poll for view changes.
    private static final String BARS_SHIM =
            "(function(){if(window.__barsShim)return;window.__barsShim=1;"
            + "var cv=document.createElement('canvas');cv.width=cv.height=1;"
            + "function sample(el,over){try{"
            + "var x=cv.getContext('2d');"
            + "x.fillStyle=over;x.fillRect(0,0,1,1);"
            + "x.fillStyle=getComputedStyle(el).backgroundColor;x.fillRect(0,0,1,1);"
            + "var d=x.getImageData(0,0,1,1).data;"
            + "return 'rgb('+d[0]+','+d[1]+','+d[2]+')';}catch(e){return null}}"
            + "var rep=function(){try{"
            + "var body=document.body;if(!body)return;"
            + "var bb=getComputedStyle(body).backgroundColor;"
            + "if(!bb||bb==='transparent'||bb==='rgba(0, 0, 0, 0)')bb='#000';"
            + "var el=document.querySelector('.chat-head')||document.querySelector('.mobile-bar')||body;"
            + "var c=sample(el,bb);"
            + "if(c&&window.DevinNative)DevinNative.sysBars(c);}catch(e){}};"
            + "new MutationObserver(rep).observe(document.documentElement,"
            + "{attributes:true,attributeFilter:['data-theme','data-scheme','class','style']});"
            + "rep();setTimeout(rep,600);setTimeout(rep,2000);setInterval(rep,3000);})()";

    private void applySysBars(int color) {
        if (Build.VERSION.SDK_INT < 21) return;
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        // dark bg → light icons; light bg → dark icons
        double lum = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255.0;
        boolean lightIcons = lum > 0.55;
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().getInsetsController().setSystemBarsAppearance(
                    lightIcons ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                            : 0,
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        } else {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | 0x00000010 /*LIGHT_NAVIGATION_BAR*/);
            if (lightIcons && Build.VERSION.SDK_INT >= 23) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (lightIcons && Build.VERSION.SDK_INT >= 26) flags |= 0x00000010;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    private static int parseCssColor(String css) {
        if (css == null) return 0;
        css = css.trim();
        try {
            if (css.startsWith("#")) return Color.parseColor(css) | 0xFF000000;
            if (css.startsWith("rgb")) {
                String[] p = css.substring(css.indexOf('(') + 1, css.indexOf(')')).split(",");
                int r = (int) Float.parseFloat(p[0].trim());
                int g = (int) Float.parseFloat(p[1].trim());
                int b = (int) Float.parseFloat(p[2].trim());
                return Color.rgb(r, g, b);
            }
        } catch (Exception ignored) {
        }
        return 0;
    }

    private static String guessName(String disposition) {
        if (disposition != null) {
            for (String part : disposition.split(";")) {
                part = part.trim();
                if (part.startsWith("filename=")) {
                    String n = part.substring(9).replace("\"", "").trim();
                    if (!n.isEmpty()) return n;
                }
            }
        }
        return "devin-export.txt";
    }

    private static String jsStr(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("'", "\\'");
    }

    // WebView lacks the Notification API — shim it over the JS bridge.
    private static final String NOTIF_SHIM =
            "if(!window.Notification){"
            + "window.Notification=function(t,o){o=o||{};DevinNative.notify(t,o.body||'',o.tag||'')};"
            + "Object.defineProperty(Notification,'permission',{get:()=>DevinNative.notifPerm()});"
            + "Notification.requestPermission=()=>Promise.resolve(DevinNative.notifPerm());"
            + "}";

    class Bridge {
        @JavascriptInterface
        public void sysBars(String css) {
            int c = parseCssColor(css);
            if (c != 0) runOnUiThread(() -> applySysBars(c));
        }

        @JavascriptInterface
        public String notifPerm() {
            if (Build.VERSION.SDK_INT < 33
                    || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                return "granted";
            return "denied";
        }

        @JavascriptInterface
        public void notify(String title, String body, String tag) {
            if (!"granted".equals(notifPerm())) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Intent i = new Intent(MainActivity.this, MainActivity.class);
            PendingIntent pi = PendingIntent.getActivity(MainActivity.this, 0, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            android.app.Notification n = new android.app.Notification.Builder(MainActivity.this, "devin")
                    .setContentTitle(title).setContentText(body)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentIntent(pi).setAutoCancel(true).build();
            int id = tag == null || tag.isEmpty() ? (int) System.currentTimeMillis() : tag.hashCode();
            nm.notify(id, n);
        }

        @JavascriptInterface
        public void saveBlob(String base64, String name, String mime) {
            if (base64.isEmpty()) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "导出失败", Toast.LENGTH_SHORT).show());
                return;
            }
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(data); }
                    where = "Download/" + name;
                } else {
                    File f = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
                    try (OutputStream os = new FileOutputStream(f)) { os.write(data); }
                    where = f.getAbsolutePath();
                }
                String w = where;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "已保存: " + w, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "导出失败: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }

    // ---------- misc ----------

    private void createNotifChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(
                    "devin", "Devin", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCb = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            web.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null);
            return;
        }
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
