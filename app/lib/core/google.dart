import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'api.dart';

/// Google sign-in on this phone. The server says which Google client to ask for a token (GET /auth/config); with none set
/// there, Google sign-in is off and no Google button shows. The token goes to the server, which checks it with Google's keys
/// and keeps only the account's number: no email address or photo is stored.
class GoogleAuth {
  GoogleAuth._();

  static Future<String?>? _asked;
  static Future<void>? _ready;

  static const _failed = 'Google sign-in did not work. Please try again, or log in with your username and password.';

  /// The Google client to sign in with, or null when Google sign-in is off (or the server could not be reached: the next
  /// screen asks again).
  static Future<String?> clientId() => _asked ??= () async {
        try {
          final r = await api.get('/auth/config');
          final id = r is Map ? r['google_client_id'] : null;
          return id is String && id.isNotEmpty ? id : null;
        } catch (_) {
          _asked = null;
          return null;
        }
      }();

  /// Lets the person pick a Google account and returns its ID token, or null when they close Google's sheet without picking.
  static Future<String?> idToken() async {
    final id = await clientId();
    if (id == null) throw ApiException(403, 'google_off', 'Google sign-in is not set up yet.');
    try {
      // Google's library is set up once per app start, with the client the server named.
      await (_ready ??= GoogleSignIn.instance.initialize(serverClientId: id));
    } catch (e) {
      _ready = null;
      debugPrint('google sign-in setup: $e');
      throw ApiException(0, 'google_failed', _failed);
    }
    try {
      final account = await GoogleSignIn.instance.authenticate();
      final token = account.authentication.idToken;
      if (token == null || token.isEmpty) throw ApiException(0, 'google_failed', _failed);
      return token;
    } on GoogleSignInException catch (e) {
      // Closing the sheet is not a failure. (A phone set up wrongly can also say "canceled": Google's library cannot tell them apart.)
      if (e.code == GoogleSignInExceptionCode.canceled || e.code == GoogleSignInExceptionCode.interrupted) return null;
      debugPrint('google sign-in: $e');
      throw ApiException(0, 'google_failed', _failed);
    }
  }

  /// Signs Google out on this phone too, so the next Google sign-in asks which account to use.
  static Future<void> signOut() async {
    if (_ready == null) return;
    try {
      await GoogleSignIn.instance.signOut();
    } catch (_) {}
  }

  /// For widget tests: what [clientId] answers, with no server. Null turns Google sign-in off.
  @visibleForTesting
  static void pretend(String? clientId) => _asked = Future.value(clientId);
}
