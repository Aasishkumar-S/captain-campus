import { Router, Request, Response } from 'express';
import { db, rtdb } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import { createBusSchema, updateBusSchema } from '../validation/busSchemas';
import {
  COLLECTIONS,
  RTDB_PATHS,
  GPS_STALE_THRESHOLD_MS,
  Bus,
  LiveLocation,
  LiveLocationWithStatus,
} from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /api/v1/buses
 * List all active buses (students/authenticated users can access).
 * Augments bus data with live locations if available from RTDB.
 */
router.get(
  '/',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const busesSnap = await db
      .collection(COLLECTIONS.BUSES)
      .where('status', 'in', ['active', 'maintenance'])
      .get();

    const buses: Bus[] = [];
    busesSnap.forEach((doc) => {
      buses.push(doc.data() as Bus);
    });

    // Optionally fetch live locations snapshot from RTDB
    let liveLocationsMap: Record<string, LiveLocation> = {};
    try {
      const rtdbSnap = await rtdb.ref(RTDB_PATHS.LIVE_LOCATIONS).once('value');
      if (rtdbSnap.exists()) {
        liveLocationsMap = rtdbSnap.val() || {};
      }
    } catch (err) {
      console.warn('Failed to fetch RTDB live locations snapshot:', err);
    }

    const now = Date.now();
    const result: (Bus & { liveLocation?: LiveLocationWithStatus })[] = buses.map((bus) => {
      const loc = liveLocationsMap[bus.busId];
      let liveLocation: LiveLocationWithStatus | undefined = undefined;

      if (loc) {
        const isStale = now - (loc.timestamp || 0) > GPS_STALE_THRESHOLD_MS;
        liveLocation = {
          ...loc,
          isStale,
          staleSinceMs: isStale ? now - (loc.timestamp || 0) : undefined,
          busNumber: bus.busNumber,
          routeId: bus.currentRouteId,
        };
      }

      return {
        ...bus,
        liveLocation,
      } as Bus & { liveLocation?: LiveLocationWithStatus };
    });

    res.json(successResponse(result));
  })
);

/**
 * GET /api/v1/buses/:busId
 * Get single bus details.
 */
router.get(
  '/:busId',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { busId } = req.params;
    const busSnap = await db.collection(COLLECTIONS.BUSES).doc(busId).get();

    if (!busSnap.exists) {
      throw new AppError(`Bus with ID '${busId}' not found`, 404, 'BUS_NOT_FOUND');
    }

    const bus = busSnap.data() as Bus;
    res.json(successResponse(bus));
  })
);

/**
 * GET /api/v1/buses/:busId/location
 * Get live location from RTDB for a single bus.
 */
router.get(
  '/:busId/location',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { busId } = req.params;

    const locSnap = await rtdb.ref(RTDB_PATHS.BUS_LOCATION(busId)).once('value');
    if (!locSnap.exists()) {
      return res.json(
        successResponse(null, `No live location telemetry currently available for bus ${busId}`)
      );
    }

    const rawLoc = locSnap.val() as LiveLocation;
    const now = Date.now();
    const isStale = now - (rawLoc.timestamp || 0) > GPS_STALE_THRESHOLD_MS;

    const liveLocation: LiveLocationWithStatus = {
      ...rawLoc,
      isStale,
      staleSinceMs: isStale ? now - (rawLoc.timestamp || 0) : undefined,
    };

    res.json(successResponse(liveLocation));
  })
);

/**
 * POST /api/v1/buses (or admin alias)
 * Create bus (admin only), validate with Zod, check duplicate registrationNumber.
 */
router.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createBusSchema.parse(req.body);

    // Check for duplicate registrationNumber
    const existingReg = await db
      .collection(COLLECTIONS.BUSES)
      .where('registrationNumber', '==', validatedData.registrationNumber.toUpperCase())
      .limit(1)
      .get();

    if (!existingReg.empty) {
      throw new AppError(
        `Bus with registration number '${validatedData.registrationNumber}' already exists`,
        409,
        'DUPLICATE_REGISTRATION'
      );
    }

    const busId = uuidv4();
    const now = new Date().toISOString();

    const newBus: Bus = {
      busId,
      busNumber: validatedData.busNumber,
      registrationNumber: validatedData.registrationNumber.toUpperCase(),
      capacity: validatedData.capacity,
      driverId: validatedData.driverId,
      gpsDeviceId: validatedData.gpsDeviceId,
      currentRouteId: validatedData.currentRouteId,
      status: validatedData.status,
      make: validatedData.make,
      model: validatedData.model,
      year: validatedData.year,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(COLLECTIONS.BUSES).doc(busId).set(newBus);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'bus.created',
      affectedCollection: COLLECTIONS.BUSES,
      affectedDocId: busId,
      after: newBus as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.status(201).json(successResponse(newBus, 'Bus created successfully'));
  })
);

/**
 * PATCH /api/v1/buses/:busId
 * Update bus (admin only), validate with Zod.
 */
router.patch(
  '/:busId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { busId } = req.params;
    const validatedData = updateBusSchema.parse(req.body);

    const busRef = db.collection(COLLECTIONS.BUSES).doc(busId);
    const busSnap = await busRef.get();

    if (!busSnap.exists) {
      throw new AppError(`Bus with ID '${busId}' not found`, 404, 'BUS_NOT_FOUND');
    }

    const beforeData = busSnap.data() as Bus;

    // Check duplicate registrationNumber if changed
    if (
      validatedData.registrationNumber &&
      validatedData.registrationNumber.toUpperCase() !== beforeData.registrationNumber
    ) {
      const existingReg = await db
        .collection(COLLECTIONS.BUSES)
        .where('registrationNumber', '==', validatedData.registrationNumber.toUpperCase())
        .limit(1)
        .get();

      if (!existingReg.empty && existingReg.docs[0].id !== busId) {
        throw new AppError(
          `Bus with registration number '${validatedData.registrationNumber}' already exists`,
          409,
          'DUPLICATE_REGISTRATION'
        );
      }
    }

    const updates: Partial<Bus> = {
      ...validatedData,
      // Convert any null values to undefined to satisfy Bus type
      driverId: validatedData.driverId ?? undefined,
      gpsDeviceId: validatedData.gpsDeviceId ?? undefined,
      currentRouteId: validatedData.currentRouteId ?? undefined,
      currentTripId: validatedData.currentTripId ?? undefined,
      ...(validatedData.registrationNumber
        ? { registrationNumber: validatedData.registrationNumber.toUpperCase() }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    await busRef.update(updates);

    const updatedDoc = (await busRef.get()).data() as Bus;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'bus.updated',
      affectedCollection: COLLECTIONS.BUSES,
      affectedDocId: busId,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.json(successResponse(updatedDoc, 'Bus updated successfully'));
  })
);

/**
 * DELETE /api/v1/buses/:busId
 * Deactivate bus (admin only, soft delete setting status to 'decommissioned').
 */
router.delete(
  '/:busId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { busId } = req.params;
    const busRef = db.collection(COLLECTIONS.BUSES).doc(busId);
    const busSnap = await busRef.get();

    if (!busSnap.exists) {
      throw new AppError(`Bus with ID '${busId}' not found`, 404, 'BUS_NOT_FOUND');
    }

    const beforeData = busSnap.data() as Bus;
    const updates = {
      status: 'decommissioned' as const,
      updatedAt: new Date().toISOString(),
    };

    await busRef.update(updates);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'bus.deleted',
      affectedCollection: COLLECTIONS.BUSES,
      affectedDocId: busId,
      before: beforeData as unknown as Record<string, unknown>,
      after: { ...beforeData, ...updates },
      ipAddress: req.ip,
    });

    res.json(successResponse({ busId, status: 'decommissioned' }, 'Bus deactivated successfully'));
  })
);

export default router;
