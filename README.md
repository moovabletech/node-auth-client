# @moovable/node-auth-client

Isomorphic HTTP client for Moovable clients.

## Install

```bash
npm install @moovable/node-auth-client
```

## Import

This package is ESM-only.

```ts
import { AuthHttpClient } from '@moovable/node-auth-client';
```

## Create a client

```ts
const client = new AuthHttpClient('https://localhost:3001');
```

Auth values may be `null` at construction time. Set them later with setters:

```ts
client
  .setUserId('11111111-1111-1111-1111-111111111111')
  .setToken('your-bearer-token')
  .setPublicKeyPem('base64-encoded-public-key');
```

`setPublicKeyPem()` accepts either a PEM string or the base64-encoded public key material used by the frontend.

## Authenticated requests

Once auth material is set, every request includes:

- `X-User-ID`
- `Authorization: Bearer <token>`
- `X-Request-Signature`

The signature contains:

1. RSA-encrypted passphrase
2. IV
3. AES-GCM encrypted request envelope

## Request methods

The client exposes:

`get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `trace`, `connect`, `copy`, `move`, `lock`, `unlock`, `propfind`, `mkcol`, `search`, `report`, `checkin`, `checkout`, `uncheckout`, `merge`, `acl`, and `custom`.

Example:

```ts
const response = await client.get('/auth/profile');
```

## Request options

All methods accept a second optional options object:

```ts
await client.post('/auth/login', {
  headers: { 'x-extra': 'value' },
  body: { email: 'user@example.com', password: 'secret' },
});
```

Plain objects and arrays are JSON-stringified automatically.

## Device identification

The client resolves a device identifier depending on the runtime:

- **React Native**: uses the configured `deviceId`, `deviceIdProvider`, or a device-info integration.
- **Web**: generates a secure `web-...` ID, caches it in memory, and persists it in IndexedDB with a localStorage fallback.
- **Node.js**: use `deviceId` or `deviceIdProvider`.

## IP address

Provide the IP in one of these ways:

```ts
const client = new AuthHttpClient('https://localhost:3001', {
  ipAddress: '127.0.0.1',
});
```

or:

```ts
const client = new AuthHttpClient('https://localhost:3001', {
  ipAddressProvider: async () => '127.0.0.1',
});
```

## React Native setup

For React Native developers, install these packages:

```bash
npm install react-native-device-info react-native-network-info
```

`react-native-device-info` makes unique device identification much easier.

`react-native-network-info` can be plugged in as the IP provider using `NetworkInfo.getIPV4Address()` for the most accurate results:

```ts
import { NetworkInfo } from 'react-native-network-info';
import DeviceInfo from 'react-native-device-info';
import { AuthHttpClient } from '@moovable/node-auth-client';

const client = new AuthHttpClient('https://localhost:3001', {
  ipAddressProvider: () => NetworkInfo.getIPV4Address(),
});
```

## Example script

Run the included profile check script with:

```bash
npm run example:profile
```

It expects:

- `AUTH_USER_ID`
- `AUTH_BEARER_TOKEN`
- `AUTH_PUBLIC_KEY_PEM`

Optional values:

- `AUTH_IP_ADDRESS`
- `AUTH_DEVICE_ID`
- `AUTH_DEVICE_STORAGE_KEY`

## Exported helper

`runProfileCheck()` is exported for the package’s profile-check example and performs:

```ts
await client.get('/auth/profile');
```

## Notes

- The package is designed to work across React Native, web, Node.js, Next.js, and SvelteKit.
- Requests are signed only after `userId`, `token`, and `publicKeyPem` are set.
- The client keeps the auth state inside the instance so it can be updated safely at runtime.
