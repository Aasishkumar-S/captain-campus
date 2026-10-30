import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse, paginatedResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import {
  createTripSchema,
  delayTripSchema,
  cancelTripSchema,
} from '../validation/tripSchemas';
import {
  COLLECTIONS,
  Trip,
  TripStatus,
  Bus,
  Driver,
  Route,
} from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /api/v1/trips or /api/v1/admin/trips
 * List trips with optional filters: ?status=, ?busId=, ?routeId=, ?driverId=, ?date= (ISO date YYYY-MM-DD), ?page=, ?pageSize=
 */
router.get(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { status, busId, routeId, driverId, date } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize as string, 10) || 20));

    let query: FirebaseFirestore.Query = db.collection(COLLECTIONS.TRIPS);

    if (status) {
      query = query.where('status', '==', status);
    }
    if (busId) {
      query = query.where('busId', '==', busId);
    }
    if (routeId) {
      query = query.where('routeId', '==', routeId);
    }
    if (driverId) {
      query = query.where('driverId', '==', driverId);
    }

    const snapshot = await query.get();
    let trips: Trip[] = [];
    snapshot.forEach((doc) => {
      trips.push(doc.data() as Trip);
    });

    // In-memory filter for date if supplied (matches scheduledStart starting with date prefix)
    if (date && typeof date === 'string') {
      const datePrefix = date.split('T')[0];
      trips = trips.filter((t) => (t.scheduledStart || '').startsWith(datePrefix));
    }

    // Sort by scheduledStart desc
    trips.sort((a, b) => (b.scheduledStart || '').localeCompare(a.scheduledStart || ''));

    const total = trips.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedTrips = trips.slice(startIndex, startIndex + pageSize);

    res.json(successResponse(paginatedResponse(paginatedTrips, total, page, pageSize)));
  })
);

/**
 * GET /api/v1/trips/:tripId
 * Get single trip
 */
router.get(
  '/:tripId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { tripId } = req.params;
    const tripSnap = await db.collection(COLLECTIONS.TRIPS).doc(tripId).get();

    if (!tripSnap.exists) {
      throw new AppError(`Trip with ID '${tripId}' not found`, 404, 'TRIP_NOT_FOUND');
    }

    const trip = tripSnap.data() as Trip;
    res.json(successResponse(trip));
  })
);

/**
 * POST /api/v1/trips
 * Create trip:
 * - Validate bus exists, is active, doesn't have an in_progress trip already
 * - Validate driver exists and is active
 * - Validate route exists and is active
 * - Create with status: 'scheduled'
 */
router.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createTripSchema.parse(req.body);

    const busRef = db.collection(COLLECTIONS.BUSES).doc(validatedData.busId);
    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(validatedData.driverId);
    const routeRef = db.collection(COLLECTIONS.ROUTES).doc(validatedData.routeId);

    const [busSnap, driverSnap, routeSnap] = await Promise.all([
      busRef.get(),
      driverRef.get(),
      routeRef.get(),
    ]);

    if (!busSnap.exists) {
      throw new AppError(`Bus with ID '${validatedData.busId}' not found`, 404, 'BUS_NOT_FOUND');
    }
    const busData = busSnap.data() as Bus;
    if (busData.status !== 'active') {
      throw new AppError(`Bus '${busData.busNumber}' is not active`, 400, 'BUS_NOT_ACTIVE');
    }

    // Check if bus already has an in_progress trip
    const activeBusTripSnap = await db
      .collection(COLLECTIONS.TRIPS)
      .where('busId', '==', validatedData.busId)
      .where('status', '==', 'in_progress')
      .limit(1)
      .get();

    if (!activeBusTripSnap.empty) {
      throw new AppError(
        `Bus '${busData.busNumber}' already has a trip in progress`,
        400,
        'BUS_ALREADY_IN_TRIP'
      );
    }

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${validatedData.driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }
    const driverData = driverSnap.data() as Driver;
    if (driverData.status !== 'active') {
      throw new AppError(`Driver '${driverData.name}' is not active`, 400, 'DRIVER_NOT_ACTIVE');
    }

    if (!routeSnap.exists) {
      throw new AppError(`Route with ID '${validatedData.routeId}' not found`, 404, 'ROUTE_NOT_FOUND');
    }
    const routeData = routeSnap.data() as Route;
    if (routeData.status !== 'active') {
      throw new AppError(`Route '${routeData.routeCode}' is not active`, 400, 'ROUTE_NOT_ACTIVE');
    }

    const tripId = uuidv4();
    const now = new Date().toISOString();

    const newTrip: Trip = {
      tripId,
      busId: validatedData.busId,
      driverId: validatedData.driverId,
      routeId: validatedData.routeId,
      scheduledStart: validatedData.scheduledStart,
      scheduledEnd: validatedData.scheduledEnd,
      status: 'scheduled',
      notes: validatedData.notes,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(COLLECTIONS.TRIPS).doc(tripId).set(newTrip);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'trip.started', // or trip state transition
      affectedCollection: COLLECTIONS.TRIPS,
      affectedDocId: tripId,
      after: newTrip as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json(successResponse(newTrip, 'Trip scheduled successfully'));
  })
);

/**
 * PATCH /api/v1/trips/:tripId/start
 * Start trip:
 * - Verify trip is 'scheduled'
 * - Set status: 'in_progress', actualStart: now
 * - Update bus.currentTripId = tripId, driver.currentTripId = tripId
 */
router.patch(
  '/:tripId/start',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { tripId } = req.params;
    const tripRef = db.collection(COLLECTIONS.TRIPS).doc(tripId);
    const tripSnap = await tripRef.get();

    if (!tripSnap.exists) {
      throw new AppError(`Trip with ID '${tripId}' not found`, 404, 'TRIP_NOT_FOUND');
    }

    const tripData = tripSnap.data() as Trip;
    if (tripData.status !== 'scheduled' && tripData.status !== 'delayed') {
      throw new AppError(
        `Cannot start trip with status '${tripData.status}'. Trip must be scheduled or delayed.`,
        400,
        'INVALID_TRIP_STATUS'
      );
    }

    const now = new Date().toISOString();
    const batch = db.batch();

    // Update trip
    batch.update(tripRef, {
      status: 'in_progress' as TripStatus,
      actualStart: now,
      updatedAt: now,
    });

    // Update bus
    const busRef = db.collection(COLLECTIONS.BUSES).doc(tripData.busId);
    batch.update(busRef, {
      currentTripId: tripId,
      currentRouteId: tripData.routeId,
      updatedAt: now,
    });

    // Update driver
    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(tripData.driverId);
    batch.update(driverRef, {
      currentTripId: tripId,
      updatedAt: now,
    });

    await batch.commit();

    const updatedTrip = (await tripRef.get()).data() as Trip;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'trip.started',
      affectedCollection: COLLECTIONS.TRIPS,
      affectedDocId: tripId,
      before: tripData as unknown as Record<string, unknown>,
      after: updatedTrip as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedTrip, 'Trip started successfully'));
  })
);

/**
 * PATCH /api/v1/trips/:tripId/end
 * End trip:
 * - Verify trip is 'in_progress'
 * - Set status: 'completed', actualEnd: now
 * - Clear bus.currentTripId and driver.currentTripId
 */
router.patch(
  '/:tripId/end',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { tripId } = req.params;
    const tripRef = db.collection(COLLECTIONS.TRIPS).doc(tripId);
    const tripSnap = await tripRef.get();

    if (!tripSnap.exists) {
      throw new AppError(`Trip with ID '${tripId}' not found`, 404, 'TRIP_NOT_FOUND');
    }

    const tripData = tripSnap.data() as Trip;
    if (tripData.status !== 'in_progress') {
      throw new AppError(
        `Cannot end trip with status '${tripData.status}'. Only in-progress trips can be ended.`,
        400,
        'INVALID_TRIP_STATUS'
      );
    }

    const now = new Date().toISOString();
    const batch = db.batch();

    batch.update(tripRef, {
      status: 'completed' as TripStatus,
      actualEnd: now,
      updatedAt: now,
    });

    const busRef = db.collection(COLLECTIONS.BUSES).doc(tripData.busId);
    batch.update(busRef, {
      currentTripId: adminFirestoreDelete(),
      updatedAt: now,
    });

    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(tripData.driverId);
    batch.update(driverRef, {
      currentTripId: adminFirestoreDelete(),
      updatedAt: now,
    });

    await batch.commit();

    const updatedTrip = (await tripRef.get()).data() as Trip;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'trip.ended',
      affectedCollection: COLLECTIONS.TRIPS,
      affectedDocId: tripId,
      before: tripData as unknown as Record<string, unknown>,
      after: updatedTrip as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedTrip, 'Trip ended successfully'));
  })
);

/**
 * PATCH /api/v1/trips/:tripId/cancel
 * Cancel trip with optional reason:
 * - If in_progress: clear bus.currentTripId and driver.currentTripId
 * - Set status: 'cancelled'
 */
router.patch(
  '/:tripId/cancel',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { tripId } = req.params;
    const validatedData = cancelTripSchema.parse(req.body);

    const tripRef = db.collection(COLLECTIONS.TRIPS).doc(tripId);
    const tripSnap = await tripRef.get();

    if (!tripSnap.exists) {
      throw new AppError(`Trip with ID '${tripId}' not found`, 404, 'TRIP_NOT_FOUND');
    }

    const tripData = tripSnap.data() as Trip;
    if (tripData.status === 'completed' || tripData.status === 'cancelled') {
      throw new AppError(
        `Cannot cancel trip that is already ${tripData.status}`,
        400,
        'INVALID_TRIP_STATUS'
      );
    }

    const now = new Date().toISOString();
    const batch = db.batch();

    const updatePayload: Partial<Trip> = {
      status: 'cancelled',
      notes: validatedData.reason
        ? `${tripData.notes ? tripData.notes + ' | ' : ''}Cancellation reason: ${validatedData.reason}`
        : tripData.notes,
      updatedAt: now,
    };

    batch.update(tripRef, updatePayload);

    // If it was in progress, clear active bus and driver trip references
    if (tripData.status === 'in_progress') {
      const busRef = db.collection(COLLECTIONS.BUSES).doc(tripData.busId);
      batch.update(busRef, {
        currentTripId: adminFirestoreDelete(),
        updatedAt: now,
      });

      const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(tripData.driverId);
      batch.update(driverRef, {
        currentTripId: adminFirestoreDelete(),
        updatedAt: now,
      });
    }

    await batch.commit();

    const updatedTrip = (await tripRef.get()).data() as Trip;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'trip.cancelled',
      affectedCollection: COLLECTIONS.TRIPS,
      affectedDocId: tripId,
      before: tripData as unknown as Record<string, unknown>,
      after: updatedTrip as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedTrip, 'Trip cancelled successfully'));
  })
);

/**
 * PATCH /api/v1/trips/:tripId/delay
 * Mark delayed with delayMinutes and optional reason
 */
router.patch(
  '/:tripId/delay',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { tripId } = req.params;
    const validatedData = delayTripSchema.parse(req.body);

    const tripRef = db.collection(COLLECTIONS.TRIPS).doc(tripId);
    const tripSnap = await tripRef.get();

    if (!tripSnap.exists) {
      throw new AppError(`Trip with ID '${tripId}' not found`, 404, 'TRIP_NOT_FOUND');
    }

    const tripData = tripSnap.data() as Trip;
    if (tripData.status === 'completed' || tripData.status === 'cancelled') {
      throw new AppError(
        `Cannot delay trip that is already ${tripData.status}`,
        400,
        'INVALID_TRIP_STATUS'
      );
    }

    const now = new Date().toISOString();
    const updatePayload: Partial<Trip> = {
      status: tripData.status === 'in_progress' ? 'in_progress' : 'delayed',
      delayMinutes: (tripData.delayMinutes || 0) + validatedData.delayMinutes,
      notes: validatedData.reason
        ? `${tripData.notes ? tripData.notes + ' | ' : ''}Delay: +${validatedData.delayMinutes}m (${validatedData.reason})`
        : tripData.notes,
      updatedAt: now,
    };

    await tripRef.update(updatePayload);

    const updatedTrip = (await tripRef.get()).data() as Trip;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'trip.started', // or status updated
      affectedCollection: COLLECTIONS.TRIPS,
      affectedDocId: tripId,
      before: tripData as unknown as Record<string, unknown>,
      after: updatedTrip as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedTrip, `Trip delayed by ${validatedData.delayMinutes} minutes`));
  })
);

function adminFirestoreDelete() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin');
  return admin.firestore.FieldValue.delete();
}

export default router;
