import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'config.dart';
import 'screens/deliveries_screen.dart';
import 'services/api_client.dart';
import 'services/app_store.dart';
import 'services/helmet_link.dart';

/// The three long lived objects every screen needs.
class Services {
  Services({required this.store, required this.api, required this.helmet});

  final AppStore store;
  final ApiClient api;
  final HelmetLink helmet;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await AppStore.open();
  final services = Services(store: store, api: ApiClient(store), helmet: HelmetLink(store));
  runApp(HelmetProofApp(services: services));
}

class HelmetProofApp extends StatefulWidget {
  const HelmetProofApp({super.key, required this.services});

  final Services services;

  @override
  State<HelmetProofApp> createState() => _HelmetProofAppState();
}

class _HelmetProofAppState extends State<HelmetProofApp> {
  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    // Bluetooth to reach the helmet, notifications for the tracking notice.
    await [Permission.bluetoothScan, Permission.bluetoothConnect, Permission.notification].request();
    final services = widget.services;
    if (services.store.helmetId.isNotEmpty) {
      services.helmet.connect(services.store.helmetId);
    }
    services.api.flush();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Helmet Proof Driver',
        theme: buildTheme(),
        home: DeliveriesScreen(services: widget.services),
      );
}
