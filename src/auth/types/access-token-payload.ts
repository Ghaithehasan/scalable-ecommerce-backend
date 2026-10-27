export interface AccessTokenPayload {
  sub: string;
  tokenUse: 'access';
  iat?: number;
  exp?: number;
}
