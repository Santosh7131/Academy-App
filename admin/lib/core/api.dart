import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'device.dart';

/// The API the app reads, given when the app is built: --dart-define=API_BASE=https://... A debug build without it reads the API
/// on this PC as an Android emulator sees it (tools/out/dev-serve.mjs on port 18787). A release build without it has no server:
/// [apiMissing], and the app says so instead of starting.
const apiBase = String.fromEnvironment('API_BASE', defaultValue: kReleaseMode ? '' : 'http://10.0.2.2:18787');

/// True for a build made without a server address (a release build without API_BASE).
const apiMissing = apiBase == '';

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  @override
  String toString() => message;
}

class Api {
  Api._();
  static final instance = Api._();

  final _client = http.Client();
  String? token;

  /// How long the last request took, end to end, in milliseconds.
  int? lastMs;

  /// Called when the server says the session is gone.
  void Function()? onSignedOut;

  String get base => apiBase;

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body);
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body: body);

  Future<dynamic> _send(String method, String path, {Object? body}) async {
    final req = http.Request(method, Uri.parse('$base$path'));
    req.headers.addAll(Device.headers);
    if (token != null) req.headers['authorization'] = 'Bearer $token';
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final started = DateTime.now();
    http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 30)));
    } on TimeoutException {
      throw ApiException(0, 'offline', 'The server is taking too long. Check the internet and try again.');
    } on SocketException {
      throw ApiException(0, 'offline', 'No internet connection.');
    } on http.ClientException {
      throw ApiException(0, 'offline', 'No internet connection.');
    }
    lastMs = DateTime.now().difference(started).inMilliseconds;
    dynamic json;
    try {
      json = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      json = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final err = json is Map ? json['error'] : null;
    final e = ApiException(
      res.statusCode,
      err is Map ? '${err['code']}' : 'server_error',
      err is Map ? '${err['message']}' : 'The server answered ${res.statusCode}.',
    );
    if (e.status == 401 && token != null) onSignedOut?.call();
    throw e;
  }
}

final api = Api.instance;
