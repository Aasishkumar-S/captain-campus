import { COLLECTIONS, AuditAction, AuditLog } from '@captain-campus/shared_types';
import { db } from '../config/firebase';
import { v4 as uuidv4 } from 'uuid';

/**
 * Writes an entry to the Firestore auditLogs collection using the Admin SDK.
 * Never throws — catches and logs errors silently so audit failures do not disrupt the client request.
 */
export async function writeAuditLog(params: {
  actorId: string;
  actorEmail?: string;
  actorRole?: string;
  action: AuditAction;
  affectedCollection: string;
  affectedDocId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    const logId = uuidv4();
    const logEntry: AuditLog = {
      logId,
      actorId: params.actorId,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      action: params.action,
      affectedCollection: params.affectedCollection,
      affectedDocId: params.affectedDocId,
      before: params.before,
      after: params.after,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      timestamp: new Date().toISOString(),
    };

    await db.collection(COLLECTIONS.AUDIT_LOGS).doc(logId).set(logEntry);
  } catch (error) {
    // Silently log warning to server console, do not throw
    console.warn('[AuditLogger] Failed to write audit log entry:', error);
  }
}
