import { randomBytes } from 'node:crypto';

/**
 * A fresh, unguessable id for a broadcast request (56 hex characters, the
 * length the sha256-derived ids it replaces had). Random rather than derived
 * from the request, so two identical requests never share an id and an id
 * reveals nothing about its request.
 */
export const newRequestId = (): string => randomBytes(28).toString('hex');
