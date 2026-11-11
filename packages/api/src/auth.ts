import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, storedKey] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !storedKey || !/^[a-f0-9]{128}$/i.test(storedKey)) return false;
  const actualKey = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return timingSafeEqual(actualKey, Buffer.from(storedKey, "hex"));
}

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
