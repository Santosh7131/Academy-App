import 'package:flutter/foundation.dart';

import 'web_bits_stub.dart' if (dart.library.js_interop) 'web_bits_web.dart';

// What the web build reaches the browser through: saving or sharing a file the app made, a new tab, an upload that reports its
// progress, and what kind of browser it runs in. A phone build gets the stand-ins in web_bits_stub.dart, which it never calls: each
// caller asks kIsWeb first and keeps its phone code as it was.
export 'web_bits_stub.dart' if (dart.library.js_interop) 'web_bits_web.dart';

/// In a computer's browser a file the app makes (a receipt, a report, a printed test, a QR code) is saved as a download; on a phone,
/// in the app or a browser, it goes to the share sheet. Buttons say which.
bool get savesFiles => kIsWeb && !isPhoneBrowser;
