import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse, paginatedResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import {
  createDriverSchema,
  updateDriverSchema,
  assignDriverSchema,
} from '../validation/driverSchemas';
import {
  COLLECTIONS,
  Driver,
  Bus,
  DriverStatus,
  Trip,
} from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /api/v1/drivers or /api/v1/admin/drivers
 * List drivers with optional ?status= filter and pagination (?page=&pageSize=).
 * Requires verifyFirebaseToken + requireAdmin.
 */
router.get(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const statusFilter = req.query.status as DriverStatus | undefined;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize as string, 10) || 20));

    let query: FirebaseFirestore.Query = db.collection(COLLECTIONS.DRIVERS);

    if (statusFilter) {
      query = query.where('status', '==', statusFilter);
    }

    const snapshot = await query.get();
    const allDrivers: Driver[] = [];
    snapshot.forEach((doc) => {
      allDrivers.push(doc.data() as Driver);
    });

    // In-memory sort by createdAt desc for consistency
    allDrivers.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const total = allDrivers.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedDrivers = allDrivers.slice(startIndex, startIndex + pageSize);

    res.json(successResponse(paginatedResponse(paginatedDrivers, total, page, pageSize)));
  })
);

/**
 * GET /api/v1/drivers/:driverId
 * Get single driver details.
 */
router.get(
  '/:driverId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { driverId } = req.params;
    const driverSnap = await db.collection(COLLECTIONS.DRIVERS).doc(driverId).get();

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }

    const driver = driverSnap.data() as Driver;
    res.json(successResponse(driver));
  })
);

/**
 * POST /api/v1/drivers
 * Create driver with Zod validation, check duplicate licenceNumber across all drivers.
 */
router.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createDriverSchema.parse(req.body);

    // Check duplicate licenceNumber
    const existingLicenceSnap = await db
      .collection(COLLECTIONS.DRIVERS)
      .where('licenceNumber', '==', validatedData.licenceNumber.trim())
      .limit(1)
      .get();

    if (!existingLicenceSnap.empty) {
      throw new AppError(
        `Driver with licence number '${validatedData.licenceNumber}' already exists`,
        409,
        'DUPLICATE_LICENCE_NUMBER'
      );
    }

    const driverId = uuidv4();
    const now = new Date().toISOString();

    const newDriver: Driver = {
      driverId,
      name: validatedData.name.trim(),
      phone: validatedData.phone.trim(),
      email: validatedData.email ? validatedData.email.trim().toLowerCase() : undefined,
      licenceNumber: validatedData.licenceNumber.trim(),
      licenceExpiry: validatedData.licenceExpiry,
      employeeId: validatedData.employeeId?.trim(),
      status: validatedData.status,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(COLLECTIONS.DRIVERS).doc(driverId).set(newDriver);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'driver.created',
      affectedCollection: COLLECTIONS.DRIVERS,
      affectedDocId: driverId,
      after: newDriver as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json(successResponse(newDriver, 'Driver created successfully'));
  })
);

/**
 * PATCH /api/v1/drivers/:driverId
 * Update driver.
 */
router.patch(
  '/:driverId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { driverId } = req.params;
    const validatedData = updateDriverSchema.parse(req.body);

    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(driverId);
    const driverSnap = await driverRef.get();

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }

    const beforeData = driverSnap.data() as Driver;

    // Check duplicate licenceNumber if changed
    if (
      validatedData.licenceNumber &&
      validatedData.licenceNumber.trim() !== beforeData.licenceNumber
    ) {
      const existingLicenceSnap = await db
        .collection(COLLECTIONS.DRIVERS)
        .where('licenceNumber', '==', validatedData.licenceNumber.trim())
        .limit(1)
        .get();

      if (!existingLicenceSnap.empty && existingLicenceSnap.docs[0].id !== driverId) {
        throw new AppError(
          `Driver with licence number '${validatedData.licenceNumber}' already exists`,
          409,
          'DUPLICATE_LICENCE_NUMBER'
        );
      }
    }

    const updates: Partial<Driver> = {
      ...validatedData,
      ...(validatedData.name ? { name: validatedData.name.trim() } : {}),
      ...(validatedData.phone ? { phone: validatedData.phone.trim() } : {}),
      ...(validatedData.email ? { email: validatedData.email.trim().toLowerCase() } : {}),
      ...(validatedData.licenceNumber ? { licenceNumber: validatedData.licenceNumber.trim() } : {}),
      ...(validatedData.employeeId !== undefined ? { employeeId: validatedData.employeeId?.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };

    await driverRef.update(updates);

    const updatedDoc = (await driverRef.get()).data() as Driver;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'driver.updated',
      affectedCollection: COLLECTIONS.DRIVERS,
      affectedDocId: driverId,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDoc, 'Driver updated successfully'));
  })
);

/**
 * PATCH /api/v1/drivers/:driverId/assign
 * Assign driver to bus (validate bus exists and is active, update both driver.currentBusId and bus.driverId).
 */
router.patch(
  '/:driverId/assign',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { driverId } = req.params;
    const { busId } = assignDriverSchema.parse(req.body);

    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(driverId);
    const busRef = db.collection(COLLECTIONS.BUSES).doc(busId);

    const [driverSnap, busSnap] = await Promise.all([driverRef.get(), busRef.get()]);

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }
    if (!busSnap.exists) {
      throw new AppError(`Bus with ID '${busId}' not found`, 404, 'BUS_NOT_FOUND');
    }

    const driverData = driverSnap.data() as Driver;
    const busData = busSnap.data() as Bus;

    if (driverData.status !== 'active') {
      throw new AppError(
        `Cannot assign driver with status '${driverData.status}'. Driver must be active.`,
        400,
        'DRIVER_NOT_ACTIVE'
      );
    }

    if (busData.status !== 'active') {
      throw new AppError(
        `Cannot assign bus with status '${busData.status}'. Bus must be active.`,
        400,
        'BUS_NOT_ACTIVE'
      );
    }

    // If driver was previously assigned to another bus, clear that bus's driverId
    const now = new Date().toISOString();
    const batch = db.batch();

    if (driverData.currentBusId && driverData.currentBusId !== busId) {
      const oldBusRef = db.collection(COLLECTIONS.BUSES).doc(driverData.currentBusId);
      batch.update(oldBusRef, { driverId: adminFirestoreDelete(), updatedAt: now });
    }

    // If bus was previously assigned to another driver, clear that driver's currentBusId
    if (busData.driverId && busData.driverId !== driverId) {
      const oldDriverRef = db.collection(COLLECTIONS.DRIVERS).doc(busData.driverId);
      batch.update(oldDriverRef, { currentBusId: adminFirestoreDelete(), updatedAt: now });
    }

    // Update current bus and driver
    batch.update(driverRef, { currentBusId: busId, updatedAt: now });
    batch.update(busRef, { driverId, updatedAt: now });

    await batch.commit();

    const updatedDriver = (await driverRef.get()).data() as Driver;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'driver.assigned',
      affectedCollection: COLLECTIONS.DRIVERS,
      affectedDocId: driverId,
      before: driverData as unknown as Record<string, unknown>,
      after: updatedDriver as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDriver, `Driver successfully assigned to bus ${busData.busNumber}`));
  })
);

/**
 * PATCH /api/v1/drivers/:driverId/unassign
 * Remove driver from current bus assignment (clear both sides).
 */
router.patch(
  '/:driverId/unassign',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { driverId } = req.params;
    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(driverId);
    const driverSnap = await driverRef.get();

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }

    const driverData = driverSnap.data() as Driver;
    const currentBusId = driverData.currentBusId;

    const now = new Date().toISOString();
    const batch = db.batch();

    batch.update(driverRef, { currentBusId: adminFirestoreDelete(), updatedAt: now });

    if (currentBusId) {
      const busRef = db.collection(COLLECTIONS.BUSES).doc(currentBusId);
      batch.update(busRef, { driverId: adminFirestoreDelete(), updatedAt: now });
    }

    await batch.commit();

    const updatedDriver = (await driverRef.get()).data() as Driver;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'driver.updated',
      affectedCollection: COLLECTIONS.DRIVERS,
      affectedDocId: driverId,
      before: driverData as unknown as Record<string, unknown>,
      after: updatedDriver as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDriver, 'Driver unassigned successfully'));
  })
);

/**
 * DELETE /api/v1/drivers/:driverId
 * Deactivate (status = 'inactive'), fail if driver is in an active trip.
 */
router.delete(
  '/:driverId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { driverId } = req.params;
    const driverRef = db.collection(COLLECTIONS.DRIVERS).doc(driverId);
    const driverSnap = await driverRef.get();

    if (!driverSnap.exists) {
      throw new AppError(`Driver with ID '${driverId}' not found`, 404, 'DRIVER_NOT_FOUND');
    }

    const driverData = driverSnap.data() as Driver;

    // Fail if driver is currently in an active / in_progress trip
    const activeTripsSnap = await db
      .collection(COLLECTIONS.TRIPS)
      .where('driverId', '==', driverId)
      .where('status', '==', 'in_progress')
      .limit(1)
      .get();

    if (!activeTripsSnap.empty) {
      throw new AppError(
        'Cannot deactivate driver while an active in-progress trip is ongoing',
        400,
        'DRIVER_ACTIVE_TRIP_IN_PROGRESS'
      );
    }

    const now = new Date().toISOString();
    const batch = db.batch();

    batch.update(driverRef, {
      status: 'inactive' as DriverStatus,
      currentBusId: adminFirestoreDelete(),
      updatedAt: now,
    });

    // Also unassign from bus if assigned
    if (driverData.currentBusId) {
      const busRef = db.collection(COLLECTIONS.BUSES).doc(driverData.currentBusId);
      batch.update(busRef, {
        driverId: adminFirestoreDelete(),
        updatedAt: now,
      });
    }

    await batch.commit();

    const updatedDriver = (await driverRef.get()).data() as Driver;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'driver.updated',
      affectedCollection: COLLECTIONS.DRIVERS,
      affectedDocId: driverId,
      before: driverData as unknown as Record<string, unknown>,
      after: updatedDriver as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDriver, 'Driver deactivated successfully'));
  })
);

function adminFirestoreDelete() {
  // Use admin FieldValue delete to safely unset fields
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin');
  return admin.firestore.FieldValue.delete();
}

export default router;
