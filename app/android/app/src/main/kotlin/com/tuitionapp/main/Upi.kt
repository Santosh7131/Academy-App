package com.tuitionapp.main

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Opens a UPI app with a fee payment filled in (lib/core/upi.dart builds the upi://pay link). The payer checks it and pays in
 * their own app, straight to the tutor. Nothing comes back here, so the app never says a payment went through: the student says
 * so, and the tutor confirms it. Trying to start the app, rather than asking Android first which apps there are, needs no
 * <queries> entry in the manifest.
 */
object Upi {
    const val CHANNEL = "tuition_app/upi"

    fun handle(activity: Activity, call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "pay") {
            result.notImplemented()
            return
        }
        val link = call.argument<String>("link")
        if (link == null || !link.startsWith("upi://pay?")) {
            result.error("bad_call", "A UPI pay link is needed.", null)
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
            result.success(true)
        } catch (e: ActivityNotFoundException) {
            result.success(false)
        }
    }
}
