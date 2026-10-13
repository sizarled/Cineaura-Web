package com.cineaura.app

import java.util.Locale

/**
 * Host rules used by the WebView.
 *
 * - "Our site" is CineAura itself (and its subdomains). Anything else counts as "outside the site".
 * - AD_HOSTS is the built-in ad blocker's list. It is used only while the member has a premium plan
 *   and switched on "Watch without ads"; in every other case ads are allowed.
 *   Add or remove hosts here to change what the blocker stops.
 */
object SiteRules {

    private val AD_HOSTS = setOf(
        // ad networks used by the site's own banners and pop-unders
        "profitableratecpmnetwork.com",
        "highrevenueformat.com",
        "highperformanceformat.com",
        "highrevenuegate.com",
        "highrevenuenetwork.com",
        "effectivegatecpm.com",
        "adsterra.com",
        "adsterra.net",
        // common ad networks, pop-under and tracking services
        "popads.net",
        "popcash.net",
        "propellerads.com",
        "onclickads.net",
        "exoclick.com",
        "juicyads.com",
        "trafficjunky.net",
        "adcash.com",
        "revcontent.com",
        "bidvertiser.com",
        "adnxs.com",
        "criteo.com",
        "taboola.com",
        "outbrain.com",
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "moatads.com",
        "adform.net",
        "pubmatic.com",
        "rubiconproject.com",
        "smartadserver.com",
        "yieldmo.com",
    )

    /** True for CineAura's own host, e.g. "cineaura.app" and "www.cineaura.app". */
    fun isSiteHost(host: String?, siteHost: String): Boolean {
        if (host.isNullOrEmpty() || siteHost.isEmpty()) return false
        val h = host.lowercase(Locale.ROOT)
        val base = siteHost.lowercase(Locale.ROOT).removePrefix("www.")
        return h == base || h.endsWith(".$base")
    }

    /** True for a host on the ad blocker list (or one of its subdomains). */
    fun isAdHost(host: String?): Boolean {
        if (host.isNullOrEmpty()) return false
        val h = host.lowercase(Locale.ROOT)
        return AD_HOSTS.any { h == it || h.endsWith(".$it") }
    }
}
