import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import { COLLECTIONS, User, UserProfile } from '@captain-campus/shared_types';
import { z } from 'zod';

const router = Router();

const registerProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  studentId: z.string().optional(),
  phone: z.string().optional(),
  preferredStopId: z.string().optional(),
  preferredRouteId: z.string().optional(),
  photoUrl: z.string().url().optional(),
});

/**
 * GET /api/v1/me
 * Returns current authenticated user's profile from Firestore.
 */
router.get(
  '/me',
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const uid = req.user!.uid;
    const userDocRef = db.collection(COLLECTIONS.USERS).doc(uid);
    const docSnap = await userDocRef.get();

    if (!docSnap.exists) {
      throw new AppError('User profile not found. Please complete registration.', 404, 'PROFILE_NOT_FOUND');
    }

    const userData = docSnap.data() as User;
    const profile: UserProfile = {
      userId: userData.userId || uid,
      name: userData.name,
      email: userData.email,
      studentId: userData.studentId,
      role: userData.role,
      preferredStopId: userData.preferredStopId,
      preferredRouteId: userData.preferredRouteId,
      photoUrl: userData.photoUrl,
      notificationPreferences: userData.notificationPreferences,
    };

    res.json(successResponse(profile));
  })
);

/**
 * POST /api/v1/auth/register-profile
 * Called after Firebase Auth signup to initialize the Firestore user doc with role='student'.
 * Validates that user doc doesn't already exist before creating.
 */
router.post(
  '/auth/register-profile',
  authLimiter,
  verifyFirebaseToken,
  asyncHandler(async (req: Request, res: Response) => {
    const uid = req.user!.uid;
    const email = req.user!.email || '';

    // Validate request body
    const validatedData = registerProfileSchema.parse(req.body);

    const userDocRef = db.collection(COLLECTIONS.USERS).doc(uid);
    const existingSnap = await userDocRef.get();

    if (existingSnap.exists) {
      throw new AppError('User profile already registered', 409, 'PROFILE_ALREADY_EXISTS');
    }

    const now = new Date().toISOString();

    const newUser: User = {
      userId: uid,
      name: validatedData.name,
      email,
      studentId: validatedData.studentId,
      phone: validatedData.phone,
      role: 'student', // Initial signup defaults to student
      preferredStopId: validatedData.preferredStopId,
      preferredRouteId: validatedData.preferredRouteId,
      photoUrl: validatedData.photoUrl,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      notificationPreferences: {
        busApproaching: true,
        approachingMinutes: 10,
        delays: true,
        cancellations: true,
        routeChanges: true,
        announcements: true,
      },
    };

    await userDocRef.set(newUser);

    await writeAuditLog({
      actorId: uid,
      actorEmail: email,
      actorRole: 'student',
      action: 'user.created',
      affectedCollection: COLLECTIONS.USERS,
      affectedDocId: uid,
      after: newUser as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    const profile: UserProfile = {
      userId: newUser.userId,
      name: newUser.name,
      email: newUser.email,
      studentId: newUser.studentId,
      role: newUser.role,
      preferredStopId: newUser.preferredStopId,
      preferredRouteId: newUser.preferredRouteId,
      photoUrl: newUser.photoUrl,
      notificationPreferences: newUser.notificationPreferences,
    };

    res.status(201).json(successResponse(profile, 'User profile registered successfully'));
  })
);

export default router;
