package com.cineaura.app

import android.webkit.JavascriptInterface

/**
 * Lets the page hand a file to the app (the site creates files such as the IPTV playlist as blob: links,
 * which WebView cannot save by itself). Calls are accepted only with the token the app wrote into
 * page-hook.js for this launch, so an ad frame that is embedded in the page cannot use it.
 */
class NativeBridge(
    private val token: String,
    private val onFile: (name: String, mime: String, base64: String) -> Unit,
) {

    @JavascriptInterface
    fun saveFile(token: String?, name: String?, mime: String?, base64: String?) {
        if (token == null || token != this.token || name == null || base64 == null) return
        if (base64.length > MAX_BASE64_CHARS) return
        onFile(name, mime ?: "application/octet-stream", base64)
    }

    private companion object {
        // about 22 MB of file content; larger files are refused
        const val MAX_BASE64_CHARS = 30_000_000
    }
}
