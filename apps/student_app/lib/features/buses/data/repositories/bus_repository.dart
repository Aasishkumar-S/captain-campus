import 'dart:async';
import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/network/api_client.dart';
import '../models/bus_model.dart';
import '../models/live_location_model.dart';

final busRepositoryProvider = Provider<BusRepository>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return BusRepository(apiClient: apiClient);
});

class BusRepository {
  final ApiClient _apiClient;
  final FirebaseDatabase? _firebaseDatabase;

  BusRepository({
    required ApiClient apiClient,
    FirebaseDatabase? firebaseDatabase,
  })  : _apiClient = apiClient,
        _firebaseDatabase = firebaseDatabase;

  static const List<BusModel> mockBuses = [
    BusModel(
      busId: 'bus-cc-01',
      busNumber: 'CC-01',
      registrationNumber: 'KA01AA0001',
      capacity: 45,
      currentRouteId: 'route-r1',
      driverId: 'driver-001',
      status: 'active',
    ),
    BusModel(
      busId: 'bus-cc-02',
      busNumber: 'CC-02',
      registrationNumber: 'KA01AA0002',
      capacity: 45,
      currentRouteId: 'route-r1',
      driverId: 'driver-002',
      status: 'active',
    ),
    BusModel(
      busId: 'bus-cc-03',
      busNumber: 'CC-03',
      registrationNumber: 'KA01AA0003',
      capacity: 40,
      currentRouteId: 'route-r2',
      driverId: 'driver-003',
      status: 'active',
    ),
    BusModel(
      busId: 'bus-cc-04',
      busNumber: 'CC-04',
      registrationNumber: 'KA01AA0004',
      capacity: 35,
      currentRouteId: 'route-r3',
      status: 'delayed',
    ),
  ];

  Future<List<BusModel>> getBuses() async {
    try {
      final response = await _apiClient.get('/buses');
      final dynamic rawData = (response is Map<String, dynamic> && response.containsKey('data'))
          ? response['data']
          : response;

      if (rawData is List) {
        final list = rawData
            .map((item) => BusModel.fromJson(item as Map<String, dynamic>))
            .toList();
        if (list.isNotEmpty) return list;
      }
    } catch (_) {
      // Fallback
    }
    return mockBuses;
  }

  Future<BusModel?> getBusById(String busId) async {
    try {
      final response = await _apiClient.get('/buses/$busId');
      final dynamic rawData = (response is Map<String, dynamic> && response.containsKey('data'))
          ? response['data']
          : response;

      if (rawData is Map<String, dynamic>) {
        return BusModel.fromJson(rawData);
      }
    } catch (_) {
      // Fallback
    }

    try {
      return mockBuses.firstWhere(
        (b) => b.busId == busId || b.busNumber.toLowerCase() == busId.toLowerCase(),
      );
    } catch (_) {
      return null;
    }
  }

  Stream<Map<String, LiveLocationModel>> getLiveLocationsStream() {
    late StreamController<Map<String, LiveLocationModel>> controller;
    StreamSubscription? rtdbSub;
    Timer? fallbackSimTimer;
    bool receivedRtdbData = false;

    // Waypoints for campus routes matching seed data
    final r1Points = [
      [12.9716, 77.5946], // Main Gate
      [12.9722, 77.5952], // Admin Block
      [12.9728, 77.5960], // Library
      [12.9735, 77.5968], // Science Block
      [12.9742, 77.5975], // Sports Ground
      [12.9748, 77.5980], // Cafeteria
      [12.9755, 77.5988], // Boys Hostel A
      [12.9762, 77.5995], // Boys Hostel B
    ];

    final r2Points = [
      [12.9716, 77.5946], // Main Gate
      [12.9710, 77.5955], // Medical Centre
      [12.9705, 77.5965], // Engineering Block
      [12.9700, 77.5975], // Computer Lab
      [12.9695, 77.5985], // Girls Hostel
      [12.9700, 77.5995], // Staff Quarters
      [12.9710, 77.6000], // Workshop
      [12.9720, 77.5995], // Auditorium
      [12.9725, 77.5975], // Guest House
      [12.9716, 77.5946], // Main Gate
    ];

    final r3Points = [
      [12.9716, 77.5946], // Main Gate
      [12.9712, 77.5938], // Security Office
      [12.9708, 77.5930], // Parking Lot
      [12.9722, 77.5952], // Admin Block
      [12.9730, 77.5940], // Academic Block A
      [12.9738, 77.5932], // Academic Block B
    ];

    double progress1 = 0.08;
    double progress2 = 0.55;
    double progress3 = 0.25;
    double progress4 = 0.40;

    LiveLocationModel computePoint({
      required String busId,
      required List<List<double>> route,
      required double progress,
      required double speed,
    }) {
      final totalSegs = route.length - 1;
      final totalDist = progress * totalSegs;
      final segIdx = totalDist.floor().clamp(0, totalSegs - 1);
      final segFraction = totalDist - segIdx;

      final p1 = route[segIdx];
      final p2 = route[segIdx + 1];

      final lat = p1[0] + (p2[0] - p1[0]) * segFraction;
      final lng = p1[1] + (p2[1] - p1[1]) * segFraction;

      final dLat = (p2[0] - p1[0]);
      final dLng = (p2[1] - p1[1]);
      final heading = ((math.atan2(dLng, dLat) * 180 / math.pi) + 360) % 360;

      return LiveLocationModel(
        busId: busId,
        latitude: lat,
        longitude: lng,
        speed: speed,
        heading: heading,
        accuracy: 4.5,
        source: 'simulator',
        timestamp: DateTime.now(),
        isStale: false,
      );
    }

    void emitFallbackSimulation() {
      progress1 = (progress1 + 0.025) % 1.0;
      progress2 = (progress2 + 0.025) % 1.0;
      progress3 = (progress3 + 0.020) % 1.0;
      progress4 = (progress4 + 0.012) % 1.0; // Delayed bus moves slower

      final Map<String, LiveLocationModel> simulated = {
        'bus-cc-01': computePoint(
          busId: 'bus-cc-01',
          route: r1Points,
          progress: progress1,
          speed: 34.0,
        ),
        'bus-cc-02': computePoint(
          busId: 'bus-cc-02',
          route: r1Points,
          progress: progress2,
          speed: 32.5,
        ),
        'bus-cc-03': computePoint(
          busId: 'bus-cc-03',
          route: r2Points,
          progress: progress3,
          speed: 30.0,
        ),
        'bus-cc-04': computePoint(
          busId: 'bus-cc-04',
          route: r3Points,
          progress: progress4,
          speed: 14.0, // Delayed
        ),
      };

      if (!controller.isClosed) {
        controller.add(simulated);
      }
    }

    controller = StreamController<Map<String, LiveLocationModel>>(
      onListen: () {
        // Emit initial simulated state immediately so UI has live data without waiting
        emitFallbackSimulation();

        // Attempt Firebase RTDB connection
        try {
          if (Firebase.apps.isNotEmpty) {
            final db = _firebaseDatabase ?? FirebaseDatabase.instance;
            final ref = db.ref('liveLocations');
            rtdbSub = ref.onValue.listen(
              (event) {
                final snapshotValue = event.snapshot.value;
                if (snapshotValue is Map) {
                  final result = <String, LiveLocationModel>{};
                  snapshotValue.forEach((key, val) {
                    if (val is Map) {
                      result[key.toString()] = LiveLocationModel.fromJson(
                        val,
                        defaultBusId: key.toString(),
                      );
                    }
                  });

                  if (result.isNotEmpty) {
                    receivedRtdbData = true;
                    // Cancel fallback timer if RTDB is active
                    fallbackSimTimer?.cancel();
                    fallbackSimTimer = null;
                    if (!controller.isClosed) {
                      controller.add(result);
                    }
                  }
                }
              },
              onError: (err) {
                // If RTDB errors, fallback simulation continues
              },
            );
          }
        } catch (_) {
          // Firebase not initialized; fallback mode active
        }

        // Start fallback timer if RTDB is not receiving live events
        fallbackSimTimer = Timer.periodic(const Duration(seconds: 4), (_) {
          if (!receivedRtdbData) {
            emitFallbackSimulation();
          }
        });
      },
      onCancel: () {
        rtdbSub?.cancel();
        fallbackSimTimer?.cancel();
      },
    );

    return controller.stream;
  }
}
