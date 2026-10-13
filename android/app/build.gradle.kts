plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cineaura.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cineaura.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        // The live website the app opens. Change this one value to point the app elsewhere.
        // It must be a public https address: a phone cannot reach localhost or a sandbox preview.
        buildConfigField("String", "SITE_URL", "\"https://cineaura1.netlify.app/\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
