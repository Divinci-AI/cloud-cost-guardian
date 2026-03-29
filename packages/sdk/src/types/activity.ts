/**
 * Activity Log types
 */

import type { PaginationOptions } from "./common.js";

export interface ActivityEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  actorUserId: string;
  actorEmail?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  createdAt: string;
}

export interface ActivityQuery extends PaginationOptions {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
}
