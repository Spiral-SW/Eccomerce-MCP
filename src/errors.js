export class OllyxError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
export function publicError(error) {
  if (error instanceof OllyxError) return { code: error.code, message: error.message, ...error.extra };
  return { code: 'internal_error', message: 'Falha interna. Verifique a configuração local da integração.' };
}
