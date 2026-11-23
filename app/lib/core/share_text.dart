import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

/// Shares a message (a reminder, a join link, the details to pay) through a share sheet: the phone's in the app, the browser's own
/// in a browser. A browser with none (Firefox, and most on Linux) copies the message instead of opening an email, and the screen
/// says so: true when it was copied.
Future<bool> shareText(String text, {String? subject}) async {
  if (!kIsWeb) {
    await SharePlus.instance.share(ShareParams(text: text, subject: subject));
    return false;
  }
  try {
    await SharePlus.instance.share(ShareParams(text: text, subject: subject, mailToFallbackEnabled: false));
    return false;
  } catch (_) {
    await Clipboard.setData(ClipboardData(text: text));
    return true;
  }
}

/// What a screen says when [shareText] copied the message.
const copiedNotice = 'Copied. Paste it into WhatsApp or a message.';
