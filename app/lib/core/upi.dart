import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'web_bits.dart';

// Paying a tutor by UPI. The money goes from the payer's own UPI app straight to the tutor's UPI id: the app only fills in the
// payment, and never learns whether it went through, so it never says a payment succeeded. The student says "I have paid" and the
// tutor confirms it (api/src/routes/fees.ts).

/// The longest payment note: UPI apps cut longer ones short.
const upiNoteMax = 50;

/// The amount as a UPI link writes it, rupees with two decimals, from whole paise with no floating point: 150000 is "1500.00".
String upiAmount(int paise) => '${paise ~/ 100}.${(paise % 100).toString().padLeft(2, '0')}';

/// A UPI pay link, as NPCI's UPI linking specification writes one: pa the UPI id, pn the payee's name, am the amount, cu the
/// currency (INR) and tn a note. A personal UPI id needs no merchant fields. The id is left as it is (letters, digits, dots,
/// dashes, underscores and one @, all fine in a link); the name and the note are encoded.
String upiLink({required String id, required String name, required int paise, required String note}) {
  final n = note.length > upiNoteMax ? note.substring(0, upiNoteMax) : note;
  return 'upi://pay?pa=$id&pn=${Uri.encodeComponent(name)}&am=${upiAmount(paise)}&cu=INR&tn=${Uri.encodeComponent(n)}';
}

const _channel = MethodChannel('tuition_app/upi');

/// Opens a UPI app on this phone with the payment filled in (android/.../Upi.kt). False when the phone has no UPI app.
///
/// In a browser: Android's browsers hand a upi:// link to the phone's UPI apps, so the page goes to it. A computer, or a browser that
/// cannot tell, answers false, and the screen offers the code to scan instead.
Future<bool> openUpiApp(String link) async {
  if (kIsWeb) {
    if (!isAndroidBrowser) return false;
    goTo(link);
    return true;
  }
  try {
    return await _channel.invokeMethod<bool>('pay', {'link': link}) ?? false;
  } on PlatformException {
    return false;
  } on MissingPluginException {
    return false;
  }
}
