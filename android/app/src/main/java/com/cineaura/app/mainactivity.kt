package com.cineaura.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.io.File
import java.security.SecureRandom
import java.text.Collator
import java.util.Locale

/**
 * CineAura Android app.
 *
 * Start-up flow
 *  1. Loading page: logo, progress bar ("preparing and loading") while the site loads.
 *  2. First launch only: the setup screen (site language, region, appearance) and a Save button.
 *     Saved choices are written into the site's localStorage, then the site reloads with them.
 *  3. The site itself.
 *
 * Ads
 *  - Free members, guests and premium members with "Watch without ads" off: ads are allowed and
 *    links that open by themselves (pop-ups, automatic redirects) open outside the site, in the browser.
 *  - Premium member with "Watch without ads" on: ad hosts are blocked inside the WebView (built-in
 *    ad blocker), and automatic pop-ups / jumps outside the site are stopped instead of opened.
 *  The member's state comes from the website itself (window.CineAura.adFreeActive), see page-hook.js.
 */
class MainActivity : Activity() {

    private class Option(val code: String, val label: String)

    private enum class Screen { LOADING, SETUP, SITE, ERROR }

    private val languages = listOf(
        Option("en", "English"),
        Option("ar", "العربية"),
        Option("fr", "Français"),
        Option("de", "Deutsch"),
        Option("es", "Español"),
        Option("nl", "Nederlands"),
        Option("it", "Italiano"),
    )

    /** Region options; the first entry (empty code) means "automatic, by IP" as on the website. */
    private var countries: List<Option> = emptyList()

    private lateinit var prefs: AppPrefs
    private lateinit var webView: WebView
    private lateinit var loader: View
    private lateinit var progressBar: ProgressBar
    private lateinit var progressText: TextView
    private lateinit var setupPanel: View
    private lateinit var languageSpinner: Spinner
    private lateinit var countrySpinner: Spinner
    private lateinit var themeGroup: RadioGroup
    private lateinit var saveButton: Button
    private lateinit var errorPanel: View
    private lateinit var fullscreenContainer: FrameLayout

    private val handler = Handler(Looper.getMainLooper())

    /** Random per launch; the page must present it to the NativeBridge. */
    private val token = randomToken()

    private val hookSource: String by lazy {
        assets.open("page-hook.js").bufferedReader().use { it.readText() }.replace("__APP_TOKEN__", token)
    }

    private var screen = Screen.LOADING
    private var loadStartedAt = 0L
    private var webProgress = 0
    private var shownProgress = 0
    private var pageFinished = false
    private var loadFailed = false

    /** Premium member with "Watch without ads" on, as last reported by the page. */
    @Volatile
    private var adFree = false

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val siteUrl: String
        get() = BuildConfig.SITE_URL

    private val siteHost: String
        get() = Uri.parse(siteUrl).host.orEmpty()

    // ---------------------------------------------------------------- lifecycle

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = AppPrefs(this)
        adFree = prefs.adFree

        webView = findViewById(R.id.webview)
        loader = findViewById(R.id.loader)
        progressBar = findViewById(R.id.progress)
        progressText = findViewById(R.id.progressText)
        setupPanel = findViewById(R.id.setupPanel)
        languageSpinner = findViewById(R.id.languageSpinner)
        countrySpinner = findViewById(R.id.countrySpinner)
        themeGroup = findViewById(R.id.themeGroup)
        saveButton = findViewById(R.id.saveButton)
        errorPanel = findViewById(R.id.errorPanel)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)

        findViewById<Button>(R.id.retryButton).setOnClickListener { startLoading() }
        saveButton.setOnClickListener { saveSetup() }

        setupSetupPanel()
        setupWebView()
        startLoading()
        handler.postDelayed(adPoll, AD_POLL_MS)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        fullscreenContainer.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            customView != null -> leaveFullscreen()
            screen == Screen.SITE && webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    // ---------------------------------------------------------------- loading page

    private val ticker = object : Runnable {
        override fun run() {
            val elapsed = System.currentTimeMillis() - loadStartedAt
            // Follows the real page progress, creeps forward on slow connections, and only reaches
            // 100 when the page has finished loading.
            val target = if (pageFinished) {
                100
            } else {
                minOf(90, maxOf(webProgress * 9 / 10, (elapsed / 80).toInt()))
            }
            if (shownProgress < target) {
                shownProgress = minOf(target, shownProgress + maxOf(1, (target - shownProgress) / 4))
            }
            progressBar.progress = shownProgress
            progressText.text = getString(R.string.loader_percent, shownProgress)

            if (pageFinished && shownProgress >= 100 && elapsed >= MIN_LOADER_MS) {
                show(if (prefs.setupDone) Screen.SITE else Screen.SETUP)
                return
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    private fun startLoading() {
        loadFailed = false
        pageFinished = false
        webProgress = 0
        shownProgress = 0
        loadStartedAt = System.currentTimeMillis()
        progressBar.progress = 0
        show(Screen.LOADING)
        handler.removeCallbacks(ticker)
        handler.post(ticker)
        webView.loadUrl(siteUrl)
    }

    private fun showError() {
        loadFailed = true
        handler.removeCallbacks(ticker)
        show(Screen.ERROR)
    }

    private fun show(next: Screen) {
        screen = next
        loader.visibility = if (next == Screen.LOADING) View.VISIBLE else View.GONE
        setupPanel.visibility = if (next == Screen.SETUP) View.VISIBLE else View.GONE
        errorPanel.visibility = if (next == Screen.ERROR) View.VISIBLE else View.GONE
        webView.visibility = if (next == Screen.SITE) View.VISIBLE else View.INVISIBLE
    }

    // ---------------------------------------------------------------- first-run setup

    private fun setupSetupPanel() {
        val locale = Locale.getDefault()
        val collator = Collator.getInstance(locale)
        val names = Locale.getISOCountries()
            .map { Option(it, Locale.Builder().setRegion(it).build().getDisplayCountry(locale)) }
            .filter { it.label.isNotBlank() }
            .sortedWith(Comparator<Option> { a, b -> collator.compare(a.label, b.label) })
        countries = listOf(Option("", getString(R.string.region_auto))) + names

        languageSpinner.adapter = adapterOf(languages.map { it.label })
        countrySpinner.adapter = adapterOf(countries.map { it.label })

        // Pre-select what the device says; the member can change all of it before saving.
        languageSpinner.setSelection(languages.indexOfFirst { it.code == locale.language }.coerceAtLeast(0))
        countrySpinner.setSelection(countries.indexOfFirst { it.code == locale.country }.coerceAtLeast(0))
        themeGroup.check(R.id.themeDark)
    }

    private fun adapterOf(items: List<String>): ArrayAdapter<String> =
        ArrayAdapter(this, android.R.layout.simple_spinner_item, items).also {
            it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }

    private fun saveSetup() {
        val lang = languages[languageSpinner.selectedItemPosition].code
        val country = countries.getOrNull(countrySpinner.selectedItemPosition)?.code.orEmpty()
        val theme = if (themeGroup.checkedRadioButtonId == R.id.themeLight) "day" else "night"

        saveButton.isEnabled = false
        webView.evaluateJavascript(SetupScript.save(lang, country, theme)) { result ->
            saveButton.isEnabled = true
            if (result == "true") {
                prefs.setupDone = true
                // Reload the site so it starts with the saved language, region and appearance.
                startLoading()
            } else {
                Toast.makeText(this, R.string.save_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.setBackgroundColor(Color.parseColor("#070F18"))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // Needed so that automatic window.open calls reach onCreateWindow, where they are decided.
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            allowFileAccess = false
            allowContentAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // Look like desktop Chrome to the site; WebView's "; wv" marker is removed.
            userAgentString = userAgentString.replace("; wv", "") + " CineAuraApp/1.0"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        webView.addJavascriptInterface(NativeBridge(token) { name, mime, base64 ->
            saveDownload(name, mime, base64)
        }, "CineAuraNative")
        webView.webViewClient = siteClient
        webView.webChromeClient = siteChromeClient
        // Plain file downloads (http links with a download attribute) open in the browser.
        webView.setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
    }

    private val siteClient = object : WebViewClient() {

        override fun onPageFinished(view: WebView, url: String?) {
            if (loadFailed) return
            pageFinished = true
            view.evaluateJavascript(hookSource, null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            handleNavigation(request)

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // Built-in ad blocker: only while "Watch without ads" is on for a premium member.
            if (adFree && SiteRules.isAdHost(request.url.host)) {
                return WebResourceResponse(
                    "text/plain",
                    "utf-8",
                    403,
                    "Blocked",
                    emptyMap(),
                    ByteArrayInputStream(ByteArray(0)),
                )
            }
            return null
        }
    }

    private val siteChromeClient = object : WebChromeClient() {

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            webProgress = newProgress
        }

        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message,
        ): Boolean {
            // A pop-up that the member did not ask for is stopped while ad-free viewing is on.
            if (adFree && !isUserGesture) return false

            // Otherwise the pop-up opens outside the site, in the browser.
            val popup = WebView(this@MainActivity)
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    val scheme = request.url.scheme.orEmpty().lowercase(Locale.ROOT)
                    if (scheme != "http" && scheme != "https") return false
                    openExternal(request.url)
                    handler.post { v.destroy() }
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            fullscreenContainer.addView(
                view,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            fullscreenContainer.visibility = View.VISIBLE
            webView.visibility = View.GONE
            applyImmersive(true)
        }

        override fun onHideCustomView() {
            leaveFullscreen()
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: WebChromeClient.FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                startActivityForResult(params.createIntent(), REQ_FILE)
                true
            } catch (e: Exception) {
                fileCallback = null
                false
            }
        }
    }

    /**
     * Decides what happens when a page tries to leave the current document.
     * Returns true when the app handled it (opened outside or blocked), false to let WebView load it.
     */
    private fun handleNavigation(request: WebResourceRequest): Boolean {
        val uri = request.url
        val scheme = uri.scheme.orEmpty().lowercase(Locale.ROOT)
        val web = scheme == "http" || scheme == "https"

        if (web && SiteRules.isSiteHost(uri.host, siteHost)) return false
        if (!web && scheme in INTERNAL_SCHEMES) return false
        // Frames (video player, embeds) load inside the page; only top-level jumps leave the site.
        if (!request.isForMainFrame) return false
        // Ad-free viewing: a jump the member did not tap is stopped.
        if (adFree && !request.hasGesture()) return true

        openExternal(uri)
        return true
    }

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme.orEmpty().lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            runOnUiThread { Toast.makeText(this, R.string.open_failed, Toast.LENGTH_SHORT).show() }
        }
    }

    // ---------------------------------------------------------------- full screen video

    private fun leaveFullscreen() {
        val view = customView ?: return
        fullscreenContainer.removeView(view)
        fullscreenContainer.visibility = View.GONE
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        applyImmersive(false)
        show(screen)
    }

    @Suppress("DEPRECATION")
    private fun applyImmersive(on: Boolean) {
        window.decorView.systemUiVisibility = if (on) {
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        } else {
            View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    // ---------------------------------------------------------------- files saved by the site

    private fun saveDownload(name: String, mime: String, base64: String) {
        val safeName = name.replace(Regex("""[\\/:*?"<>|\x00-\x1f]"""), "_").trim().take(120).ifEmpty { "download" }
        val type = mime.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val saved = try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveToDownloads(safeName, type, bytes)
            } else {
                saveToAppFolder(safeName, bytes)
            }
        } catch (e: Exception) {
            false
        }
        runOnUiThread {
            Toast.makeText(
                this,
                if (saved) R.string.download_saved else R.string.download_failed,
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    /** Android 10 and newer: the public Downloads folder, no storage permission needed. */
    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray): Boolean {
        val resolver = contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        val out = resolver.openOutputStream(uri) ?: return false
        out.use { it.write(bytes) }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return true
    }

    /** Android 8 and 9: the app's own Downloads folder (no storage permission needed). */
    private fun saveToAppFolder(name: String, bytes: ByteArray): Boolean {
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
        File(dir, name).writeBytes(bytes)
        return true
    }

    // ---------------------------------------------------------------- ads state from the page

    /** Reads the member's state from the page every few seconds. */
    private val adPoll = object : Runnable {
        override fun run() {
            webView.evaluateJavascript("window.__cineauraAdState || 'unknown'") { raw ->
                val on: Boolean? = when (raw?.trim('"')) {
                    "on" -> true
                    "off" -> false
                    else -> null // not checked yet on this page: keep the last known state
                }
                if (on != null && on != adFree) {
                    adFree = on
                    prefs.adFree = on
                }
            }
            handler.postDelayed(this, AD_POLL_MS)
        }
    }

    // ---------------------------------------------------------------- helpers

    /** The page-hook.js source with this launch's token filled in. */
    private fun randomToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    companion object {
        private const val REQ_FILE = 1001
        private const val TICK_MS = 40L
        private const val AD_POLL_MS = 2000L
        private const val MIN_LOADER_MS = 1600L
        private val INTERNAL_SCHEMES = setOf("about", "blob", "data", "javascript")
    }
}
