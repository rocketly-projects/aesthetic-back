import { SignJWT, jwtVerify } from 'jose'

export type JwtPayload = {
  businessId: string
  userId: string
  email: string
  role: 'owner' | 'staff'
}

type Env = {
  JWT_SECRET: string
}

export function getSecret(env: Env): Uint8Array {
  const secret = env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters')
  }
  return new TextEncoder().encode(secret)
}

export async function signJwt(payload: JwtPayload, env: Env): Promise<string> {
  const secret = getSecret(env)
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifyJwt(token: string, env: Env): Promise<JwtPayload> {
  const secret = getSecret(env)
  const { payload } = await jwtVerify(token, secret)

  const businessId = payload['businessId']
  const userId = payload['userId']
  const email = payload['email']
  const role = payload['role']

  if (
    typeof businessId !== 'string' ||
    typeof userId !== 'string' ||
    typeof email !== 'string' ||
    (role !== 'owner' && role !== 'staff')
  ) {
    throw new Error('Invalid token payload shape')
  }

  return { businessId, userId, email, role }
}
