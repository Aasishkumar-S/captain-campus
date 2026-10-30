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
  Route,
  Trip,
  Bus,
  Stop,
  LiveLocation,
  ETAResult,
} from '@captain-campus/shared_types';

const router = Router();

/**
 * GET /api/v1/eta?stopId=&routeId=
 * Calculates real-time arrival estimates (ETA) for buses servicing the specified stop on a route.
 */
router.get(
  '/',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { stopId, routeId } = req.query;

    if (!stopId || typeof stopId !== 'string') {
      throw new AppError('Query parameter "stopId" is required', 400, 'MISSING_PARAM_STOP_ID');
    }

    if (!routeId || typeof routeId !== 'string') {
      throw new AppError('Query parameter "routeId" is required', 400, 'MISSING_PARAM_ROUTE_ID');
    }

    // 2. Fetch route doc from Firestore
    const routeRef = db.collection(COLLECTIONS.ROUTES).doc(routeId);
    const routeSnap = await routeRef.get();

    if (!routeSnap.exists) {
      throw new AppError(`Route with ID '${routeId}' not found`, 404, 'ROUTE_NOT_FOUND');
    }

    const route = routeSnap.data() as Route;
    const stopSequence = route.stopSequence || [];

    if (stopSequence.length === 0) {
      return res.json(successResponse([], 'Route has no stop sequence defined'));
    }

    // 3. Find stopId in route.stopSequence, get its sequence number
    const targetStopEntry = stopSequence.find((entry) => entry.stopId === stopId);
    if (!targetStopEntry) {
      throw new AppError(
        `Stop '${stopId}' is not part of route '${routeId}'`,
        400,
        'STOP_NOT_ON_ROUTE'
      );
    }
    const targetSeq = targetStopEntry.sequence;

    // Fetch stop coordinates for all stops in the sequence for accurate segment mapping
    const stopDocs = await Promise.all(
      stopSequence.map((entry) => db.collection(COLLECTIONS.STOPS).doc(entry.stopId).get())
    );
    const stopsMap: Record<string, Stop> = {};
    stopDocs.forEach((s) => {
      if (s.exists) {
        stopsMap[s.id] = s.data() as Stop;
      }
    });

    // 4. Query Firestore for in_progress trips for this routeId
    const activeTripsSnap = await db
      .collection(COLLECTIONS.TRIPS)
      .where('routeId', '==', routeId)
      .where('status', '==', 'in_progress')
      .get();

    if (activeTripsSnap.empty) {
      return res.json(successResponse([], 'No active trips currently running on this route'));
    }

    const activeTrips: Trip[] = [];
    activeTripsSnap.forEach((doc) => {
      activeTrips.push(doc.data() as Trip);
    });

    const now = Date.now();
    const etaResults: ETAResult[] = [];

    // 5. For each active trip
    for (const trip of activeTrips) {
      // 5a. Get bus from Firestore
      const busSnap = await db.collection(COLLECTIONS.BUSES).doc(trip.busId).get();
      const busData = busSnap.exists ? (busSnap.data() as Bus) : undefined;
      const busNumber = busData?.busNumber || 'Unknown';

      // 5b. Get live location from RTDB
      let liveLoc: LiveLocation | null = null;
      try {
        const rtdbSnap = await rtdb.ref(RTDB_PATHS.BUS_LOCATION(trip.busId)).once('value');
        if (rtdbSnap.exists()) {
          liveLoc = rtdbSnap.val() as LiveLocation;
        }
      } catch (err) {
        console.warn(`[ETA] Failed to fetch RTDB location for bus ${trip.busId}:`, err);
      }

      // 5c. If no live location
      if (!liveLoc || !liveLoc.latitude || !liveLoc.longitude) {
        etaResults.push({
          stopId,
          busId: trip.busId,
          tripId: trip.tripId,
          busNumber,
          routeCode: route.routeCode,
          etaMinutes: null,
          estimatedArrivalTime: null,
          isLiveEstimate: false,
          lastLocationUpdate: liveLoc?.timestamp || 0,
          isStale: true,
          confidence: 'unavailable',
          source: 'timetable',
        });
        continue;
      }

      // 5d. Check staleness vs GPS_STALE_THRESHOLD_MS
      const isStale = now - (liveLoc.timestamp || 0) > GPS_STALE_THRESHOLD_MS;

      // 5e. Find which route segment the bus is on: compare bus lat/lng to each stop
      // Sort sequence ascending by sequence
      const sortedSequence = [...stopSequence].sort((a, b) => a.sequence - b.sequence);

      let closestStopIndex = 0;
      let minDistance = Infinity;

      for (let i = 0; i < sortedSequence.length; i++) {
        const stopObj = stopsMap[sortedSequence[i].stopId];
        if (stopObj) {
          const dist = haversineDistanceM(
            liveLoc.latitude,
            liveLoc.longitude,
            stopObj.latitude,
            stopObj.longitude
          );
          if (dist < minDistance) {
            minDistance = dist;
            closestStopIndex = i;
          }
        }
      }

      // Estimate current segment (progress between closest stop and next stop)
      let estimatedCurrentSegment = sortedSequence[closestStopIndex].sequence;

      if (closestStopIndex < sortedSequence.length - 1) {
        const currentStop = stopsMap[sortedSequence[closestStopIndex].stopId];
        const nextStop = stopsMap[sortedSequence[closestStopIndex + 1].stopId];

        if (currentStop && nextStop) {
          const totalSegmentDist = haversineDistanceM(
            currentStop.latitude,
            currentStop.longitude,
            nextStop.latitude,
            nextStop.longitude
          );

          const distToNext = haversineDistanceM(
            liveLoc.latitude,
            liveLoc.longitude,
            nextStop.latitude,
            nextStop.longitude
          );

          if (totalSegmentDist > 0) {
            // Fraction traversed towards next stop
            const fraction = Math.max(0, Math.min(0.99, (totalSegmentDist - distToNext) / totalSegmentDist));
            estimatedCurrentSegment = sortedSequence[closestStopIndex].sequence + fraction;
          }
        }
      }

      // 5i. If bus has already passed the target stop: this bus doesn't serve the stop anymore
      if (estimatedCurrentSegment > targetSeq) {
        continue;
      }

      // 5g & 5h. Calculate etaMinutes
      const totalSegments = Math.max(1, sortedSequence.length - 1);
      const estimatedTotalDuration = route.estimatedDuration || 30; // Default to 30 mins if not set
      const avgTimePerSegment = estimatedTotalDuration / totalSegments;

      const remainingSegments = targetSeq - estimatedCurrentSegment;
      let etaMinutes = Math.ceil(remainingSegments * avgTimePerSegment);

      // Minimum 1 minute if ahead of target stop and distance > 50m
      if (etaMinutes <= 0 && minDistance > 50) {
        etaMinutes = 1;
      }

      const arrivalTimeMs = now + etaMinutes * 60 * 1000;
      const estimatedArrivalTime = new Date(arrivalTimeMs).toISOString();

      let confidence: 'high' | 'medium' | 'low' | 'unavailable' = 'high';
      if (isStale) {
        confidence = 'low';
      } else if (liveLoc.accuracy && liveLoc.accuracy > 50) {
        confidence = 'medium';
      }

      etaResults.push({
        stopId,
        busId: trip.busId,
        tripId: trip.tripId,
        busNumber,
        routeCode: route.routeCode,
        etaMinutes,
        estimatedArrivalTime,
        isLiveEstimate: true,
        lastLocationUpdate: liveLoc.timestamp,
        isStale,
        confidence,
        source: 'calculated',
      });
    }

    // 6. Return array of ETAResult sorted by etaMinutes ascending (null values at the end)
    etaResults.sort((a, b) => {
      if (a.etaMinutes === null) return 1;
      if (b.etaMinutes === null) return -1;
      return a.etaMinutes - b.etaMinutes;
    });

    res.json(successResponse(etaResults));
  })
);

export default router;
