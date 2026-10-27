import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => {
  const secret = process.env.JWT_SECRET;
  const accessTokenTtlSeconds = Number(
    process.env.JWT_ACCESS_TTL_SECONDS ?? 900,
  );
  const issuer = process.env.JWT_ISSUER?.trim() || 'ecommerce-api';
  const audience = process.env.JWT_AUDIENCE?.trim() || 'ecommerce-client';

  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes of random data');
  }

  if (
    !Number.isInteger(accessTokenTtlSeconds) ||
    accessTokenTtlSeconds < 60 ||
    accessTokenTtlSeconds > 3600
  ) {
    throw new Error('JWT_ACCESS_TTL_SECONDS must be between 60 and 3600');
  }

  return { secret, accessTokenTtlSeconds, issuer, audience };
});
