/**
 * Phase 3 T3.5 — bcrypt password hashing via bcryptjs (pure JS).
 *
 * argon2id would be cryptographically preferable (master plan §8.3), but
 * the native `argon2` + napi-rs `@node-rs/argon2` both have build/runtime
 * friction with pnpm 11 deploy + distroless Cloud Run. bcrypt cost=12 is
 * OWASP-recommended for new applications and runs in ~200-250ms — well
 * within Cloud Run's request budget. Migrate to argon2id later if/when
 * the deploy story improves (Phase 7).
 */
import bcrypt from 'bcryptjs';
const COST = 12;
export async function hashPassword(plain) {
    return bcrypt.hash(plain, COST);
}
export async function verifyPassword(hashStr, plain) {
    try {
        return await bcrypt.compare(plain, hashStr);
    }
    catch {
        return false;
    }
}
export function passwordPolicyError(password) {
    if (typeof password !== 'string')
        return 'password must be a string';
    if (password.length < 8)
        return 'password must be at least 8 characters';
    // bcrypt only hashes the first 72 bytes — cap input to avoid silent truncation.
    if (password.length > 72)
        return 'password must be ≤ 72 characters';
    return null;
}
