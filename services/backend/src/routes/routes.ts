import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import { createRouteSchema, updateRouteSchema } from '../validation/routeSchemas';
import {
  COLLECTIONS,
  Route,
  RouteSummary,
  StopSequenceEntry,
} from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * Validates stop sequence continuity:
 * Checks that sequence numbers start at 1, are consecutive without gaps or duplicates,
 * and that originStopId and destinationStopId match sequence start/end.
 */
function validateStopSequenceContinuity(
  stopSequence: StopSequenceEntry[],
  originStopId?: string,
  destinationStopId?: string
): void {
  if (stopSequence.length < 2) {
    throw new AppError('A route must contain at least 2 stops in its sequence', 400, 'INVALID_SEQUENCE');
  }

  const sorted = [...stopSequence].sort((a, b) => a.sequence - b.sequence);

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].sequence !== i + 1) {
      throw new AppError(
        `Stop sequence continuity error: Expected sequence index ${i + 1}, found ${sorted[i].sequence}`,
        400,
        'INVALID_SEQUENCE_CONTINUITY'
      );
    }
  }

  if (originStopId && sorted[0].stopId !== originStopId) {
    throw new AppError(
      `First stop in sequence (${sorted[0].stopId}) must match originStopId (${originStopId})`,
      400,
      'INVALID_ORIGIN_STOP'
    );
  }

  if (destinationStopId && sorted[sorted.length - 1].stopId !== destinationStopId) {
    throw new AppError(
      `Last stop in sequence (${sorted[sorted.length - 1].stopId}) must match destinationStopId (${destinationStopId})`,
      400,
      'INVALID_DESTINATION_STOP'
    );
  }
}

/**
 * GET /api/v1/routes
 * List routes (students and authenticated users can access).
 */
router.get(
  '/',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const routesSnap = await db
      .collection(COLLECTIONS.ROUTES)
      .where('status', 'in', ['active'])
      .get();

    const routes: RouteSummary[] = [];
    routesSnap.forEach((doc) => {
      const data = doc.data() as Route;
      routes.push({
        routeId: data.routeId,
        routeCode: data.routeCode,
        routeName: data.routeName,
        direction: data.direction,
        status: data.status,
        stopCount: data.stopSequence ? data.stopSequence.length : 0,
      });
    });

    res.json(successResponse(routes));
  })
);

/**
 * GET /api/v1/routes/:routeId
 * Get single route with full stopSequence.
 */
router.get(
  '/:routeId',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const { routeId } = req.params;
    const routeSnap = await db.collection(COLLECTIONS.ROUTES).doc(routeId).get();

    if (!routeSnap.exists) {
      throw new AppError(`Route with ID '${routeId}' not found`, 404, 'ROUTE_NOT_FOUND');
    }

    const route = routeSnap.data() as Route;
    res.json(successResponse(route));
  })
);

/**
 * POST /api/v1/routes (or admin alias)
 * Create route (admin only).
 */
router.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createRouteSchema.parse(req.body);

    // Validate sequence continuity
    validateStopSequenceContinuity(
      validatedData.stopSequence,
      validatedData.originStopId,
      validatedData.destinationStopId
    );

    // Check duplicate routeCode
    const existingCode = await db
      .collection(COLLECTIONS.ROUTES)
      .where('routeCode', '==', validatedData.routeCode.toUpperCase())
      .limit(1)
      .get();

    if (!existingCode.empty) {
      throw new AppError(
        `Route with code '${validatedData.routeCode}' already exists`,
        409,
        'DUPLICATE_ROUTE_CODE'
      );
    }

    const routeId = uuidv4();
    const now = new Date().toISOString();

    const newRoute: Route = {
      routeId,
      routeCode: validatedData.routeCode.toUpperCase(),
      routeName: validatedData.routeName,
      direction: validatedData.direction,
      originStopId: validatedData.originStopId,
      destinationStopId: validatedData.destinationStopId,
      stopSequence: validatedData.stopSequence,
      operatingDays: validatedData.operatingDays,
      firstDeparture: validatedData.firstDeparture,
      lastDeparture: validatedData.lastDeparture,
      estimatedDuration: validatedData.estimatedDuration,
      status: validatedData.status,
      color: validatedData.color,
      description: validatedData.description,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection(COLLECTIONS.ROUTES).doc(routeId).set(newRoute);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'route.created',
      affectedCollection: COLLECTIONS.ROUTES,
      affectedDocId: routeId,
      after: newRoute as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.status(201).json(successResponse(newRoute, 'Route created successfully'));
  })
);

/**
 * PATCH /api/v1/routes/:routeId
 * Update route (admin only).
 */
router.patch(
  '/:routeId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { routeId } = req.params;
    const validatedData = updateRouteSchema.parse(req.body);

    const routeRef = db.collection(COLLECTIONS.ROUTES).doc(routeId);
    const routeSnap = await routeRef.get();

    if (!routeSnap.exists) {
      throw new AppError(`Route with ID '${routeId}' not found`, 404, 'ROUTE_NOT_FOUND');
    }

    const beforeData = routeSnap.data() as Route;

    // Validate sequence continuity if updated
    if (validatedData.stopSequence) {
      validateStopSequenceContinuity(
        validatedData.stopSequence,
        validatedData.originStopId || beforeData.originStopId,
        validatedData.destinationStopId || beforeData.destinationStopId
      );
    }

    // Check duplicate code if changed
    if (
      validatedData.routeCode &&
      validatedData.routeCode.toUpperCase() !== beforeData.routeCode
    ) {
      const existing = await db
        .collection(COLLECTIONS.ROUTES)
        .where('routeCode', '==', validatedData.routeCode.toUpperCase())
        .limit(1)
        .get();

      if (!existing.empty && existing.docs[0].id !== routeId) {
        throw new AppError(
          `Route with code '${validatedData.routeCode}' already exists`,
          409,
          'DUPLICATE_ROUTE_CODE'
        );
      }
    }

    const updates: Partial<Route> = {
      ...validatedData,
      ...(validatedData.routeCode ? { routeCode: validatedData.routeCode.toUpperCase() } : {}),
      updatedAt: new Date().toISOString(),
    };

    await routeRef.update(updates);

    const updatedDoc = (await routeRef.get()).data() as Route;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'route.updated',
      affectedCollection: COLLECTIONS.ROUTES,
      affectedDocId: routeId,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.json(successResponse(updatedDoc, 'Route updated successfully'));
  })
);

/**
 * DELETE /api/v1/routes/:routeId
 * Deactivate route (admin only).
 */
router.delete(
  '/:routeId',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { routeId } = req.params;
    const routeRef = db.collection(COLLECTIONS.ROUTES).doc(routeId);
    const routeSnap = await routeRef.get();

    if (!routeSnap.exists) {
      throw new AppError(`Route with ID '${routeId}' not found`, 404, 'ROUTE_NOT_FOUND');
    }

    const beforeData = routeSnap.data() as Route;
    const updates = {
      status: 'inactive' as const,
      updatedAt: new Date().toISOString(),
    };

    await routeRef.update(updates);

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'route.deleted',
      affectedCollection: COLLECTIONS.ROUTES,
      affectedDocId: routeId,
      before: beforeData as unknown as Record<string, unknown>,
      after: { ...beforeData, ...updates },
      ipAddress: req.ip,
    });

    res.json(successResponse({ routeId, status: 'inactive' }, 'Route deactivated successfully'));
  })
);

export default router;
