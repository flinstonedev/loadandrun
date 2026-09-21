import {randomUUID, createHash, scryptSync, timingSafeEqual, randomBytes} from 'node:crypto';

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function fail(message, status = 400) {throw Object.assign(new Error(message), {status});}
export function text(value, max = 20000) {
  if (typeof value !== 'string' || value.length > max) fail('Invalid text or text too long.');
  return value;
}
export function url(value) {
  if (!value) return '';
  try {const result = new URL(value); if (['https:', 'http:'].includes(result.protocol)) return result.href;} catch {}
  fail('Use a complete http or https link.');
}
export function newUser(name, password) {
  text(name, 80); if (!name.trim()) fail('Enter a name.');
  text(password, 256); if (password.length < 10) fail('Use at least 10 characters for your password.');
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 32);
  return {id: uid(), name: name.trim(), salt, hash: createHash('sha256').update(key).digest('hex')};
}
export function authenticateUser(user, password) {
  text(password, 256);
  if (!user?.salt || typeof user.hash !== 'string' || !/^[0-9a-f]{64}$/.test(user.hash)) fail('Name or password is incorrect.', 401);
  const key = scryptSync(password, user.salt, 32);
  const hash = createHash('sha256').update(key).digest();
  if (!timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) fail('Name or password is incorrect.', 401);
  return true;
}
