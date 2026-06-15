declare const Buffer: any;

import forge from 'node-forge';

export interface DeviceIdentifierOptions {
  deviceId?: string;
  deviceIdProvider?: () => string | Promise<string>;
  storageKey?: string;
}

export interface AuthClientConfig extends DeviceIdentifierOptions {
  userId?: string | null;
  token?: string | null;
  publicKeyPem?: string | null;
  ipAddress?: string;
  ipAddressProvider?: () => string | Promise<string>;
  fetch?: typeof fetch;
}

export interface AuthRequestInit extends Omit<RequestInit, 'method' | 'headers' | 'body'> {
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | unknown[] | null | undefined;
}

const WEB_DEVICE_ID_CACHE = new Map<string, string>();
const DEVICE_SERIAL_KEY_PROMISES = new WeakMap<AuthHttpClient, Promise<string>>();
const IP_ADDRESS_PROMISES = new WeakMap<AuthHttpClient, Promise<string>>();

interface RequiredAuthMaterial {
  userId: string;
  token: string;
  publicKeyPem: string;
}

function requireAuthMaterial(client: AuthHttpClient): RequiredAuthMaterial {
  if (!client.userId) {
    throw new Error('userId is required. Call setUserId() before sending authenticated requests.');
  }
  if (!client.token) {
    throw new Error('token is required. Call setToken() before sending authenticated requests.');
  }
  if (!client.publicKeyPem) {
    throw new Error('publicKeyPem is required. Call setPublicKeyPem() before sending authenticated requests.');
  }

  return {
    userId: client.userId,
    token: client.token,
    publicKeyPem: client.publicKeyPem,
  };
}

function isReactNativeEnvironment(): boolean {
  // noinspection JSDeprecatedSymbols
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

function isWebEnvironment(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);
}

function isBodyInitValue(value: unknown): value is BodyInit {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return true;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true;
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    return true;
  }
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return true;
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return true;
  }
  if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) {
    return true;
  }
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function toUint8Array(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function binaryStringToUint8Array(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function uint8ArrayToBinaryString(value: Uint8Array): string {
  let output = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const slice = value.subarray(offset, offset + chunkSize);
    output += String.fromCharCode(...slice);
  }
  return output;
}

function base64ToUint8Array(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  return binaryStringToUint8Array(binary);
}

function base64ToText(value: string): string {
  const bytes = base64ToUint8Array(value);
  return new TextDecoder().decode(bytes);
}

async function randomBytes(length: number): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  const existing = globalThis.crypto as Crypto | undefined;
  if (existing && typeof existing.getRandomValues === 'function') {
    existing.getRandomValues(output);
    return output;
  }

  const nodeCryptoModuleName = 'node:crypto';
  const nodeCrypto = await import(nodeCryptoModuleName);
  return nodeCrypto.randomBytes(length);
}

async function secureRandomToken(byteLength: number): Promise<string> {
  return bytesToBase64Url(await randomBytes(byteLength));
}

async function getSubtleCrypto(): Promise<SubtleCrypto> {
  const existing = globalThis.crypto?.subtle;
  if (existing) {
    return existing;
  }

  const nodeCryptoModuleName = 'node:crypto';
  const nodeCrypto = await import(nodeCryptoModuleName);
  return nodeCrypto.webcrypto.subtle;
}

function normalizeRequestBody(body: AuthRequestInit['body']): BodyInit | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }

  if (isBodyInitValue(body)) {
    return body;
  }

  if (isPlainObject(body) || Array.isArray(body)) {
    return JSON.stringify(body);
  }

  return String(body);
}

function joinPathSegments(basePath: string, requestPath: string): string {
  const cleanBase = basePath.replace(/\/+$/g, '');
  const cleanRequest = requestPath.replace(/^\/+/g, '');
  const joined = [cleanBase, cleanRequest].filter(Boolean).join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function resolveRequestUrl(baseURL: string, requestPath: string): URL {
  if (isAbsoluteUrl(requestPath)) {
    return new URL(requestPath);
  }

  const base = new URL(baseURL);
  const parsedPath = new URL(requestPath.startsWith('/') ? requestPath : `/${requestPath}`, 'http://local.invalid');
  base.pathname = joinPathSegments(base.pathname, parsedPath.pathname);
  base.search = parsedPath.search;
  base.hash = parsedPath.hash;
  return base;
}

async function readStoredWebDeviceId(storageKey: string): Promise<string | undefined> {
  const cached = WEB_DEVICE_ID_CACHE.get(storageKey);
  if (cached) {
    return cached;
  }

  if (!isWebEnvironment()) {
    return undefined;
  }

  const indexedDbResult = await new Promise<string | undefined>((resolve) => {
    const indexedDb = globalThis.indexedDB;
    if (!indexedDb) {
      resolve(undefined);
      return;
    }

    const openRequest = indexedDb.open('moovable-device-ids', 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains('deviceIds')) {
        db.createObjectStore('deviceIds');
      }
    };
    openRequest.onerror = () => resolve(undefined);
    openRequest.onsuccess = () => {
      try {
        const db = openRequest.result;
        const transaction = db.transaction('deviceIds', 'readonly');
        const store = transaction.objectStore('deviceIds');
        const getRequest = store.get(storageKey);
        getRequest.onerror = () => {
          db.close();
          resolve(undefined);
        };
        getRequest.onsuccess = () => {
          const value = getRequest.result;
          db.close();
          resolve(typeof value === 'string' ? value : undefined);
        };
      } catch {
        resolve(undefined);
      }
    };
  });

  if (indexedDbResult) {
    WEB_DEVICE_ID_CACHE.set(storageKey, indexedDbResult);
    return indexedDbResult;
  }

  try {
    const localValue = globalThis.localStorage?.getItem(storageKey) ?? undefined;
    if (localValue) {
      WEB_DEVICE_ID_CACHE.set(storageKey, localValue);
      return localValue;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function persistWebDeviceId(storageKey: string, value: string): Promise<void> {
  WEB_DEVICE_ID_CACHE.set(storageKey, value);

  if (!isWebEnvironment()) {
    return;
  }

  const indexedDbResult = await new Promise<boolean>((resolve) => {
    const indexedDb = globalThis.indexedDB;
    if (!indexedDb) {
      resolve(false);
      return;
    }

    const openRequest = indexedDb.open('moovable-device-ids', 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains('deviceIds')) {
        db.createObjectStore('deviceIds');
      }
    };
    openRequest.onerror = () => resolve(false);
    openRequest.onsuccess = () => {
      try {
        const db = openRequest.result;
        const transaction = db.transaction('deviceIds', 'readwrite');
        const store = transaction.objectStore('deviceIds');
        const putRequest = store.put(value, storageKey);
        putRequest.onerror = () => {
          db.close();
          resolve(false);
        };
        putRequest.onsuccess = () => {
          db.close();
          resolve(true);
        };
      } catch {
        resolve(false);
      }
    };
  });

  if (indexedDbResult) {
    return;
  }

  try {
    globalThis.localStorage?.setItem(storageKey, value);
  } catch {
    return;
  }
}

async function resolveReactNativeDeviceId(options: DeviceIdentifierOptions): Promise<string | undefined> {
  if (!isReactNativeEnvironment()) {
    return undefined;
  }

  const globalAny = globalThis as unknown as Record<string, unknown>;
  const injectedDeviceId =
    typeof globalAny.deviceId === 'string'
      ? globalAny.deviceId
      : typeof globalAny.nativeDeviceId === 'string'
        ? globalAny.nativeDeviceId
        : undefined;
  if (injectedDeviceId) {
    return injectedDeviceId;
  }

  try {
    const deviceInfoModuleName= 'react-native-device-info';
    const deviceInfoModule = await import(deviceInfoModuleName);
    const deviceInfo = deviceInfoModule?.default ?? deviceInfoModule;
    if (typeof deviceInfo?.getUniqueId === 'function') {
      return String(await deviceInfo.getUniqueId());
    }
    if (typeof deviceInfo?.getUniqueIdSync === 'function') {
      return String(deviceInfo.getUniqueIdSync());
    }
  } catch {
    // Optional dependency; fall through to caller error handling.
  }

  return options.deviceId;
}

async function resolveWebDeviceId(storageKey: string): Promise<string> {
  const cached = await readStoredWebDeviceId(storageKey);
  if (cached) {
    return cached;
  }

  const generated = `web-${await secureRandomToken(32)}`;
  await persistWebDeviceId(storageKey, generated);
  return generated;
}

async function resolveDeviceIdentifier(options: DeviceIdentifierOptions = {}): Promise<string> {
  if (options.deviceId) {
    return options.deviceId;
  }

  if (options.deviceIdProvider) {
    const provided = await options.deviceIdProvider();
    if (provided) {
      return provided;
    }
  }

  const rnDeviceId = await resolveReactNativeDeviceId(options);
  if (rnDeviceId && rnDeviceId !== 'unknown') {
    return rnDeviceId;
  }

  if (isWebEnvironment()) {
    return resolveWebDeviceId(options.storageKey ?? 'moovable-device-id');
  }

  throw new Error('A device identifier is required. Pass deviceId or deviceIdProvider in the client config.');
}

async function resolveReactNativeIpAddress(): Promise<string | undefined> {
  if (!isReactNativeEnvironment()) {
    return undefined;
  }

  try {
    const deviceInfoModuleName= 'react-native-device-info';
    const deviceInfoModule = await import(deviceInfoModuleName);
    const deviceInfo = deviceInfoModule?.default ?? deviceInfoModule;
    if (typeof deviceInfo?.getIpAddress === 'function') {
      return String(await deviceInfo.getIpAddress());
    }
    if (typeof deviceInfo?.getIpAddressSync === 'function') {
      return String(deviceInfo.getIpAddressSync());
    }
  } catch {
    // Optional dependency; fall through to caller error handling.
  }

  return undefined;
}

async function resolveIpAddress(config: AuthClientConfig, cached: string | undefined): Promise<string> {
  if (cached) {
    return cached;
  }

  if (config.ipAddress) {
    return config.ipAddress;
  }

  if (config.ipAddressProvider) {
    const provided = await config.ipAddressProvider();
    if (provided) {
      return provided;
    }
  }

  const rIpAddress = await resolveReactNativeIpAddress();
  if(rIpAddress && rIpAddress !== 'unknown') {
    return rIpAddress;
  }

  throw new Error('An IP address is required. Pass ipAddress or ipAddressProvider in the client config.');
}

async function importRsaPublicKey(publicKeyPem: string): Promise<any> {
  const trimmed = publicKeyPem.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY') || trimmed.includes('BEGIN RSA PUBLIC KEY')) {
    return forge.pki.publicKeyFromPem(trimmed);
  }

  const decodedText = base64ToText(trimmed);
  if (decodedText.includes('BEGIN PUBLIC KEY') || decodedText.includes('BEGIN RSA PUBLIC KEY')) {
    return forge.pki.publicKeyFromPem(decodedText);
  }

  const derBytes = base64ToUint8Array(trimmed);
  const asn1 = forge.asn1.fromDer(uint8ArrayToBinaryString(derBytes));
  return forge.pki.publicKeyFromAsn1(asn1);
}

async function encryptPassphraseWithRsa(publicKeyPem: string, passphrase: string): Promise<string> {
  const publicKey = await importRsaPublicKey(publicKeyPem);
  const encrypted = publicKey.encrypt(passphrase, 'RSAES-PKCS1-V1_5');
  return forge.util.encode64(encrypted);
}

async function importRawAesKey(rawKeyBytes: Uint8Array): Promise<CryptoKey> {
  const subtle = await getSubtleCrypto();
  return subtle.importKey('raw', rawKeyBytes as unknown as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptEnvelopeWithAes(
  aesKey: CryptoKey,
  iv: Uint8Array,
  envelope: string,
): Promise<string> {
  const subtle = await getSubtleCrypto();
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
    aesKey,
    toUint8Array(envelope) as unknown as BufferSource,
  );
  return bytesToBase64(new Uint8Array(ciphertext));
}

async function buildRequestSignature(
  auth: RequiredAuthMaterial,
  requestMethod: string,
  requestUrl: string,
  deviceSerialKey: string,
  ipAddress: string,
): Promise<string> {
  const rawKeyBytes = await randomBytes(32);
  const passphrase = bytesToBase64Url(rawKeyBytes);
  const encryptedPassphrase = await encryptPassphraseWithRsa(auth.publicKeyPem, passphrase);
  const aesKey = await importRawAesKey(rawKeyBytes);
  const iv = await randomBytes(12);
  const envelope = JSON.stringify({
    userId: auth.userId,
    timestamp: Date.now(),
    nonce: await secureRandomToken(16),
    deviceSerialKey,
    ipAddress,
    requestMethod,
    requestUrl,
  });
  const envelopeCipher = await encryptEnvelopeWithAes(aesKey, iv, envelope);
  return `${encryptedPassphrase},,${bytesToBase64(iv)},,${envelopeCipher}`;
}

async function buildRequestInit(
  client: AuthHttpClient,
  method: string,
  path: string,
  init?: AuthRequestInit,
): Promise<{ url: URL; requestInit: RequestInit }> {
  const resolvedUrl = resolveRequestUrl(client.baseURL, path);
  const originalBody = init?.body;
  const { body: _ignoredBody, ...requestInitBase } = init ?? {};
  const body = normalizeRequestBody(originalBody);
  const headers = new Headers(init?.headers ?? undefined);

  //? Set the headers.
  if (body !== undefined && !headers.has('content-type') && (isPlainObject(originalBody) || Array.isArray(originalBody))) {
    headers.set('content-type', 'application/json');
  }

  //? If this client has any of the auth materials set, we need to sign the request.
  if(client.userId || client.token || client.publicKeyPem) {
    const auth = requireAuthMaterial(client);
    headers.set('X-User-ID', auth.userId);
    headers.set('Authorization', `Bearer ${auth.token}`);
    const deviceSerialKey = await getDeviceSerialKey(client);
    const ipAddress = await getIpAddress(client);
    const requestSignature = await buildRequestSignature(
        auth,
        method,
        `${resolvedUrl.pathname}${resolvedUrl.search}`,
        deviceSerialKey,
        ipAddress,
    );
    headers.set('X-Request-Signature', requestSignature);
  }

  const requestInit: RequestInit = {
    ...requestInitBase,
    method,
    headers,
  };

  if (body !== undefined) {
    requestInit.body = body as BodyInit;
  }

  return { url: resolvedUrl, requestInit };
}

// noinspection JSUnusedGlobalSymbols
export class AuthHttpClient {
  public readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private _userId: string | null;
  private _token: string | null;
  private _publicKeyPem: string | null;
  private readonly _ipAddress: string | undefined;
  private readonly _ipAddressProvider: (() => string | Promise<string>) | undefined;
  private readonly _deviceId: string | undefined;
  private readonly _deviceIdProvider: (() => string | Promise<string>) | undefined;
  private readonly _storageKey: string | undefined;

  /**
   * Creates a new HTTP client bound to a base URL.
   *
   * Auth material may be supplied later via the dedicated setter methods.
   */
  public constructor(baseURL: string, config?: AuthClientConfig) {
    this.baseURL = new URL(baseURL).toString();
    this.fetchImpl = config?.fetch ?? globalThis.fetch.bind(globalThis);
    this._userId = config?.userId ?? null;
    this._token = config?.token ?? null;
    this._publicKeyPem = config?.publicKeyPem ?? null;
    this._ipAddress = config?.ipAddress;
    this._ipAddressProvider = config?.ipAddressProvider;
    this._deviceId = config?.deviceId;
    this._deviceIdProvider = config?.deviceIdProvider;
    this._storageKey = config?.storageKey;
  }

  /** Returns the current user ID, or null when the client is not authenticated. */
  public get userId(): string | null {
    return this._userId;
  }

  /** Returns the current bearer token, or null when the client is not authenticated. */
  public get token(): string | null {
    return this._token;
  }

  /** Returns the current RSA public key PEM, or null when the client is not authenticated. */
  public get publicKeyPem(): string | null {
    return this._publicKeyPem;
  }

  /** Sets or clears the user ID used by authenticated requests. */
  public setUserId(userId: string | null): this {
    this._userId = userId;
    return this;
  }

  /** Sets or clears the bearer token used by authenticated requests. */
  public setToken(token: string | null): this {
    this._token = token;
    return this;
  }

  /** Sets or clears the RSA public key used to sign request envelopes. */
  public setPublicKeyPem(publicKeyPem: string | null): this {
    this._publicKeyPem = publicKeyPem;
    return this;
  }

  /** Returns the configured IP address, if one was provided. */
  public get ipAddress(): string | undefined {
    return this._ipAddress;
  }

  /** Returns the configured device ID, if one was provided. */
  public get deviceId(): string | undefined {
    return this._deviceId;
  }

  /** Returns the configured device ID provider if one was provided. */
  public get deviceIdProvider(): (() => string | Promise<string>) | undefined {
    return this._deviceIdProvider;
  }

  /** Returns the configured storage key used by the web device-ID cache, if any. */
  public get storageKey(): string | undefined {
    return this._storageKey;
  }

  /** Returns the configured IP address provider if one was provided. */
  public get ipAddressProvider(): (() => string | Promise<string>) | undefined {
    return this._ipAddressProvider;
  }

  /**
   * Sends a GET request.
   */
  public get(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('GET', path, init);
  }

  /**
   * Sends a POST request.
   */
  public post(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('POST', path, init);
  }

  /**
   * Sends a PUT request.
   */
  public put(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('PUT', path, init);
  }

  /**
   * Sends a PATCH request.
   */
  public patch(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('PATCH', path, init);
  }

  /**
   * Sends a DELETE request.
   */
  public delete(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('DELETE', path, init);
  }

  /**
   * Sends an OPTIONS request.
   */
  public options(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('OPTIONS', path, init);
  }

  /**
   * Sends a HEAD request.
   */
  public head(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('HEAD', path, init);
  }

  /**
   * Sends a TRACE request.
   */
  public trace(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('TRACE', path, init);
  }

  /**
   * Sends a CONNECT request.
   */
  public connect(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('CONNECT', path, init);
  }

  /**
   * Sends a COPY request.
   */
  public copy(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('COPY', path, init);
  }

  /**
   * Sends a MOVE request.
   */
  public move(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('MOVE', path, init);
  }

  /**
   * Sends a LOCK request.
   */
  public lock(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('LOCK', path, init);
  }

  /**
   * Sends an UNLOCK request.
   */
  public unlock(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('UNLOCK', path, init);
  }

  /**
   * Sends a PROPFIND request.
   */
  public propfind(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('PROPFIND', path, init);
  }

  /**
   * Sends an MKCOL request.
   */
  public mkcol(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('MKCOL', path, init);
  }

  /**
   * Sends a SEARCH request.
   */
  public search(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('SEARCH', path, init);
  }

  /**
   * Sends a REPORT request.
   */
  public report(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('REPORT', path, init);
  }

  /**
   * Sends a CHECKIN request.
   */
  public checkin(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('CHECKIN', path, init);
  }

  /**
   * Sends a CHECKOUT request.
   */
  public checkout(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('CHECKOUT', path, init);
  }

  /**
   * Sends an UNCHECKOUT request.
   */
  public uncheckout(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('UNCHECKOUT', path, init);
  }

  /**
   * Sends a MERGE request.
   */
  public merge(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('MERGE', path, init);
  }

  /**
   * Sends an ACL request.
   */
  public acl(path: string, init?: AuthRequestInit): Promise<Response> {
    return this.custom('ACL', path, init);
  }

  /**
   * Sends a request using any HTTP method string supported by the backend.
   */
  public custom(method: string, path: string, init?: AuthRequestInit): Promise<Response> {
    return (async () => {
      const { url, requestInit } = await buildRequestInit(this, method.toUpperCase(), path, init);
      return this.fetchImpl(url.toString(), requestInit);
    })();
  }
}

async function getDeviceSerialKey(client: AuthHttpClient): Promise<string> {
  let cached = DEVICE_SERIAL_KEY_PROMISES.get(client);
  if (!cached) {
    cached = resolveDeviceIdentifier({
      deviceId: client.deviceId,
      deviceIdProvider: client.deviceIdProvider,
      storageKey: client.storageKey,
    });
    DEVICE_SERIAL_KEY_PROMISES.set(client, cached);
  }
  return cached;
}

async function getIpAddress(client: AuthHttpClient): Promise<string> {
  let cached = IP_ADDRESS_PROMISES.get(client);
  if (!cached) {
    cached = resolveIpAddress(
      {
        ipAddress: client.ipAddress,
        ipAddressProvider: client.ipAddressProvider,
      },
      client.ipAddress,
    );
    IP_ADDRESS_PROMISES.set(client, cached);
  }
  return cached;
}

function readEnv(name: string): string | undefined {
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[name];
}

/**
 * Runs a small profile request example against `https://localhost:3001/auth/profile`.
 * The script expects the auth values to be supplied via environment variables.
 */
// noinspection JSUnusedGlobalSymbols
export async function runProfileCheck(): Promise<Response> {
  const client = new AuthHttpClient('https://localhost:3001', {
    ipAddress: readEnv('AUTH_IP_ADDRESS'),
    deviceId: readEnv('AUTH_DEVICE_ID'),
    storageKey: readEnv('AUTH_DEVICE_STORAGE_KEY'),
  });

  client
    .setUserId(readEnv('AUTH_USER_ID') ?? null)
    .setToken(readEnv('AUTH_BEARER_TOKEN') ?? null)
    .setPublicKeyPem(readEnv('AUTH_PUBLIC_KEY_PEM') ?? null);

  return client.get('/auth/profile');
}
