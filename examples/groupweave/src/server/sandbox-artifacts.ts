/** One fixed producer export. Never accept a sandbox path or attachment name from prompt text. */
export const SANDBOX_RESULT_NAME = 'result.md';
export const SANDBOX_RESULT_MEDIA_TYPE = 'text/markdown';
export const SANDBOX_RESULT_MAX_BYTES = 64_000;

export function sandboxResultArtifact(value: unknown, output: string): { name: string; mediaType: string; data: Uint8Array } {
  const artifact = value as { name?: unknown; mediaType?: unknown; data?: unknown } | undefined;
  if (!artifact || artifact.name !== SANDBOX_RESULT_NAME || artifact.mediaType !== SANDBOX_RESULT_MEDIA_TYPE
    || !(artifact.data instanceof Uint8Array) || artifact.data.byteLength < 1
    || artifact.data.byteLength > SANDBOX_RESULT_MAX_BYTES
    || !Buffer.from(artifact.data).equals(Buffer.from(output, 'utf8'))) {
    throw new Error('SANDBOX_ARTIFACT_INVALID');
  }
  return { name: SANDBOX_RESULT_NAME, mediaType: SANDBOX_RESULT_MEDIA_TYPE, data: Uint8Array.from(artifact.data) };
}
