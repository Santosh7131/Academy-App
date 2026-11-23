import 'dart:typed_data';

// The phone build's side of web_bits.dart. Nothing here is called on a phone; it is here so the phone build compiles.

/// A browser tab opened at a tap, before the address it should show is known.
class PendingTab {
  void go(String url) {}
  void close() {}
}

PendingTab openPendingTab() => PendingTab();

Future<void> saveOrShareFile(Uint8List bytes, {required String name, required String mimeType, String? text}) async =>
    throw UnsupportedError('Only the web build saves files through the browser.');

bool get isPhoneBrowser => false;

bool get isAndroidBrowser => false;

void goTo(String url) {}

void openInNewTab(String url) {}

String browserLabel() => '';

String pageBase() => '';

Future<int> putWithProgress(String url, Uint8List bytes, Map<String, String> headers, void Function(int bytes) sent) async =>
    throw UnsupportedError('Only the web build uploads through the browser.');
