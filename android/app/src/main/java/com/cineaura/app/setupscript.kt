package com.cineaura.app

/**
 * Writes the first-run choices into the website's localStorage, using the same keys the site uses
 * (see js/common.js: cineaura_lang, cineaura_country, cineaura_theme). The site reads them on load.
 */
object SetupScript {

    private val CODE = Regex("[a-z]{2}")
    private val COUNTRY = Regex("[A-Z]{2}")

    fun save(lang: String, country: String, theme: String): String {
        require(lang.matches(CODE)) { "bad language code" }
        require(country.isEmpty() || country.matches(COUNTRY)) { "bad country code" }
        require(theme == "day" || theme == "night") { "bad theme" }

        val countryPart = if (country.isEmpty()) {
            "localStorage.removeItem('cineaura_country');"
        } else {
            "localStorage.setItem('cineaura_country','$country');"
        }
        return "(function(){try{" +
            "localStorage.setItem('cineaura_lang','$lang');" +
            countryPart +
            "localStorage.setItem('cineaura_theme','$theme');" +
            "return true;}catch(e){return false;}})();"
    }
}
