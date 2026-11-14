import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import '../config.dart';
import '../main.dart';
import '../widgets.dart';

/// One time setup: server, driver token, hotspot login and helmet pairing.
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.services});

  final Services services;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  late final TextEditingController _url;
  late final TextEditingController _token;
  late final TextEditingController _ssid;
  late final TextEditingController _pass;

  List<ScanResult> _found = [];
  bool _scanning = false;
  String? _notice;

  @override
  void initState() {
    super.initState();
    final store = widget.services.store;
    _url = TextEditingController(text: store.serverUrl);
    _token = TextEditingController(text: store.driverToken);
    _ssid = TextEditingController(text: store.hotspotSsid);
    _pass = TextEditingController(text: store.hotspotPass);
  }

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    _ssid.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final url = _url.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setState(() => _notice = 'The server address must start with http:// or https://');
      return;
    }
    if (_token.text.trim().isEmpty) {
      setState(() => _notice = 'Enter your driver token.');
      return;
    }
    final services = widget.services;
    await services.store.saveServer(url: url, token: _token.text);
    await services.store.saveHotspot(ssid: _ssid.text, pass: _pass.text);
    await services.helmet.pushSettings();
    if (!mounted) return;
    setState(() => _notice = services.helmet.connected
        ? 'Saved, and sent to the helmet camera.'
        : 'Saved. The helmet camera will get these settings when it connects.');
  }

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _notice = null;
    });
    try {
      final found = await widget.services.helmet.scan();
      if (!mounted) return;
      setState(() {
        _found = found;
        if (found.isEmpty) {
          _notice = 'No helmet camera found. Check that it is powered and Bluetooth is on.';
        }
      });
    } catch (_) {
      if (mounted) setState(() => _notice = 'Bluetooth scan failed. Check that Bluetooth is on.');
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _pair(ScanResult result) async {
    final services = widget.services;
    final name = result.device.platformName.isEmpty ? 'Helmet camera' : result.device.platformName;
    await services.store.saveHelmet(id: result.device.remoteId.str, name: name);
    await services.helmet.connect(result.device.remoteId.str);
    if (!mounted) return;
    setState(() {
      _found = [];
      _notice = services.helmet.connected
          ? 'Paired with $name.'
          : 'Saved $name. It will connect when it is in range.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final store = widget.services.store;
    const gap = SizedBox(height: 12);
    return Scaffold(
      appBar: AppBar(title: const Text('Setup')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Server', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                gap,
                TextField(
                  controller: _url,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Server address',
                    hintText: 'http://192.168.43.10:3000',
                  ),
                ),
                gap,
                TextField(
                  controller: _token,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: 'Driver token'),
                ),
              ],
            ),
          ),
          gap,
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Phone hotspot',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                const Text(
                  'The helmet camera uploads videos through your hotspot. Keep the hotspot on during your shift.',
                  style: TextStyle(color: AppColors.textMuted),
                ),
                gap,
                TextField(
                  controller: _ssid,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: 'Hotspot name'),
                ),
                gap,
                TextField(
                  controller: _pass,
                  obscureText: true,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: 'Hotspot password'),
                ),
              ],
            ),
          ),
          gap,
          FilledButton(onPressed: _save, child: const Text('Save settings')),
          gap,
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Helmet camera',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(
                  store.helmetId.isEmpty ? 'No helmet camera paired yet.' : 'Paired with ${store.helmetName}.',
                  style: const TextStyle(color: AppColors.textMuted),
                ),
                gap,
                OutlinedButton.icon(
                  onPressed: _scanning ? null : _scan,
                  icon: const Icon(Icons.bluetooth_searching),
                  label: Text(_scanning ? 'Searching' : 'Find helmet camera'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.text,
                    minimumSize: const Size.fromHeight(48),
                  ),
                ),
                for (final result in _found)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.videocam, color: AppColors.text),
                    title: Text(result.device.platformName.isEmpty
                        ? result.device.remoteId.str
                        : result.device.platformName),
                    subtitle: Text('Signal ${result.rssi} dBm'),
                    trailing: TextButton(onPressed: () => _pair(result), child: const Text('Pair')),
                  ),
              ],
            ),
          ),
          if (_notice != null) ...[
            gap,
            Panel(color: AppColors.attention, child: Text(_notice!)),
          ],
        ],
      ),
    );
  }
}
