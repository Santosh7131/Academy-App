import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'changes.dart';
import 'device.dart';

/// The API's address, given when the app is built: --dart-define=API_BASE=https://... (tools/release-app.ps1 passes the live
/// one). A debug build without it reads the API on this PC as an Android emulator sees it (tools/out/dev-serve.mjs on port 18787);
/// a phone on the same Wi-Fi needs the PC's address instead. A release build without it has no server at all: [apiMissing], and the
/// app says so instead of starting.
const apiBase = String.fromEnvironment('API_BASE', defaultValue: kReleaseMode ? '' : 'http://10.0.2.2:18787');

/// True for a build made without a server address (a release build without API_BASE).
const apiMissing = apiBase == '';

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.data = const {}]);
  final int status;
  final String code;
  final String message;

  /// Everything else the server said about it, such as the credit left and what the work needs (`no_credit`).
  final Map<String, dynamic> data;

  bool get offline => status == 0;

  @override
  String toString() => message;
}

class Api {
  Api._();
  static final instance = Api._();

  final _client = http.Client();
  String? token;

  /// The tuition the app is showing, sent with every request. Without it the server answers for the
  /// person's first tuition, which is all a person with one needs.
  String? tuitionId;

  /// Called when the server says the session is gone (the password changed on another phone, the login turned off).
  void Function()? onSignedOut;

  /// Called when the server says the person is no longer in the tuition the app was showing.
  void Function()? onTuitionGone;

  /// Called when the server says this version of the app can no longer be used (a major update is out).
  void Function()? onUpdateRequired;

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body, Duration? timeout]) => _send('POST', path, body: body, timeout: timeout);
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body: body);
  Future<dynamic> patch(String path, [Object? body]) => _send('PATCH', path, body: body);
  Future<dynamic> delete(String path) => _send('DELETE', path);

  /// A read that cannot connect is tried once more after this short wait. A phone that has sat idle often finds the connection it was going
  /// to reuse closed by the network, and the first request on it fails although the internet is fine.
  static const _retryAfter = Duration(milliseconds: 700);

  Future<dynamic> _send(String method, String path, {Object? body, Duration? timeout}) async {
    final limit = timeout ?? const Duration(seconds: 25);
    // A request can be sent only once, so every try builds its own.
    http.Request build() {
      final req = http.Request(method, Uri.parse('$apiBase$path'));
      req.headers.addAll(Device.headers);
      if (token != null) req.headers['authorization'] = 'Bearer $token';
      if (tuitionId != null) req.headers['x-tuition'] = tuitionId!;
      if (body != null) {
        req.headers['content-type'] = 'application/json';
        req.body = jsonEncode(body);
      }
      return req;
    }

    http.Response res;
    for (var attempt = 0;; attempt++) {
      try {
        // The whole answer has to arrive in time, not only its first line: a connection that stalls after the headers would otherwise be
        // waited on for ever.
        res = await (() async => http.Response.fromStream(await _client.send(build())))().timeout(limit);
        break;
      } on TimeoutException {
        throw ApiException(0, 'offline', 'The server is taking too long. Check your internet and try again.');
      } on SocketException {
        // Only a read is sent again: a write that failed may still have gone through.
        if (method == 'GET' && attempt == 0) {
          await Future<void>.delayed(_retryAfter);
          continue;
        }
        throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
      } on http.ClientException {
        if (method == 'GET' && attempt == 0) {
          await Future<void>.delayed(_retryAfter);
          continue;
        }
        throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
      }
    }
    dynamic json;
    try {
      json = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      json = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Screens showing what this write changed load it again.
      if (method != 'GET') changes.report(path);
      return json;
    }
    final err = json is Map ? json['error'] : null;
    final e = ApiException(
      res.statusCode,
      err is Map ? '${err['code']}' : 'server_error',
      err is Map ? '${err['message']}' : 'Something went wrong. Please try again.',
      err is Map ? Map<String, dynamic>.from(err) : const {},
    );
    if (e.status == 401 && e.code == 'signed_out' && token != null) onSignedOut?.call();
    if (e.status == 403 && e.code == 'not_a_member') onTuitionGone?.call();
    if (e.status == 426 && e.code == 'update_required') onUpdateRequired?.call();
    throw e;
  }

  /// Uploads bytes straight to object storage with a presigned URL.
  Future<void> putBytes(String url, List<int> bytes, {String contentType = 'image/jpeg'}) async {
    try {
      final res = await _client
          .put(Uri.parse(url), headers: {'content-type': contentType}, body: bytes)
          .timeout(const Duration(seconds: 60));
      if (res.statusCode >= 300) throw ApiException(res.statusCode, 'upload_failed', 'The upload did not go through. Try again.');
    } on SocketException {
      throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
    } on http.ClientException {
      // What a browser's request throws when it cannot connect.
      throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
    } on TimeoutException {
      throw ApiException(0, 'offline', 'The upload is taking too long. Check your internet and try again.');
    }
  }

  /// Downloads a file from object storage with a presigned URL (a question's figure, to print it).
  Future<List<int>> getBytes(String url) async {
    try {
      final res = await _client.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
      if (res.statusCode >= 300) throw ApiException(res.statusCode, 'download_failed', 'A picture did not download. Try again.');
      return res.bodyBytes;
    } on SocketException {
      throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
    } on http.ClientException {
      throw ApiException(0, 'offline', 'No internet connection. Check your connection and try again.');
    } on TimeoutException {
      throw ApiException(0, 'offline', 'The download is taking too long. Check your internet and try again.');
    }
  }
}

final api = Api.instance;
