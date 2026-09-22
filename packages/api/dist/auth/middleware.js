import { loadEnv } from '../env.js';
import { verifyAccessToken } from './jwt.js';
function readBearer(req) {
    const h = req.headers['authorization'];
    if (typeof h !== 'string')
        return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1] : null;
}
export const requireAuth = async (req, reply) => {
    const env = loadEnv();
    // dev-bypass: skip JWT entirely, attach the stub user.
    // The env validator already refuses dev-bypass in production (env.ts).
    if (env.AUTH_MODE === 'dev-bypass') {
        req.userId = env.DEV_BYPASS_USER_ID;
        return;
    }
    const token = readBearer(req);
    if (!token)
        return reply.code(401).send({ code: 'no-token', message: 'auth required' });
    const payload = await verifyAccessToken(token);
    if (!payload || !payload.sub) {
        return reply.code(401).send({ code: 'invalid-token', message: 'auth required' });
    }
    req.userId = payload.sub;
};
export const optionalAuth = async (req) => {
    const env = loadEnv();
    if (env.AUTH_MODE === 'dev-bypass') {
        req.userId = env.DEV_BYPASS_USER_ID;
        return;
    }
    const token = readBearer(req);
    if (!token)
        return;
    const payload = await verifyAccessToken(token);
    if (payload?.sub)
        req.userId = payload.sub;
};
