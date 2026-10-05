import { createHmac, timingSafeEqual } from 'node:crypto';

function signatureFor(fileId, secret) {
  return createHmac('sha256', secret).update(fileId).digest('base64url');
}

export function createDriveFileToken(fileId, secret) {
  return signatureFor(fileId, secret);
}

export function verifyDriveFileToken(fileId, token, secret) {
  if (!fileId || !token || !secret) return false;
  const expected = Buffer.from(signatureFor(fileId, secret));
  const received = Buffer.from(String(token));
  return expected.length === received.length && timingSafeEqual(expected, received);
}
