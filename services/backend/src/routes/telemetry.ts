import { Router, Request, Response } from 'express';
import { db, rtdb } from '../config/firebase';
import { verifyDeviceToken } from '../middleware/auth';
import { telemetryLimiter } from '../middleware/rateLimiter';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { telemetryPayloadSchema } from '../validation/telemetrySchemas';
import {
  COLLECTIONS,
  RTDB_PATHS,
  LiveLocation,
} from '@captain-campus/shared_types';

const router = Router();

/**
 * POST /api/v1/telemetry/location
 * Ingest real-time GPS coordinates from tracking device or driver mobile app.
 * Requires device token authorization and rate limiting.
 * Writes to Firebase RTDB at liveLocations/{busId}.
 */
router.post(
  '/location',
  telemetryLimiter,
  verifyDeviceToken,
  asyncHandler(async (req: Request, res: Response) => {
    // 1. Validate payload schema with Zod
    const validatedData = telemetryPayloadSchema.parse(req.body);

    const busId = validatedData.busId;
    const deviceId = req.deviceId || validatedData.deviceId;

    // 2. Verify bus exists in Firestore
    const busDoc = await db.collection(COLLECTIONS.BUSES).doc(busId).get();
    if (!busDoc.exists) {
      throw new AppError(`Bus with ID '${busId}' not found`, 404, 'BUS_NOT_FOUND');
    }

    const busData = busDoc.data();

    // 3. Verify device assignment if gpsDeviceId is set on the bus and deviceId is provided
    if (
      deviceId &&
      deviceId !== 'device_secret_auth' &&
      busData?.gpsDeviceId &&
      busData.gpsDeviceId !== deviceId
    ) {
      throw new AppError(
        `Device '${deviceId}' is not assigned to bus '${busId}'`,
        403,
        'DEVICE_BUS_MISMATCH'
      );
    }

    // 4. Construct LiveLocation record
    const serverTimestamp = Date.now();
    const liveLocationRecord: LiveLocation = {
      busId,
      tripId: validatedData.tripId || busData?.currentTripId,
      latitude: validatedData.latitude,
      longitude: validatedData.longitude,
      speed: validatedData.speed,
      heading: validatedData.heading,
      accuracy: validatedData.accuracy,
      altitude: validatedData.altitude,
      source: validatedData.source,
      deviceId,
      timestamp: validatedData.timestamp,
      serverTimestamp,
    };

    // 5. Write to Firebase RTDB at liveLocations/{busId}
    await rtdb.ref(RTDB_PATHS.BUS_LOCATION(busId)).set(liveLocationRecord);

    // 6. Update device lastSeenAt in Firestore if deviceId is known
    if (deviceId && deviceId !== 'device_secret_auth') {
      db.collection(COLLECTIONS.GPS_DEVICES)
        .doc(deviceId)
        .set(
          {
            lastSeenAt: serverTimestamp,
            assignedBusId: busId,
            status: 'active',
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        )
        .catch((err) => console.warn('Failed to update GPS device lastSeenAt:', err));
    }

    res.json(successResponse({ recorded: true, busId, serverTimestamp }, 'Location telemetry received'));
  })
);

export default router;
