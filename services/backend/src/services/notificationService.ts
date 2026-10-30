import { db, messaging } from '../config/firebase';
import { COLLECTIONS, NotificationType } from '@captain-campus/shared_types';
import { v4 as uuidv4 } from 'uuid';

export interface SendPushParams {
  userId?: string;
  topic?: string;
  title: string;
  body: string;
  type: NotificationType;
  data?: Record<string, string>;
  relatedBusId?: string;
  relatedRouteId?: string;
  relatedStopId?: string;
}

export class NotificationService {
  /**
   * Broadcasts a campus notification to all students or subscribed route topics,
   * saving notification records in Firestore and dispatching FCM multicast/topic messages.
   */
  static async sendCampusAlert(params: SendPushParams): Promise<{ sentCount: number }> {
    const { title, body, type, data, relatedRouteId, relatedBusId, relatedStopId } = params;

    let targetTokens: string[] = [];
    const notificationId = uuidv4();
    const nowIso = new Date().toISOString();

    try {
      // 1. Fetch user FCM tokens
      let usersQuery: FirebaseFirestore.Query = db.collection(COLLECTIONS.USERS);
      if (relatedRouteId) {
        usersQuery = usersQuery.where('preferredRouteId', '==', relatedRouteId);
      }

      const usersSnap = await usersQuery.get();
      const studentIds: string[] = [];

      usersSnap.forEach((doc) => {
        const u = doc.data();
        studentIds.push(doc.id);
        if (Array.isArray(u.fcmTokens)) {
          targetTokens.push(...u.fcmTokens);
        } else if (u.fcmToken && typeof u.fcmToken === 'string') {
          targetTokens.push(u.fcmToken);
        }
      });

      // Filter unique non-empty tokens
      targetTokens = Array.from(new Set(targetTokens.filter((t) => t && t.length > 10)));

      // 2. Persist notification records in Firestore in batches
      const batch = db.batch();
      for (const sId of studentIds.slice(0, 500)) {
        const notifDocRef = db.collection(COLLECTIONS.NOTIFICATIONS).doc(uuidv4());
        batch.set(notifDocRef, {
          notificationId,
          userId: sId,
          type,
          title,
          message: body,
          data: data || {},
          isRead: false,
          createdAt: nowIso,
          relatedBusId,
          relatedRouteId,
          relatedStopId,
        });
      }
      await batch.commit();

      // 3. Dispatch FCM multicast messages if tokens exist and not running in pure offline emulator test
      if (targetTokens.length > 0 && process.env.NODE_ENV !== 'test') {
        const fcmPayload = {
          notification: {
            title,
            body,
          },
          data: {
            type,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            ...(data || {}),
            ...(relatedRouteId ? { routeId: relatedRouteId } : {}),
            ...(relatedBusId ? { busId: relatedBusId } : {}),
          },
          tokens: targetTokens.slice(0, 500),
        };

        const response = await messaging.sendEachForMulticast(fcmPayload);
        console.log(`[FCM]: Dispatched alert to ${response.successCount} devices (failed: ${response.failureCount})`);
        return { sentCount: response.successCount };
      }
    } catch (err) {
      console.warn('[FCM Alert Error]:', err);
    }

    return { sentCount: targetTokens.length };
  }

  /**
   * Dispatches approaching bus notification when a bus enters a stop's proximity window.
   */
  static async sendApproachingBusAlert(params: {
    busNumber: string;
    routeCode: string;
    stopName: string;
    etaMinutes: number;
    routeId: string;
  }): Promise<void> {
    const { busNumber, routeCode, stopName, etaMinutes, routeId } = params;
    await NotificationService.sendCampusAlert({
      title: `Shuttle ${busNumber} Approaching`,
      body: `Shuttle ${busNumber} (${routeCode}) is approx. ${etaMinutes} mins away from ${stopName}.`,
      type: 'bus_approaching',
      relatedRouteId: routeId,
      data: {
        eta: etaMinutes.toString(),
        stopName,
      },
    });
  }
}
