import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import { createStopSchema, updateStopSchema } from '../validation/stopSchemas';
import { COLLECTIONS, Stop } from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /api/v1/stops
 * List all active stops.
 */
router.get(
  '/',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const stopsSnap = await db
      .collection(COLLECTIONS.STOPS)
      .where('status', 'in', ['active', 'temporary'])
      .get();

    const stops: Stop[] = [];
    stopsSnap.forEach((doc) => {
      stops.push(doc.data() as Stop);
    });

    res.json(successResponse(stops));
  })
);

/**
 * GET /api/v1/stops/:stopId
 * Get single stop.
 */
router.get(
  '/:stopId',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { stopId } = req.params;
    const stopSnap = await db.collection(COLLECTIONS.STOPS).doc(stopId).get();

    if (!stopSnap.exists) {
      throw new AppError(`Stop with ID '${stopId}' not found`, 404, 'STOP_NOT_FOUND');
    }

    const stop = stopSnap.data() as Stop;
    res.json(successResponse(stop));
  })
);

/**
 * POST /api/v1/stops
 * Create stop (admin only, validates lat/lng bounds).
 */
router.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createStopSchema.parse(req.body);

    const stopId = uuidv4();
    const now = new Date().toISOString();

    const newStop: Stop = {
      stopId,
      name: validatedData.name,
      shortName: validatedData.shortName,
      latitude: validatedData.latitude,
      longitude: validatedData.longitude,
      address: validatedData.address,
      description: validatedData.description,
      status: validatedData.status,
      facilities: validatedData.facilities,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(COLLECTIONS.STOPS).doc(stopId).set(newStop);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'stop.created',
      affectedCollection: COLLECTIONS.STOPS,
      affectedDocId: stopId,
      after: newStop as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.status(201).json(successResponse(newStop, 'Stop created successfully'));
  })
);

/**
 * PATCH /api/v1/stops/:stopId
 * Update stop (admin only).
 */
router.patch(
  '/:stopId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { stopId } = req.params;
    const validatedData = updateStopSchema.parse(req.body);

    const stopRef = db.collection(COLLECTIONS.STOPS).doc(stopId);
    const stopSnap = await stopRef.get();

    if (!stopSnap.exists) {
      throw new AppError(`Stop with ID '${stopId}' not found`, 404, 'STOP_NOT_FOUND');
    }

    const beforeData = stopSnap.data() as Stop;
    const updates: Partial<Stop> = {
      ...validatedData,
      updatedAt: new Date().toISOString(),
    };

    await stopRef.update(updates);

    const updatedDoc = (await stopRef.get()).data() as Stop;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'stop.updated',
      affectedCollection: COLLECTIONS.STOPS,
      affectedDocId: stopId,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.json(successResponse(updatedDoc, 'Stop updated successfully'));
  })
);

/**
 * DELETE /api/v1/stops/:stopId
 * Deactivate stop (admin only, soft delete).
 */
router.delete(
  '/:stopId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { stopId } = req.params;
    const stopRef = db.collection(COLLECTIONS.STOPS).doc(stopId);
    const stopSnap = await stopRef.get();

    if (!stopSnap.exists) {
      throw new AppError(`Stop with ID '${stopId}' not found`, 404, 'STOP_NOT_FOUND');
    }

    const beforeData = stopSnap.data() as Stop;
    const updates = {
      status: 'inactive' as const,
      updatedAt: new Date().toISOString(),
    };

    await stopRef.update(updates);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'stop.deleted',
      affectedCollection: COLLECTIONS.STOPS,
      affectedDocId: stopId,
      before: beforeData as unknown as Record<string, unknown>,
      after: { ...beforeData, ...updates },
      ipAddress: req.ip,
    });

    res.json(successResponse({ stopId, status: 'inactive' }, 'Stop deactivated successfully'));
  })
);

export default router;
