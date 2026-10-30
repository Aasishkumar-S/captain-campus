import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler, AppError } from '../middleware/errorHandler';
import { successResponse, paginatedResponse } from '../utils/responseHelpers';
import { writeAuditLog } from '../utils/auditLogger';
import {
  createAnnouncementSchema,
  updateAnnouncementSchema,
} from '../validation/announcementSchemas';
import {
  COLLECTIONS,
  Announcement,
  AnnouncementStatus,
} from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';
import { NotificationService } from '../services/notificationService';

/**
 * Public (Student) Announcements Router
 * Mounted at /api/v1/announcements
 */
export const announcementsPublicRouter = Router();

/**
 * GET /api/v1/announcements
 * List published, non-expired announcements. Optional ?routeId= filter.
 */
announcementsPublicRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { routeId } = req.query;
    const nowIso = new Date().toISOString();

    const snapshot = await db
      .collection(COLLECTIONS.ANNOUNCEMENTS)
      .where('status', '==', 'published')
      .get();

    const announcements: Announcement[] = [];
    snapshot.forEach((doc) => {
      announcements.push(doc.data() as Announcement);
    });

    // Filter out expired announcements and those scheduled for future publish
    const activeAnnouncements = announcements.filter((a) => {
      if (a.publishAt && a.publishAt > nowIso) return false;
      if (a.expiresAt && a.expiresAt < nowIso) return false;
      if (routeId && typeof routeId === 'string') {
        // If announcement has affectedRouteIds, check if routeId is included or empty array (general)
        if (a.affectedRouteIds && a.affectedRouteIds.length > 0) {
          return a.affectedRouteIds.includes(routeId);
        }
      }
      return true;
    });

    // Sort newest first
    activeAnnouncements.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json(successResponse(activeAnnouncements));
  })
);

/**
 * Admin Announcements Router
 * Mounted at /api/v1/admin/announcements
 */
export const announcementsAdminRouter = Router();

/**
 * GET /api/v1/admin/announcements
 * List all announcements across all statuses with pagination (?page=&pageSize=).
 */
announcementsAdminRouter.get(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize as string, 10) || 20));

    const snapshot = await db.collection(COLLECTIONS.ANNOUNCEMENTS).get();

    const allAnnouncements: Announcement[] = [];
    snapshot.forEach((doc) => {
      allAnnouncements.push(doc.data() as Announcement);
    });

    allAnnouncements.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const total = allAnnouncements.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedAnnouncements = allAnnouncements.slice(startIndex, startIndex + pageSize);

    res.json(successResponse(paginatedResponse(paginatedAnnouncements, total, page, pageSize)));
  })
);

/**
 * POST /api/v1/admin/announcements
 * Create new announcement.
 */
announcementsAdminRouter.post(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const validatedData = createAnnouncementSchema.parse(req.body);

    const announcementId = uuidv4();
    const now = new Date().toISOString();

    const newAnnouncement: Announcement = {
      announcementId,
      title: validatedData.title.trim(),
      message: validatedData.message.trim(),
      severity: validatedData.severity,
      affectedRouteIds: validatedData.affectedRouteIds || [],
      affectedStopIds: validatedData.affectedStopIds,
      affectedBusIds: validatedData.affectedBusIds,
      createdBy: req.user!.uid,
      createdAt: now,
      publishAt: validatedData.publishAt,
      expiresAt: validatedData.expiresAt,
      status: validatedData.status,
      fcmSent: false,
    };

    await db.collection(COLLECTIONS.ANNOUNCEMENTS).doc(announcementId).set(newAnnouncement);

    // Dispatch FCM notification if published
    if (newAnnouncement.status === 'published') {
      try {
        await NotificationService.sendCampusAlert({
          title: `Transit Announcement: ${newAnnouncement.title}`,
          body: newAnnouncement.message,
          type: 'announcement',
          relatedRouteId: newAnnouncement.affectedRouteIds?.[0],
          data: {
            announcementId,
            severity: newAnnouncement.severity,
          },
        });
        await db.collection(COLLECTIONS.ANNOUNCEMENTS).doc(announcementId).update({
          fcmSent: true,
          fcmSentAt: new Date().toISOString(),
        });
        newAnnouncement.fcmSent = true;
      } catch (err) {
        console.warn('FCM dispatch failed for announcement:', err);
      }
    }

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'announcement.published',
      affectedCollection: COLLECTIONS.ANNOUNCEMENTS,
      affectedDocId: announcementId,
      after: newAnnouncement as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json(successResponse(newAnnouncement, 'Announcement created successfully'));
  })
);

/**
 * PATCH /api/v1/admin/announcements/:id
 * Update announcement.
 */
announcementsAdminRouter.patch(
  '/:id',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const validatedData = updateAnnouncementSchema.parse(req.body);

    const announcementRef = db.collection(COLLECTIONS.ANNOUNCEMENTS).doc(id);
    const snap = await announcementRef.get();

    if (!snap.exists) {
      throw new AppError(`Announcement with ID '${id}' not found`, 404, 'ANNOUNCEMENT_NOT_FOUND');
    }

    const beforeData = snap.data() as Announcement;

    const updates: Partial<Announcement> = {
      ...validatedData,
      ...(validatedData.title ? { title: validatedData.title.trim() } : {}),
      ...(validatedData.message ? { message: validatedData.message.trim() } : {}),
    };

    await announcementRef.update(updates);

    const updatedDoc = (await announcementRef.get()).data() as Announcement;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'announcement.published',
      affectedCollection: COLLECTIONS.ANNOUNCEMENTS,
      affectedDocId: id,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDoc, 'Announcement updated successfully'));
  })
);

/**
 * DELETE /api/v1/admin/announcements/:id
 * Cancel announcement (status: 'cancelled').
 */
announcementsAdminRouter.delete(
  '/:id',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const announcementRef = db.collection(COLLECTIONS.ANNOUNCEMENTS).doc(id);
    const snap = await announcementRef.get();

    if (!snap.exists) {
      throw new AppError(`Announcement with ID '${id}' not found`, 404, 'ANNOUNCEMENT_NOT_FOUND');
    }

    const beforeData = snap.data() as Announcement;
    const updates = {
      status: 'cancelled' as AnnouncementStatus,
    };

    await announcementRef.update(updates);

    const updatedDoc = (await announcementRef.get()).data() as Announcement;

    await writeAuditLog({
      actorId: req.user!.uid,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'announcement.cancelled',
      affectedCollection: COLLECTIONS.ANNOUNCEMENTS,
      affectedDocId: id,
      before: beforeData as unknown as Record<string, unknown>,
      after: updatedDoc as unknown as Record<string, unknown>,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(successResponse(updatedDoc, 'Announcement cancelled successfully'));
  })
);
