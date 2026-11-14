import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Settings and small bits of state that must survive an app restart.
class AppStore {
  AppStore(this._prefs);

  final SharedPreferences _prefs;

  static Future<AppStore> open() async => AppStore(await SharedPreferences.getInstance());

  String get serverUrl => _prefs.getString('serverUrl') ?? '';
  String get driverToken => _prefs.getString('driverToken') ?? '';
  String get helmetId => _prefs.getString('helmetId') ?? '';
  String get helmetName => _prefs.getString('helmetName') ?? '';
  String get hotspotSsid => _prefs.getString('hotspotSsid') ?? '';
  String get hotspotPass => _prefs.getString('hotspotPass') ?? '';

  bool get isConfigured => serverUrl.isNotEmpty && driverToken.isNotEmpty;

  Future<void> saveServer({required String url, required String token}) async {
    var clean = url.trim();
    while (clean.endsWith('/')) {
      clean = clean.substring(0, clean.length - 1);
    }
    await _prefs.setString('serverUrl', clean);
    await _prefs.setString('driverToken', token.trim());
  }

  Future<void> saveHotspot({required String ssid, required String pass}) async {
    await _prefs.setString('hotspotSsid', ssid.trim());
    await _prefs.setString('hotspotPass', pass);
  }

  Future<void> saveHelmet({required String id, required String name}) async {
    await _prefs.setString('helmetId', id);
    await _prefs.setString('helmetName', name);
  }

  /// Highest recording attempt this phone has started for a delivery.
  int attemptsFor(String deliveryId) => _prefs.getInt('attempts.$deliveryId') ?? 0;

  Future<void> setAttempts(String deliveryId, int attempts) =>
      _prefs.setInt('attempts.$deliveryId', attempts);

  /// Requests that could not reach the server yet, oldest first.
  List<Map<String, dynamic>> get outbox {
    final raw = _prefs.getString('outbox');
    if (raw == null) return [];
    return (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
  }

  Future<void> saveOutbox(List<Map<String, dynamic>> items) =>
      _prefs.setString('outbox', jsonEncode(items));
}
