import { Request, Response, NextFunction } from 'express';
import { auth, db } from '../config/firebase';
import { COLLECTIONS, UserRole, UserStatus } from '@captain-campus/shared_types';
import { AppError } from './errorHandler';

/**
 * Verifies Firebase ID Token in Authorization header (Bearer <token>).
 * Fetches user profile from Firestore to attach role.
 */
export async function verifyFirebaseToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(
      new AppError('Authorization header missing or invalid format (Bearer token required)', 401, 'UNAUTHORIZED')
    );
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return next(new AppError('Bearer token is empty', 401, 'UNAUTHORIZED'));
  }

  try {
    // Verify ID Token with Firebase Auth
    const decodedToken = await auth.verifyIdToken(token);
    const uid = decodedToken.uid;

    // Fetch user doc from Firestore
    const userDocRef = db.collection(COLLECTIONS.USERS).doc(uid);
    const userDocSnap = await userDocRef.get();

    let role: UserRole | undefined;

    if (userDocSnap.exists) {
      const userData = userDocSnap.data();
      const status: UserStatus = userData?.status || 'active';

      // Check if user is disabled / suspended
      if (status === 'suspended' || status === 'inactive') {
        return next(
          new AppError('Your account has been suspended or deactivated', 403, 'ACCOUNT_DISABLED')
        );
      }

      role = userData?.role as UserRole;
    } else {
      // Role may default or be set in custom claims
      role = (decodedToken.role as UserRole) || 'student';
    }

    req.user = {
      uid,
      email: decodedToken.email,
      role,
      decodedToken,
    };

    return next();
  } catch (error: any) {
    if (error?.code === 'auth/id-token-expired') {
      return next(new AppError('Firebase ID token has expired', 401, 'TOKEN_EXPIRED'));
    }
    if (error?.code === 'auth/id-token-revoked') {
      return next(new AppError('Firebase ID token has been revoked', 401, 'TOKEN_REVOKED'));
    }
    return next(new AppError(error?.message || 'Invalid authentication token', 401, 'INVALID_TOKEN'));
  }
}

/**
 * Optional authentication middleware:
 * If Bearer token is provided, validates it and sets req.user.
 * If not provided or invalid, proceeds with req.user undefined.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return next();
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const uid = decodedToken.uid;

    const userDocSnap = await db.collection(COLLECTIONS.USERS).doc(uid).get();
    let role: UserRole | undefined;

    if (userDocSnap.exists) {
      const userData = userDocSnap.data();
      role = userData?.role as UserRole;
    } else {
      role = (decodedToken.role as UserRole) || 'student';
    }

    req.user = {
      uid,
      email: decodedToken.email,
      role,
      decodedToken,
    };
  } catch {
    // Discard invalid token for optional auth, leave req.user empty
    req.user = undefined;
  }

  return next();
}

/**
 * Device authentication middleware for GPS telemetry ingestion.
 * Validates X-Device-Token header against GPS_DEVICE_SECRET or Firestore device registry.
 */
export async function verifyDeviceToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const deviceToken = (req.headers['x-device-token'] as string) || (req.headers['x-api-key'] as string);
  const deviceIdHeader = req.headers['x-device-id'] as string;

  if (!deviceToken) {
    return next(new AppError('Device authorization token missing (X-Device-Token header)', 401, 'UNAUTHORIZED_DEVICE'));
  }

  const configuredSecret = process.env.GPS_DEVICE_SECRET || 'change_this_to_a_long_random_secret_in_production';

  // 1. Check against shared secret
  if (deviceToken === configuredSecret) {
    req.deviceId = deviceIdHeader || 'device_secret_auth';
    return next();
  }

  // 2. Check against Firestore gpsDevices registry if deviceId is provided
  if (deviceIdHeader) {
    try {
      const deviceDoc = await db.collection(COLLECTIONS.GPS_DEVICES).doc(deviceIdHeader).get();
      if (deviceDoc.exists) {
        const data = deviceDoc.data();
        if (data?.token === deviceToken || data?.status === 'active') {
          req.deviceId = deviceIdHeader;
          return next();
        }
      }
    } catch {
      // Continue to error return
    }
  }

  return next(new AppError('Invalid device token or unauthorized GPS device', 401, 'INVALID_DEVICE_TOKEN'));
}
