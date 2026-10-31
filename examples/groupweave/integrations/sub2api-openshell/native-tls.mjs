// OpenShell 0.1.3 native CLI files. These credentials stay in the host task XDG;
// the bridge uploads only its policy/patch/Skill and fixed result paths.
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fail = () => new Error('GROUPWEAVE_SUB2API_GATEWAY_TLS_FILE_UNTRUSTED');
async function readTrustedFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 64 * 1024
      || (metadata.mode & 0o077) !== 0 || ![0, process.getuid()].includes(metadata.uid)) throw fail();
    return await handle.readFile();
  } catch { throw fail(); }
  finally { await handle?.close(); }
}

export async function prepareNativeGateway(config, xdgConfigHome) {
  if (!config.gatewayTls) return;
  const bundle = await Promise.all([
    readTrustedFile(config.gatewayTls.caPath), readTrustedFile(config.gatewayTls.certPath), readTrustedFile(config.gatewayTls.keyPath),
  ]);
  const root = path.join(xdgConfigHome, 'openshell');
  const base = path.join(root, 'gateways', 'groupweave');
  for (const dir of [root, path.join(root, 'gateways'), base, path.join(base, 'mtls')]) await mkdir(dir, { mode: 0o700 });
  const options = { mode: 0o600, flag: 'wx' };
  for (const [i, name] of ['ca.crt', 'tls.crt', 'tls.key'].entries()) await writeFile(path.join(base, 'mtls', name), bundle[i], options);
  const endpoint = new URL(config.gatewayEndpoint);
  await writeFile(path.join(base, 'metadata.json'), JSON.stringify({ name: 'groupweave',
    gateway_endpoint: config.gatewayEndpoint, is_remote: false, gateway_port: Number(endpoint.port || 443), auth_mode: 'mtls' }), options);
  await writeFile(path.join(root, 'active_gateway'), 'groupweave', options);
}
