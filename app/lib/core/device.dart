import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'web_bits.dart';

/// What the app tells the server about itself on every request (from 1.2.1), so the developer's
/// admin app can show each account's phones and the version they run. Nothing personal: a random
/// id made up on first launch, the phone's maker and model, the Android version, the app version.
class Device {
  Device._();

  static final headers = <String, String>{};

  static Future<void> load() async {
    if (kIsWeb) return _loadWeb();
    if (!Platform.isAndroid) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      var id = prefs.getString('install_id');
      if (id == null) {
        final r = Random.secure();
        id = List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
        await prefs.setString('install_id', id);
      }
      headers['x-install-id'] = id;
    } catch (_) {
      // Without storage the requests just go without an id, as from older versions.
    }
    try {
      final info = await const MethodChannel('tuition_app/updater').invokeMapMethod<String, dynamic>('info');
      if (info?['version'] != null) headers['x-app'] = 'tuition_app/${info!['version']}+${info['build']}';
      if (info?['model'] != null) headers['x-device'] = '${info!['model']}';
      if (info?['os'] != null) headers['x-os'] = '${info!['os']}';
    } on PlatformException {
      // Not on a phone build: no details to send.
    }
  }

  /// In a browser: an id kept in the browser's storage for this site, the browser by name, and the app's version from version.json,
  /// which `flutter build web` writes beside the app from pubspec.yaml. The server then treats the web app as the app it was built
  /// from; without a version it would count it as an old app and leave courses out.
  static Future<void> _loadWeb() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      var id = prefs.getString('install_id');
      if (id == null) {
        final r = Random.secure();
        id = List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
        await prefs.setString('install_id', id);
      }
      headers['x-install-id'] = id;
    } catch (_) {
      // A browser that keeps nothing for the site: the requests go without an id.
    }
    headers['x-os'] = 'web';
    final browser = browserLabel();
    if (browser.isNotEmpty) headers['x-device'] = browser;
    try {
      final at = Uri.parse(pageBase()).resolve('version.json').replace(queryParameters: {'t': '${DateTime.now().millisecondsSinceEpoch}'});
      final v = jsonDecode((await http.get(at).timeout(const Duration(seconds: 5))).body);
      if (v is Map && v['version'] != null) {
        headers['x-app'] = 'tuition_app/${v['version']}${v['build_number'] == null ? '' : '+${v['build_number']}'}';
      }
    } catch (_) {
      // Served without version.json: the server takes it for an older app.
    }
  }
}
