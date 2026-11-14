import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models.dart';
import 'app_store.dart';

class ApiException implements Exception {
  ApiException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Talks to the server as the driver.
///
/// Anything the server must eventually hear about (events, "delivered") goes
/// through [send], which keeps it in an outbox on the phone until it gets
/// through. A weak signal at the door therefore never loses a delivery.
class ApiClient {
  ApiClient(this._store);

  final AppStore _store;
  bool _flushing = false;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ${_store.driverToken}',
      };

  Future<List<Delivery>> fetchDeliveries() async {
    final http.Response response;
    try {
      response = await http
          .get(Uri.parse('${_store.serverUrl}/api/driver/deliveries'), headers: _headers)
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      throw ApiException('Could not reach the server. Check the connection and the server address.');
    }
    if (response.statusCode == 401) {
      throw ApiException('The server did not accept the driver token.');
    }
    if (response.statusCode != 200) {
      throw ApiException('The server answered with an error (${response.statusCode}).');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return (body['deliveries'] as List)
        .map((item) => Delivery.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  /// Sends the rider's live position. Not queued in the outbox: a position
  /// that arrives late is no use to anyone watching the map.
  Future<void> sendLocation({
    required double lat,
    required double lon,
    double? accuracy,
    double? speed,
    double? heading,
    String? deliveryId,
  }) async {
    if (!_store.isConfigured) return;
    try {
      await http
          .post(
            Uri.parse('${_store.serverUrl}/api/driver/location'),
            headers: _headers,
            body: jsonEncode({
              'lat': lat,
              'lon': lon,
              if (accuracy != null) 'accuracy': accuracy,
              if (speed != null && speed >= 0) 'speed': speed,
              if (heading != null && heading >= 0) 'heading': heading,
              if (deliveryId != null) 'deliveryId': deliveryId,
            }),
          )
          .timeout(const Duration(seconds: 8));
    } catch (_) {
      // Offline for a moment; the next position will go through.
    }
  }

  Future<void> sendEvent(String deliveryId, String type, {String? recordingId, String? detail}) =>
      send('/api/driver/deliveries/$deliveryId/events', {
        'type': type,
        if (recordingId != null) 'recordingId': recordingId,
        if (detail != null) 'detail': detail,
      });

  /// Queues a POST and tries to deliver the whole outbox.
  Future<void> send(String path, Map<String, dynamic> body) async {
    final outbox = _store.outbox
      ..add({
        'path': path,
        'body': {...body, 'at': DateTime.now().millisecondsSinceEpoch},
      });
    await _store.saveOutbox(outbox);
    unawaited(flush());
  }

  /// Sends queued requests in order. Stops at the first network failure.
  Future<void> flush() async {
    if (_flushing || !_store.isConfigured) return;
    _flushing = true;
    try {
      while (true) {
        final outbox = _store.outbox;
        if (outbox.isEmpty) break;
        final item = outbox.first;
        final http.Response response;
        try {
          response = await http
              .post(Uri.parse('${_store.serverUrl}${item['path']}'),
                  headers: _headers, body: jsonEncode(item['body']))
              .timeout(const Duration(seconds: 10));
        } catch (_) {
          break; // offline: keep everything and try again later
        }
        // Server errors and a rejected token are worth retrying. Anything else
        // means the server will never accept this request, so drop it.
        if (response.statusCode >= 500 || response.statusCode == 401) break;
        await _store.saveOutbox(_store.outbox.sublist(1));
      }
    } finally {
      _flushing = false;
    }
  }
}
