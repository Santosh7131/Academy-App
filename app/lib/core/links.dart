import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'web_bits.dart';

// Opening a class's link to join it online (the timetable, api/src/lib/timetable.ts): the tutor's own Google Meet, Zoom, Jitsi or
// other class. The app has no video of its own, so joining leaves the app for the tutor's chosen service.

const _channel = MethodChannel('tuition_app/links');

/// True for a link the app opens: https, with a website and no login in it. The server takes no other kind of join link, and the
/// app checks again before it opens one.
bool isOpenableLink(String? url) {
  final u = Uri.tryParse(url ?? '');
  return u != null && u.scheme == 'https' && u.host.contains('.') && u.userInfo.isEmpty;
}

/// The website a link goes to, as the Join button names it: "meet.google.com".
String linkHost(String url) => Uri.tryParse(url)?.host ?? '';

/// Opens a join link outside the app: on a phone in the Meet, Zoom or Jitsi app when there is one, else the browser
/// (android/.../Links.kt); in a browser, in a new tab. False when it could not be opened.
Future<bool> openJoinLink(String url) async {
  if (!isOpenableLink(url)) return false;
  if (kIsWeb) {
    openInNewTab(url);
    return true;
  }
  try {
    return await _channel.invokeMethod<bool>('open', {'url': url}) ?? false;
  } on PlatformException {
    return false;
  } on MissingPluginException {
    return false;
  }
}
