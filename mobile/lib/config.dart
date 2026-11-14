import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

/// Bluetooth identifiers. Must match firmware/helmet_cam/config.h.
class BleUuids {
  static final service = Guid('7a1c0001-5b0e-4f6a-9d3c-2e8f4b6a1c00');
  static final command = Guid('7a1c0002-5b0e-4f6a-9d3c-2e8f4b6a1c00');
  static final status = Guid('7a1c0003-5b0e-4f6a-9d3c-2e8f4b6a1c00');
}

/// Recording starts when the driver is this close to the destination.
const double geofenceRadiusMetres = 200;

/// The driver must go this far away before coming back counts as a new attempt.
/// The gap stops GPS jitter at the edge from restarting the recording.
const double geofenceExitMetres = 260;

/// The helmet keeps recording this long after "Delivered" is pressed.
const int stopDelaySeconds = 10;

/// Same palette as the staff dashboard: midnight black, pure white, lime green.
class AppColors {
  static const background = Color(0xFF0B0B0C);
  static const panel = Color(0xFF161618);
  static const text = Color(0xFFFFFFFF);
  static const textMuted = Color(0xA3FFFFFF);

  /// Lime: the main action, and "recording is on".
  static const accent = Color(0xFFC6F432);

  /// White: something the driver must notice, such as a problem.
  static const attention = Color(0xFFFFFFFF);

  /// Text and icons on top of [accent] or [attention].
  static const onAccent = Color(0xFF0B0B0C);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.accent,
    brightness: Brightness.dark,
    primary: AppColors.accent,
    onPrimary: AppColors.onAccent,
    secondary: AppColors.accent,
    onSecondary: AppColors.onAccent,
    surface: AppColors.panel,
    onSurface: AppColors.text,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.background,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.background,
      foregroundColor: AppColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.accent,
        foregroundColor: AppColors.onAccent,
        disabledBackgroundColor: AppColors.panel,
        disabledForegroundColor: AppColors.textMuted,
        minimumSize: const Size.fromHeight(56),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0x14FFFFFF),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
    ),
  );
}
