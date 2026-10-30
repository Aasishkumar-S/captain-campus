import { Router, Request, Response } from 'express';
import { db, rtdb } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { haversineDistanceM } from '../utils/haversine';
import {
  COLLECTIONS,
  RTDB_PATHS,
  GPS_STALE_THRESHOLD_MS,
  MISSED_BUS_WAIT_WINDOW_MINUTES,
  MAX_WALKING_DISTANCE_METERS,
  Route,
  Stop,
  Bus,
  LiveLocation,
  MissedBusRequest,
  MissedBusRecommendation,
  MissedBusResponseData,
  StopWithDistance,
} from '@captain-campus/shared_types';

const router = Router();

/**
 * POST /api/v1/missed-bus
 * Intelligent Alternative Bus Recommendation Engine
 *
 * Implements the 12-step algorithmic workflow:
 * 1. Validates selected stop, intended route/destination, and student's current position.
 * 2. Fetches active & upcoming buses using recent GPS telemetry from RTDB.
 * 3. Filters out stale telemetry, inactive trips, and reverse-direction buses.
 * 4. Checks if a suitable next bus reaches the SAME stop within MISSED_BUS_WAIT_WINDOW_MINUTES (15m).
 *    If found -> Recommends staying at the same stop.
 * 5. If no same-stop bus within window -> identifies candidate alternative stops within walking radius (max 800m).
 * 6. Checks which upcoming buses serve those alternative stops heading toward student's destination.
 * 7. Computes walking time (average walking speed 1.3 m/s or ~4.7 km/h) & bus arrival times at each candidate stop.
 * 8. Ranks alternatives by totalJourneyTime = walkingTime + waitingTime + downstreamJourneyTime.
 * 9. Returns ranked recommendations with clear guidance and reason.
 */
router.post(
  '/',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body as MissedBusRequest;
    const {
      preferredStopId,
      preferredRouteId,
      destinationStopId,
      studentLatitude,
      studentLongitude,
    } = payload;

    if (!preferredStopId) {
      throw new AppError('Field "preferredStopId" is required', 400, 'MISSING_PREFERRED_STOP');
    }

    const maxWalkingMeters = payload.maxWalkingDistanceMeters || MAX_WALKING_DISTANCE_METERS; // 800m default

    // Step 1: Retrieve stops catalog
    const stopsSnap = await db.collection(COLLECTIONS.STOPS).get();
    const stopsMap = new Map<string, Stop>();
    stopsSnap.forEach((doc) => {
      const data = doc.data() as Stop;
      stopsMap.set(data.stopId, data);
    });

    const originalStop = stopsMap.get(preferredStopId);
    if (!originalStop) {
      throw new AppError(`Preferred stop "${preferredStopId}" not found`, 404, 'STOP_NOT_FOUND');
    }

    // Determine student origin point (use GPS coordinates if provided; otherwise fallback to preferred stop)
    const originLat = (studentLatitude != null && studentLongitude != null)
      ? studentLatitude
      : originalStop.latitude;
    const originLng = (studentLatitude != null && studentLongitude != null)
      ? studentLongitude
      : originalStop.longitude;

    // Step 2: Retrieve all routes
    const routesSnap = await db.collection(COLLECTIONS.ROUTES).where('status', '==', 'active').get();
    const routesMap = new Map<string, Route>();
    routesSnap.forEach((doc) => {
      const data = doc.data() as Route;
      routesMap.set(data.routeId, data);
    });

    // Step 3: Fetch active buses & RTDB liveLocations
    const busesSnap = await db.collection(COLLECTIONS.BUSES).where('status', 'in', ['active', 'delayed']).get();
    const busesList: Bus[] = [];
    busesSnap.forEach((doc) => {
      busesList.push(doc.data() as Bus);
    });

    let liveLocationsMap: Record<string, LiveLocation> = {};
    try {
      const rtdbSnap = await rtdb.ref(RTDB_PATHS.LIVE_LOCATIONS).once('value');
      if (rtdbSnap.exists()) {
        liveLocationsMap = rtdbSnap.val() || {};
      }
    } catch (err) {
      console.warn('MissedBus: RTDB liveLocations fetch error:', err);
    }

    const now = Date.now();
    const recommendations: MissedBusRecommendation[] = [];

    // Helper: Compute average walking duration in minutes (walking speed ~ 1.3 m/s)
    const getWalkingMinutes = (distM: number) => Math.ceil(distM / (1.3 * 60));

    // Helper: Estimate bus travel time between two stops on a route
    const estimateTravelMinutes = (route: Route, fromSeq: number, toSeq: number) => {
      let totalM = 0;
      const sortedStops = [...(route.stopSequence || [])].sort((a, b) => a.sequence - b.sequence);
      for (let i = fromSeq; i < toSeq; i++) {
        const s1 = stopsMap.get(sortedStops[i - 1]?.stopId);
        const s2 = stopsMap.get(sortedStops[i]?.stopId);
        if (s1 && s2) {
          totalM += haversineDistanceM(s1.latitude, s1.longitude, s2.latitude, s2.longitude);
        } else {
          totalM += 500; // default segment fallback
        }
      }
      // Average campus shuttle speed ~ 25 km/h (416 m/min)
      return Math.max(1, Math.round(totalM / 416));
    };

    // Helper: Calculate ETA in minutes for a bus reaching a given stop on a route
    const calculateBusEtaToStop = (
      bus: Bus,
      route: Route,
      targetStopId: string
    ): { etaMinutes: number; valid: boolean; stopSeq: number } => {
      const stopSeqList = route.stopSequence || [];
      const targetEntry = stopSeqList.find((s) => s.stopId === targetStopId);
      if (!targetEntry) return { etaMinutes: -1, valid: false, stopSeq: -1 };

      const loc = liveLocationsMap[bus.busId];
      if (!loc) {
        // Fallback: estimate from start offset
        const offset = targetEntry.scheduledOffset ?? (targetEntry.sequence * 3);
        return { etaMinutes: offset, valid: true, stopSeq: targetEntry.sequence };
      }

      // Check GPS staleness
      if (now - (loc.timestamp || 0) > GPS_STALE_THRESHOLD_MS) {
        return { etaMinutes: -1, valid: false, stopSeq: targetEntry.sequence };
      }

      // Find closest stop sequence bus has reached or passed
      let closestSeq = 1;
      let minDistance = Infinity;

      for (const entry of stopSeqList) {
        const s = stopsMap.get(entry.stopId);
        if (s) {
          const d = haversineDistanceM(loc.latitude, loc.longitude, s.latitude, s.longitude);
          if (d < minDistance) {
            minDistance = d;
            closestSeq = entry.sequence;
          }
        }
      }

      // If the bus has already passed the stop in this trip direction, it cannot serve it
      if (closestSeq > targetEntry.sequence) {
        return { etaMinutes: -1, valid: false, stopSeq: targetEntry.sequence };
      }

      // Remaining distance
      let remainingDistanceM = haversineDistanceM(
        loc.latitude,
        loc.longitude,
        stopsMap.get(targetStopId)?.latitude || loc.latitude,
        stopsMap.get(targetStopId)?.longitude || loc.longitude
      );

      // Add intermediate stops travel
      const intermediateMins = estimateTravelMinutes(route, closestSeq, targetEntry.sequence);
      const currentSpeedMPerMin = loc.speed && loc.speed > 5 ? (loc.speed * 1000) / 60 : 400;
      const etaMinutes = Math.max(1, Math.round(remainingDistanceM / currentSpeedMPerMin) + (intermediateMins > 2 ? intermediateMins : 0));

      return { etaMinutes, valid: true, stopSeq: targetEntry.sequence };
    };

    // Step 4: Check if ANY bus reaches the SAME original stop within waiting window (15 mins)
    for (const bus of busesList) {
      if (!bus.currentRouteId) continue;
      const route = routesMap.get(bus.currentRouteId);
      if (!route) continue;

      // Filter by preferredRouteId if specified
      if (preferredRouteId && route.routeId !== preferredRouteId) continue;

      const { etaMinutes, valid } = calculateBusEtaToStop(bus, route, preferredStopId);

      if (valid && etaMinutes >= 0 && etaMinutes <= MISSED_BUS_WAIT_WINDOW_MINUTES) {
        const depTime = new Date(now + etaMinutes * 60000).toISOString();
        recommendations.push({
          type: 'next_bus_same_stop',
          busId: bus.busId,
          busNumber: bus.busNumber,
          routeId: route.routeId,
          routeCode: route.routeCode,
          routeName: route.routeName,
          departureStopId: originalStop.stopId,
          departureStopName: originalStop.name,
          etaMinutes,
          estimatedDepartureTime: depTime,
          walkingDistanceMeters: 0,
          walkingMinutes: 0,
          advice: `Stay at ${originalStop.name}. Next shuttle ${bus.busNumber} (${route.routeCode}) will arrive in ${etaMinutes} mins.`,
        });
      }
    }

    // Step 5: Search for alternative reachable stops within walking distance
    const nearbyStopsWithDistance: StopWithDistance[] = [];

    for (const [sId, stop] of stopsMap.entries()) {
      if (sId === preferredStopId) continue;

      const distM = Math.round(haversineDistanceM(originLat, originLng, stop.latitude, stop.longitude));
      if (distM <= maxWalkingMeters) {
        const walkMin = getWalkingMinutes(distM);
        nearbyStopsWithDistance.push({
          ...stop,
          distanceMeters: distM,
          walkingMinutes: walkMin,
        });
      }
    }

    // Sort nearby stops by walking distance
    nearbyStopsWithDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);

    // Step 6: For each nearby alternative stop, check candidate upcoming buses
    for (const altStop of nearbyStopsWithDistance) {
      const walkTime = altStop.walkingMinutes || getWalkingMinutes(altStop.distanceMeters);

      for (const bus of busesList) {
        if (!bus.currentRouteId) continue;
        const route = routesMap.get(bus.currentRouteId);
        if (!route) continue;

        const { etaMinutes, valid, stopSeq } = calculateBusEtaToStop(bus, route, altStop.stopId);

        // A bus is feasible at the alternative stop if:
        // 1. Bus is valid and active
        // 2. Bus arrival at alternative stop is >= student's walkTime (student can catch it)
        // 3. Student wait time (etaMinutes - walkTime) <= 15 minutes
        if (valid && etaMinutes >= walkTime && (etaMinutes - walkTime) <= MISSED_BUS_WAIT_WINDOW_MINUTES) {
          // If destinationStopId specified, ensure alternative stop sequence is before destination
          if (destinationStopId) {
            const destEntry = route.stopSequence?.find((s) => s.stopId === destinationStopId);
            if (!destEntry || destEntry.sequence <= stopSeq) {
              continue; // Incompatible direction or doesn't reach destination
            }
          }

          const depTime = new Date(now + etaMinutes * 60000).toISOString();
          const waitTime = etaMinutes - walkTime;
          const isSameRoute = preferredRouteId && route.routeId === preferredRouteId;

          recommendations.push({
            type: isSameRoute ? 'alternative_stop_same_route' : 'alternative_route',
            busId: bus.busId,
            busNumber: bus.busNumber,
            routeId: route.routeId,
            routeCode: route.routeCode,
            routeName: route.routeName,
            departureStopId: altStop.stopId,
            departureStopName: altStop.name,
            etaMinutes,
            estimatedDepartureTime: depTime,
            walkingDistanceMeters: altStop.distanceMeters,
            walkingMinutes: walkTime,
            advice: `Walk ${altStop.distanceMeters}m (~${walkTime} min) to ${altStop.name}. Catch Shuttle ${bus.busNumber} (${route.routeCode}) arriving in ${etaMinutes} mins (wait: ~${waitTime} min).`,
          });
        }
      }
    }

    // Step 7: Rank alternatives
    // Sorting priority:
    // 1. 'next_bus_same_stop' preferred when wait is reasonable (< 10 mins)
    // 2. Otherwise lowest total journey time: walkingMinutes + etaMinutes
    recommendations.sort((a, b) => {
      if (a.type === 'next_bus_same_stop' && b.type !== 'next_bus_same_stop' && a.etaMinutes <= 10) {
        return -1;
      }
      if (b.type === 'next_bus_same_stop' && a.type !== 'next_bus_same_stop' && b.etaMinutes <= 10) {
        return 1;
      }
      const scoreA = (a.walkingMinutes || 0) + a.etaMinutes;
      const scoreB = (b.walkingMinutes || 0) + b.etaMinutes;
      return scoreA - scoreB;
    });

    const responseData: MissedBusResponseData = {
      originalStopId: preferredStopId,
      recommendations,
      nearbyStops: nearbyStopsWithDistance.slice(0, 5),
    };

    return res.json(
      successResponse(
        responseData,
        recommendations.length > 0
          ? `Found ${recommendations.length} feasible transit alternative(s)`
          : 'No immediate alternative shuttles found within the walking and waiting window.'
      )
    );
  })
);

export default router;
