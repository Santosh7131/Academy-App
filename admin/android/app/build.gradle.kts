import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// The same release key as the main app (app/android/key.properties names it): one key to keep
// safe. admin/android/key.properties names it and holds its passwords; it is git-ignored.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

// The launcher label is the product's name from lib/core/brand.dart (copied from the tutor app by tools/sync-admin-ui.mjs), the one place it is set.
val brand = file("../../lib/core/brand.dart").readText()
val productName: String = Regex("""const appName = '([^']+)';""").find(brand)?.groupValues?.get(1)
    ?: throw GradleException("No appName in lib/core/brand.dart")

// The app id, set beside the name in lib/core/brand.dart. It can never change once phones have the app.
val appId: String = Regex("""const adminAndroidAppId = '([^']+)';""").find(brand)?.groupValues?.get(1)
    ?: throw GradleException("No adminAndroidAppId in lib/core/brand.dart")

android {
    namespace = "com.tuitionapp.admin"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = appId
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["appLabel"] = "$productName Admin"
    }

    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = keystoreProperties["keyPassword"] as String?
            storeFile = keystoreProperties["storeFile"]?.let { rootProject.file(it as String) }
            storePassword = keystoreProperties["storePassword"] as String?
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            manifestPlaceholders["appLabel"] = "$productName Admin Dev"
        }
        release {
            signingConfig = signingConfigs.getByName(if (keystorePropertiesFile.exists()) "release" else "debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
