const OSS = require('ali-oss');

let client = null;

function encodeOssKeyForUrl(key) {
  return String(key)
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

function getClient() {
  if (client) return client;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET;
  const endpoint = process.env.OSS_ENDPOINT;
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    throw new Error('OSS config missing: set OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_ENDPOINT in .env');
  }
  client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint
  });
  return client;
}

async function uploadBuffer({ buffer, filename, contentType, prefix } = {}) {
  const c = getClient();
  const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const baseKey = `${Date.now()}-${Math.random().toString(36).slice(2,9)}-${safeName}`;
  // normalize prefix (remove leading/trailing slashes)
  let key = baseKey;
  if (prefix) {
    const clean = String(prefix).replace(/^\/+|\/+$/g, '');
    if (clean.length > 0) key = `${clean}/${baseKey}`;
  }
  await c.put(key, buffer, { headers: { 'Content-Type': contentType || 'application/octet-stream' } });
  const signed = (process.env.OSS_SIGNED || 'false').toString() === 'true';
  if (signed) {
    const url = await c.signatureUrl(key, { expires: parseInt(process.env.OSS_SIGNED_EXPIRES || '3600', 10) });
    return { url, key };
  }
  const publicUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  return { url: publicUrl, key };
}

async function putBuffer({ buffer, key, contentType } = {}) {
  if (!key) throw new Error('putBuffer requires key');
  const c = getClient();
  await c.put(key, buffer, { headers: { 'Content-Type': contentType || 'application/octet-stream' } });
  const signed = (process.env.OSS_SIGNED || 'false').toString() === 'true';
  if (signed) {
    const url = await c.signatureUrl(key, { expires: parseInt(process.env.OSS_SIGNED_EXPIRES || '3600', 10) });
    return { url, key };
  }
  const publicUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  return { url: publicUrl, key };
}

module.exports = { uploadBuffer, putBuffer, getClient, encodeOssKeyForUrl };
