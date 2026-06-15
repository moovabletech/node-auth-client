import { AuthHttpClient } from './index.js';

function readEnv(name: string): string | undefined {
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[name];
}

async function main(): Promise<void> {
  const userId = readEnv('AUTH_USER_ID');
  const token = readEnv('AUTH_BEARER_TOKEN');
  const publicKeyPem = readEnv('AUTH_PUBLIC_KEY_PEM');

  if (!userId || !token || !publicKeyPem) {
    throw new Error('Set AUTH_USER_ID, AUTH_BEARER_TOKEN, and AUTH_PUBLIC_KEY_PEM before running the profile check script.');
  }

  const client = new AuthHttpClient('http://localhost:3001', {
    ipAddress: readEnv('AUTH_IP_ADDRESS'),
    deviceId: readEnv('AUTH_DEVICE_ID'),
    storageKey: readEnv('AUTH_DEVICE_STORAGE_KEY'),
  });

  client.setUserId(userId).setToken(token).setPublicKeyPem(publicKeyPem);

  const response = await client.get('/auth/profile');
  const responseText = await response.json();

  console.dir(
    { status: response.status, ok: response.ok, body: responseText },
    { depth: null, maxArrayLength: null }
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  const processLike = (globalThis as unknown as { process?: { exitCode?: number } }).process;
  if (processLike) {
    processLike.exitCode = 1;
  }
});
