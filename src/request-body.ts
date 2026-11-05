// Apply the budget while reading, before decoding text or parsing multipart data.
export async function readRequestBytes(request: Request, limit: number, tooLarge: () => Error): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length") || "0") > limit) {
    void request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readRequestForm(request: Request, limit: number, tooLarge: () => Error): Promise<FormData> {
  const bytes = await readRequestBytes(request, limit, tooLarge);
  return new Response(bytes, { headers: { "content-type": request.headers.get("content-type") || "" } }).formData();
}
