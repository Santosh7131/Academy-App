package com.tuitionapp.main

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Opens a class's link to join it online (lib/core/links.dart) in whatever the phone uses for it: the Google Meet, Zoom or Jitsi
 * app when one is installed, else the browser. Only https links with a website: the server takes no other kind of join link
 * (api/src/lib/timetable.ts), and this checks again. Trying to start the app, rather than asking Android first which apps there
 * are, needs no <queries> entry in the manifest.
 */
object Links {
    const val CHANNEL = "tuition_app/links"

    fun handle(activity: Activity, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "open") {
            result.notImplemented()
            return
        }
        val uri = call.argument<String>("url")?.let { Uri.parse(it) }
        if (uri == null || uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.userInfo != null) {
            result.error("bad_call", "An https link is needed.", null)
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            result.success(true)
        } catch (e: ActivityNotFoundException) {
            result.success(false)
        }
    }
}
