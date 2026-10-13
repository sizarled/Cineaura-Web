package com.cineaura.app

import android.content.Context

/** Small app-level store (not the website's localStorage). */
class AppPrefs(context: Context) {

    private val sp = context.getSharedPreferences("cineaura_app", Context.MODE_PRIVATE)

    /** True once the first-run choices were saved. The setup screen is shown only while this is false. */
    var setupDone: Boolean
        get() = sp.getBoolean(KEY_SETUP_DONE, false)
        set(value) {
            sp.edit().putBoolean(KEY_SETUP_DONE, value).apply()
        }

    /**
     * Last known state of "premium member + Watch without ads on". It is used at start-up, before the
     * page has reported the member's current state, so the blocker works from the first second.
     */
    var adFree: Boolean
        get() = sp.getBoolean(KEY_AD_FREE, false)
        set(value) {
            sp.edit().putBoolean(KEY_AD_FREE, value).apply()
        }

    private companion object {
        const val KEY_SETUP_DONE = "setup_done"
        const val KEY_AD_FREE = "ad_free"
    }
}
