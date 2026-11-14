import 'package:flutter/material.dart';

import '../config.dart';
import '../main.dart';
import '../models.dart';
import '../services/api_client.dart';
import '../widgets.dart';
import 'active_delivery_screen.dart';
import 'setup_screen.dart';

/// Home screen: the driver's open deliveries.
class DeliveriesScreen extends StatefulWidget {
  const DeliveriesScreen({super.key, required this.services});

  final Services services;

  @override
  State<DeliveriesScreen> createState() => _DeliveriesScreenState();
}

class _DeliveriesScreenState extends State<DeliveriesScreen> {
  List<Delivery> _deliveries = [];
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final services = widget.services;
    if (!services.store.isConfigured) {
      setState(() => _error = null);
      return;
    }
    setState(() => _loading = true);
    try {
      await services.api.flush();
      final deliveries = await services.api.fetchDeliveries();
      if (!mounted) return;
      setState(() {
        _deliveries = deliveries;
        _error = null;
      });
    } on ApiException catch (failure) {
      if (!mounted) return;
      setState(() => _error = failure.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openSetup() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => SetupScreen(services: widget.services)),
    );
    _load();
  }

  Future<void> _openDelivery(Delivery delivery) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ActiveDeliveryScreen(services: widget.services, delivery: delivery),
      ),
    );
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final configured = widget.services.store.isConfigured;
    return Scaffold(
      appBar: AppBar(
        title: const Text('My deliveries'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Setup',
            onPressed: _openSetup,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            HelmetBadge(helmet: widget.services.helmet),
            const SizedBox(height: 16),
            if (!configured)
              _Message(
                icon: Icons.settings,
                title: 'Finish setup first',
                text: 'Add the server address, your driver token and your helmet camera.',
                action: FilledButton(onPressed: _openSetup, child: const Text('Open setup')),
              )
            else if (_error != null)
              _Message(
                icon: Icons.cloud_off,
                title: 'Deliveries could not load',
                text: _error!,
                action: FilledButton(onPressed: _load, child: const Text('Try again')),
              )
            else if (_loading && _deliveries.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator(color: AppColors.accent)),
              )
            else if (_deliveries.isEmpty)
              const _Message(
                icon: Icons.inventory_2_outlined,
                title: 'No deliveries assigned',
                text: 'New deliveries appear here. Pull down to refresh.',
              )
            else
              for (final delivery in _deliveries) ...[
                _DeliveryTile(delivery: delivery, onTap: () => _openDelivery(delivery)),
                const SizedBox(height: 12),
              ],
          ],
        ),
      ),
    );
  }
}

class _DeliveryTile extends StatelessWidget {
  const _DeliveryTile({required this.delivery, required this.onTap});

  final Delivery delivery;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(delivery.id,
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text(delivery.customerName),
                      const SizedBox(height: 2),
                      Text(delivery.address, style: const TextStyle(color: AppColors.textMuted)),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: AppColors.text),
              ],
            ),
          ),
        ),
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.title, required this.text, this.action});

  final IconData icon;
  final String title;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Panel(
        child: Column(
          children: [
            Icon(icon, size: 40, color: AppColors.text),
            const SizedBox(height: 12),
            Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      );
}
