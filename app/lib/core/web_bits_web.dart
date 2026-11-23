import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

// The web build's side of web_bits.dart, through the browser's own interfaces.

/// A browser tab opened at a tap, before the address it should show is known. A pop-up blocker lets a tab through only when it opens
/// during the tap, and a file's link comes from the server a moment later; so the tab opens empty at once and is sent on when the link
/// arrives, or closed when it does not.
class PendingTab {
  PendingTab(this._tab);
  final web.Window? _tab;

  void go(String url) {
    final tab = _tab;
    if (tab == null) {
      // The browser kept even the empty tab from opening: try once more, which some browsers allow, else open it here.
      if (web.window.open(url, '_blank') == null) web.window.location.href = url;
      return;
    }
    tab.location.href = url;
  }

  void close() => _tab?.close();
}

PendingTab openPendingTab() => PendingTab(web.window.open('', '_blank'));

/// Hands a file the app made (a receipt, a report, a printed test, a join QR code) to the person. On a phone's browser it opens the
/// phone's share sheet where the browser can share files; everywhere else, and when sharing is refused, the browser downloads it.
Future<void> saveOrShareFile(Uint8List bytes, {required String name, required String mimeType, String? text}) async {
  final parts = <web.BlobPart>[bytes.toJS].toJS;
  if (isPhoneBrowser) {
    try {
      final file = web.File(parts, name, web.FilePropertyBag(type: mimeType));
      final data = web.ShareData(files: <web.File>[file].toJS, text: text ?? '');
      if (web.window.navigator.canShare(data)) {
        await web.window.navigator.share(data).toDart;
        return;
      }
    } catch (e) {
      // Closing the share sheet is a choice, not a failure; any other refusal falls through to a download.
      if ('$e'.contains('AbortError')) return;
    }
  }
  final url = web.URL.createObjectURL(web.Blob(parts, web.BlobPropertyBag(type: mimeType)));
  final a = web.HTMLAnchorElement()
    ..href = url
    ..download = name;
  web.document.body!.appendChild(a);
  a.click();
  a.remove();
  Timer(const Duration(minutes: 1), () => web.URL.revokeObjectURL(url));
}

String get _agent => web.window.navigator.userAgent;

/// A phone's or a tablet's browser, where sharing a file and paying with a UPI app make sense.
bool get isPhoneBrowser => RegExp('Android|iPhone|iPad|iPod|Mobile').hasMatch(_agent);

/// Android's browsers open a upi:// link in the phone's UPI app.
bool get isAndroidBrowser => _agent.contains('Android');

void goTo(String url) => web.window.location.href = url;

/// Opens a link in a new tab, cut off from this page (a link someone typed must not be able to steer the app's tab). When the
/// browser blocks the tab, the link opens here instead.
void openInNewTab(String url) {
  final tab = web.window.open(url, '_blank');
  if (tab == null) {
    web.window.location.href = url;
  } else {
    tab.opener = null;
  }
}

/// "Chrome on Windows", for the developer's list of the devices in use.
String browserLabel() {
  final a = _agent;
  final browser = a.contains('Edg/')
      ? 'Edge'
      : a.contains('OPR/') || a.contains('Opera')
          ? 'Opera'
          : a.contains('Firefox/')
              ? 'Firefox'
              : a.contains('Chrome/')
                  ? 'Chrome'
                  : a.contains('Safari/')
                      ? 'Safari'
                      : 'Browser';
  final os = a.contains('Android')
      ? 'Android'
      : a.contains('iPhone') || a.contains('iPad')
          ? 'iOS'
          : a.contains('Windows')
              ? 'Windows'
              : a.contains('Mac OS')
                  ? 'macOS'
                  : a.contains('Linux')
                      ? 'Linux'
                      : '';
  return os.isEmpty ? browser : '$browser on $os';
}

/// The address the app was loaded from, where its own files (version.json) sit beside it.
String pageBase() => web.document.baseURI;

/// Sends [bytes] to a storage link with PUT, reporting the bytes as they go, and answers storage's status.
Future<int> putWithProgress(String url, Uint8List bytes, Map<String, String> headers, void Function(int bytes) sent) {
  final done = Completer<int>();
  final xhr = web.XMLHttpRequest()..open('PUT', url);
  headers.forEach((k, v) {
    // The browser sets these itself and refuses them from a page.
    if (!const {'content-length', 'host'}.contains(k.toLowerCase())) xhr.setRequestHeader(k, v);
  });
  var reported = 0;
  void upTo(int n) {
    if (n > reported) {
      sent(n - reported);
      reported = n;
    }
  }

  xhr.upload.onprogress = ((web.ProgressEvent e) => upTo(e.loaded.toInt())).toJS;
  xhr.onload = ((web.Event _) {
    if (xhr.status >= 200 && xhr.status < 300) upTo(bytes.length);
    if (!done.isCompleted) done.complete(xhr.status);
  }).toJS;
  void failed(web.Event _) {
    if (!done.isCompleted) done.completeError(http.ClientException('The upload stopped.', Uri.parse(url)));
  }

  xhr.onerror = failed.toJS;
  xhr.onabort = failed.toJS;
  xhr.send(bytes.toJS);
  return done.future;
}
