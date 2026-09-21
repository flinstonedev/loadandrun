import {createRemoteJWKSet, jwtVerify} from 'jose';

type AccessConfig = Pick<Env, 'ENVIRONMENT' | 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>;
// Cache public signing keys, never user tokens or request identities.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function enforceDeploymentGate(request: Request, env: AccessConfig): Promise<{expiresAt: number}> {
  const url = new URL(request.url);
  // Local development bypasses only the deployment gate, never app login.
  if (env.ENVIRONMENT === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return {expiresAt: Date.now() + 12 * 3600_000};
  }
  if (!env.ACCESS_AUD || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) {
    throw Object.assign(new Error('Access login is not configured.'), {status: 503});
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw Object.assign(new Error('Sign in through Cloudflare Access.'), {status: 401});
  const issuer = 'https://' + env.ACCESS_TEAM_DOMAIN;
  try {
    let keys = keySets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'));
      keySets.set(issuer, keys);
    }
    const {payload} = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat'],
    });
    return {expiresAt: payload.exp! * 1000};
  } catch {
    throw Object.assign(new Error('Your login expired or is invalid. Sign in again.'), {status: 401});
  }
}
